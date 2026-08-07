#!/usr/bin/env node
/**
 * Pre-push gate runner — the read-only gates start concurrently; each prints
 * its pass/fail status as it finishes, with full output shown inline when a
 * gate fails.  Wall-clock ≈ max(slowest read-only gate).
 *
 * The patch-mutation gate runs AFTER that batch, never alongside it: Stryker
 * mutates files in-place in the working tree, so running it concurrently with
 * the gates that READ those files (lint, unit, typecheck) let a transiently-
 * injected mutant make them intermittently false-fail — a flaky red push with
 * no real defect.  See the fan-out at the bottom.
 *
 * Path-scoped gates (docs, openapi, skill) are skipped automatically when
 * their source hasn't changed vs origin/main — false-skip is safe because CI
 * always runs the full suite.
 *
 * Knobs:
 *   PREPUSH_BASE=<ref>       base ref the push is graded against (default
 *   origin/main): both the path-scope predicates and the turbo package
 *   filter diff against it. Override on forks or when measuring the gate
 *   against a different base.
 *   PREPUSH_CONCURRENCY=<n|p%>  turbo concurrency for the typecheck/lint/unit
 *   gate (default 25% of cores — keeps the machine responsive during a push).
 *   PREPUSH_RUN_MUTATION=1   also run the patch-mutation gate locally.
 *   By default it is DEFERRED TO CI: the required Patch Mutation check
 *   enforces the same gate on every PR, and a local run costs 5–10+ minutes
 *   per push — long enough that GitHub closes the idle SSH connection opened
 *   before the hook, so a fully-green run could still fail to transfer.
 *
 * Remote caching (optional, big win on typecheck/lint/unit): the turbo tasks
 * these gates run hit the shared remote cache when TURBO_TOKEN/TURBO_TEAM are in
 * the environment (turbo reads them automatically; nothing here suppresses it).
 * Without a credential the gates still run, just from the local cache only. To
 * activate: `npx turbo login && npx turbo link` (or export TURBO_TOKEN/TURBO_TEAM).
 */

import { spawn, spawnSync }                                       from 'node:child_process';
import { createHash }                                             from 'node:crypto';
import { existsSync, readFileSync, writeFileSync }                from 'node:fs';
import { homedir }                                                from 'node:os';
import { join }                                                   from 'node:path';
import { pushedChangedPaths, pathScopeFlags }                     from './pre-push-scope.mjs';

const T0 = Date.now();

// ── Terminal colours (stripped when stdout is not a TTY) ──────────────────────
const isTTY = process.stdout.isTTY;
const pass   = s => isTTY ? `\x1b[32m${s}\x1b[0m`      : s;   // green
const fail   = s => isTTY ? `\x1b[1m\x1b[31m${s}\x1b[0m` : s; // bold red
const muted  = s => isTTY ? `\x1b[2m${s}\x1b[0m`       : s;   // dim
const warn   = s => isTTY ? `\x1b[33m${s}\x1b[0m`      : s;   // yellow

// ── Core async gate runner ────────────────────────────────────────────────────
// Spawns `command args` and buffers all output. On exit 0: prints a single
// pass line.  On non-zero: prints a fail line then the full buffered output
// immediately so you see the error without waiting for other gates to finish.
//
// Returns a Promise — callers fan these out with Promise.allSettled().
function gate(label, command, args, { env = {} } = {}) {
  const t0 = Date.now();
  process.stdout.write(muted(`▶ ${label}…\n`));

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });

    const buf = [];
    proc.stdout.on('data', d => buf.push({ fd: 1, d }));
    proc.stderr.on('data', d => buf.push({ fd: 2, d }));

    proc.on('close', code => {
      const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      if ((code ?? 1) === 0) {
        process.stdout.write(pass(`✓ ${label}`) + muted(` (${elapsed})\n`));
        // Forward any stderr from a passing gate (warnings, notices)
        buf.filter(x => x.fd === 2).forEach(x => process.stderr.write(x.d));
        resolve();
      } else {
        process.stdout.write(fail(`✗ ${label}`) + muted(` (${elapsed})\n`));
        buf.forEach(x => (x.fd === 1 ? process.stdout : process.stderr).write(x.d));
        reject(new Error(`${label} failed`));
      }
    });

    proc.on('error', err => reject(new Error(`${label}: spawn error — ${err.message}`)));
  });
}

// Resolves immediately with a dim log line.
// Used when a path-scoped gate has no relevant changes on this branch.
function skip(label, reason = 'no relevant changes') {
  process.stdout.write(muted(`– ${label} (skipped: ${reason})\n`));
  return Promise.resolve();
}

// ── Fetch origin/main once, upfront ──────────────────────────────────────────
// Used for both path detection (below) and the drift check gate.
// Failure is silent — the stale fetch just means path-scoped skipping may
// over-include; correctness gates (typecheck, lint, tests) are never skipped.
spawnSync('git', ['fetch', '--quiet', 'origin', 'main'], {
  cwd: process.cwd(), stdio: 'ignore',
});

// The path-scoped gates below run only when the PUSH's own changes touch their
// inputs. Both the diff-direction and the per-gate predicates live in
// pre-push-scope.mjs so they're unit tested. These six repo-wide gates scan the
// whole repo (shrink-only baselines — a partial file list would misread
// unscanned files as "fixed" and fail), so they are run-whole-or-skip. False-skip
// is safe: CI re-runs these checks in its static-checks job, which is itself
// gated on app-code/infra path filters — a superset of anything that can
// regress these gates — so a wrong local skip is caught server-side (same
// contract as the openapi/docs gates).
const BASE = process.env.PREPUSH_BASE || 'origin/main';
const changedPaths = pushedChangedPaths({ base: BASE });
const {
  docsChanged,
  openapiChanged,
  codeOrConfigChanged,
  weakTestAssertionsChanged,
  supabaseMocksChanged,
  dataAccessChanged,
  crossAppChanged,
  publishSafetyChanged,
  scriptsChanged,
  apiTenancyChanged,
} = pathScopeFlags(changedPaths);

// ── Gate: security audit (cached on yarn.lock hash) ───────────────────────────
// Mirrors the CI `security-audit` job.  Caching is safe: audit output is
// deterministic given a lockfile — if yarn.lock hasn't changed, neither has
// the audit verdict.  Cache lives in .git/ so it's never committed.
async function auditGate() {
  // In a linked worktree `.git` is a pointer FILE, not a directory — writing
  // `<cwd>/.git/pre-push-audit-cache` throws ENOTDIR after the gate already
  // printed ✓, failing the push with no visible error. Resolve the real
  // (per-worktree) git dir instead.
  const gitDir = spawnSync(
    'git', ['rev-parse', '--absolute-git-dir'],
    { cwd: process.cwd(), encoding: 'utf8' },
  ).stdout?.trim() || join(process.cwd(), '.git');
  const cacheFile = join(gitDir, 'pre-push-audit-cache');
  const hash = createHash('sha256')
    .update(readFileSync(join(process.cwd(), 'yarn.lock')))
    .digest('hex');

  if (existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').trim() === hash) {
    process.stdout.write(muted('– security audit (skipped: yarn.lock unchanged)\n'));
    return;
  }
  await gate('security audit', 'yarn', ['npm', 'audit', '--severity', 'high', '--recursive']);
  writeFileSync(cacheFile, hash);
}

// ── Gate: OpenAPI pipeline (serial internally) ────────────────────────────────
// ci:openapi regenerates docs/openapi.yaml; spectral then lints that file.
// Both steps need to run in order — hence a sequential chain inside one async
// fn rather than two independent concurrent gates.  Skipped entirely when no
// gateway source, committed spec (docs/), or spectral ruleset changed.
const GENERATED_OPENAPI_FILES = ['docs/openapi.yaml'];

async function openapiPipeline() {
  if (!openapiChanged && !docsChanged) return skip('openapi pipeline');

  await gate('openapi:generate', 'yarn', ['ci:openapi']);

  // Verify the regenerated file matches the committed working tree.
  // `ci:openapi` regenerates in place but does not assert the result is
  // already committed — without this post-check, pre-push silently rewrites
  // drifted generated files.  Mirrors CI's `git diff --exit-code` gate.
  const diff = spawnSync(
    'git', ['diff', '--exit-code', '--', ...GENERATED_OPENAPI_FILES],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  if ((diff.status ?? 1) !== 0) {
    process.stdout.write(fail('✗ openapi:drift-check\n'));
    if (diff.stdout?.length) process.stdout.write(diff.stdout);
    throw new Error(
      'OpenAPI drift: regenerated files differ from committed working tree.\n' +
      `  Fix: git add ${GENERATED_OPENAPI_FILES.join(' ')} && git commit`,
    );
  }
  process.stdout.write(pass('✓ openapi:drift-check\n'));

  // Spectral OpenAPI lint — mirrors .github/workflows/openapi-lint.yml.
  // `npx --yes` matches CI exactly so local drift cannot hide a CI failure
  // (e.g. the `Cannot read properties of null reading 'enum'` crash from
  // nimma traversing typeless `nullable: true` schemas — the workflow only
  // fires on non-draft PRs touching openapi paths, so it can miss it).
  await gate('openapi:spectral', 'npx', [
    '--yes', '@stoplight/spectral-cli@6.15.0',
    'lint', 'docs/openapi.yaml',
    '--ruleset', '.spectral.yaml',
    '--fail-severity=error',
  ]);
}

// ── Gate: patch-mutation ──────────────────────────────────────────────────────
// Mirrors the blocking CI check (scripts/ci/patch-mutation.mjs).
// Self-skips in seconds when nothing in a mutate scope changed; expect
// ~5–8 min when real production code is in scope (Stryker dry run + mutants).
// That cost is deliberate: a red Patch Mutation check after push wastes a CI
// round-trip and a reviewer's time.
//
// Note: Stryker runs in-place against the working tree.  Uncommitted edits to
// mutate-scoped files are backed up/restored, but the verdict reflects the
// working tree — commit or stash for a faithful gate.
async function mutationGate() {
  if (process.env.PREPUSH_RUN_MUTATION !== '1') {
    process.stdout.write(
      muted('– patch-mutation (deferred to the required CI check; PREPUSH_RUN_MUTATION=1 runs it locally)\n'),
    );
    return;
  }
  await gate('patch-mutation', 'node', ['scripts/ci/patch-mutation.mjs']);
}

// ── Remote-cache hint (non-blocking) ──────────────────────────────────────────
// The turbo-backed gates (typecheck, lint, unit) reuse the shared remote cache
// when a credential is present. Point contributors at activation exactly once
// per run when none is detected; never warn loudly or fail — a cold local cache
// is a valid, correct state.
function remoteCacheHint() {
  // Remote cache needs a token AND a team. turbo 2.x sources each from two
  // places: `turbo login` writes the token to the user config dir (macOS:
  // ~/Library/Application Support/turborepo/config.json; XDG: ~/.config/
  // turborepo/config.json), `turbo link` writes the team to the repo-local
  // .turbo/config.json, and both also read TURBO_TOKEN / TURBO_TEAM from the
  // env. Presence means the credentials EXIST, not that the remote cache is
  // reachable or warm — this only nudges when a piece is missing.
  const home = homedir();
  const tokenConfig =
    existsSync(join(home, 'Library', 'Application Support', 'turborepo', 'config.json')) ||
    existsSync(join(home, '.config', 'turborepo', 'config.json'));
  const teamConfig = existsSync(join(process.cwd(), '.turbo', 'config.json'));
  const hasToken = !!process.env.TURBO_TOKEN || tokenConfig;
  const hasTeam = !!process.env.TURBO_TEAM || teamConfig;
  if (!(hasToken && hasTeam)) {
    process.stdout.write(
      muted(
        'ℹ no turbo remote-cache credentials detected — typecheck/lint/unit run from local cache only. ' +
          'Add them with `npx turbo login && npx turbo link` (or export TURBO_TOKEN and TURBO_TEAM).\n',
      ),
    );
  }
}

// ── Fan-out: start the read-only gates concurrently ───────────────────────────
remoteCacheHint();
console.log('pre-push: starting gates in parallel\n');

const results = await Promise.allSettled([
  // Always-on quality gates
  auditGate(),
  // typecheck + lint + unit share ONE turbo scheduler: a single invocation
  // makes --concurrency=50% a real machine-wide cap (separate invocations
  // each claim 50% of the cores and oversubscribe the host), and
  // `--filter=...[BASE]` scopes the run to the packages this push touched
  // plus their dependents. False-skip is safe: CI runs the full unfiltered
  // suite via ci:typecheck/ci:lint/ci:unit (same contract as the path-scoped
  // gates below). integration-tests and e2e are excluded — their test
  // scripts need live services. VITEST_MAX_THREADS/FORKS cap each package's
  // worker pool so concurrent suites don't multiply into cores×packages
  // workers; both reach vitest through test.passThroughEnv (turbo strict env
  // mode) and are unset on CI, where the runner is dedicated.
  // Concurrency defaults to 25% of cores: a push runs on a machine someone is
  // actively working on, and the lower cap costs little wall-clock because the
  // critical path is the largest single suite (which caps its own workers).
  // PREPUSH_CONCURRENCY overrides it (e.g. '50%' on an idle machine).
  gate('typecheck+lint+unit', 'yarn', [
    'turbo', 'run', 'typecheck', 'lint', 'test',
    `--concurrency=${process.env.PREPUSH_CONCURRENCY || '25%'}`,
    `--filter=...[${BASE}]`,
    '--filter=!integration-tests',
    '--filter=!@outerlayer/e2e',
  ], { env: { VITEST_MAX_THREADS: '2', VITEST_MAX_FORKS: '2' } }),
  // Repo-wide baseline gates — path-scoped skip (see the predicates above).
  codeOrConfigChanged
    ? gate('knip',              'yarn', ['ci:knip'])
    : skip('knip', 'no code/config changes'),
  supabaseMocksChanged
    ? gate('supabase-test-mocks', 'yarn', ['ci:supabase-test-mocks'])
    : skip('supabase-test-mocks', 'no test files or its baseline/config changed'),
  // Byte-exact check that permission-seed.json still generates the checked-in
  // 12-rbac.sql seed block + permissions.ts; always-on because it is a fast
  // diff and a stale seed silently breaks RLS authorization.
  gate('permission-codegen',    'yarn', ['ci:permission-codegen']),
  dataAccessChanged
    ? gate('data-access-boundary', 'yarn', ['ci:data-access-boundary'])
    : skip('data-access-boundary', 'no tenant-dashboard src/ee or its baseline changed'),
  crossAppChanged
    ? gate('cross-app-bundling', 'yarn', ['ci:cross-app-bundling'])
    : skip('cross-app-bundling', 'no apps/dependency changes'),
  // Cheap file-content scan; always on — a stray unbounded ClickHouse client
  // is exactly the kind of change that doesn't look like an "apps/dependency
  // change" to the path filters.
  gate('clickhouse-client-guardrails', 'yarn', ['ci:clickhouse-client-guardrails']),
  // Cheap YAML scan; always on. A credential-shaped `env:` literal is invisible
  // to the secret-scan gate (low entropy, no prefix), so this is the only thing
  // standing between a pasted password and `main`.
  gate('workflow-secret-literals', 'yarn', ['ci:workflow-secret-literals']),
  // Cheap glob-resolution check; always on — a renamed/deleted source file
  // silently shrinks a stryker.config*.mjs mutate scope (or a SCOPED_FLOORS
  // entry in patch-mutation.mjs) without any other gate noticing.
  gate('stryker-mutate-targets', 'yarn', ['ci:stryker-mutate-targets']),
  publishSafetyChanged
    ? gate('publish-safety',    'yarn', ['ci:publish-safety'])
    : skip('publish-safety', 'no package.json/publish-config changes'),
  apiTenancyChanged
    ? gate('api-tenancy',       'yarn', ['ci:api-tenancy'])
    : skip('api-tenancy', 'no api route/allowlist changes'),
  weakTestAssertionsChanged
    ? gate('weak-test-assertions', 'yarn', ['ci:weak-test-assertions'])
    : skip('weak-test-assertions', 'no test files or its baseline changed'),
  scriptsChanged
    ? gate('scripts tests', 'npx', ['vitest', 'run', '--project', 'scripts'])
    : skip('scripts tests', 'no scripts/ changes'),
  // Path-scoped gates — skipped automatically when no relevant source changed
  openapiPipeline(),
]);

// patch-mutation (opt-in, see mutationGate) runs SERIALLY, after the
// read-only batch — Stryker mutates files in-place, so it must not race the
// gates above that read them. Skip it when a read-only gate already failed:
// you'll fix and re-push, and that push re-runs it — no point burning the
// 5–8 min mutation run on an already-red push. CI enforces mutation
// regardless.
if (results.every(r => r.status === 'fulfilled')) {
  const mutationResults = await Promise.allSettled([mutationGate()]);
  results.push(...mutationResults);
} else {
  process.stdout.write(
    muted('– patch-mutation (skipped: a read-only gate failed; re-run on re-push)\n'),
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
const elapsed = `${Math.round((Date.now() - T0) / 1000)}s`;
const failures = results.filter(r => r.status === 'rejected');

if (failures.length > 0) {
  // Individual gate output was already printed inline when each gate failed.
  failures.forEach(f => process.stderr.write(fail(`  reason: ${f.reason}\n`)));
  process.stderr.write(fail(`\npre-push: ${failures.length} gate(s) failed (${elapsed} total)\n`));
  process.exit(1);
}

process.stdout.write(pass(`\npre-push: all gates passed (${elapsed} total)\n`));
