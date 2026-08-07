import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — .mjs gate helper, no type declarations; exports are plain JS.
import { pathScopeFlags, pushedChangedPaths, RUN_ALL_PATHS } from '../git/pre-push-scope.mjs';

/**
 * Env for git in the temp-repo tests with the ambient repo pointers scrubbed.
 * A test runner invoked from inside this repo can leak GIT_DIR/GIT_INDEX_FILE/
 * GIT_WORK_TREE, which would point git at the outer repo instead of the temp
 * one and silently corrupt the fixture.
 */
const gitEnv = { ...process.env };
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_INDEX_FILE;
delete gitEnv.GIT_WORK_TREE;

/**
 * pathScopeFlags decides which path-scoped pre-push gates run for a diff. These
 * gates are the ones that would otherwise scan the whole repo on every push, so
 * a wrong flag either wastes minutes (false-run) or skips a gate the push should
 * have hit (false-skip). Pin each flag against representative diff shapes.
 */
describe('pathScopeFlags — per-gate run/skip decision', () => {
  const flags = (path: string) => pathScopeFlags(path);

  it('a docs-only diff runs none of the six repo-wide gates', () => {
    const f = flags('docs/openapi.yaml\ndocs/dashboard-openapi.yaml');
    expect(f.codeOrConfigChanged).toBe(false);
    expect(f.testFilesChanged).toBe(false);
    expect(f.weakTestAssertionsChanged).toBe(false);
    expect(f.supabaseMocksChanged).toBe(false);
    expect(f.dataAccessChanged).toBe(false);
    expect(f.crossAppChanged).toBe(false);
    expect(f.publishSafetyChanged).toBe(false);
    expect(f.scriptsChanged).toBe(false);
    // the openapi pipeline itself does run on a committed-spec change.
    expect(f.docsChanged).toBe(true);
  });

  it('a changed test file runs knip + supabase-mocks/weak-assert + cross-app, not publish-safety', () => {
    const f = flags('apps/tenant-dashboard/src/utils/__tests__/format-number.test.ts');
    expect(f.codeOrConfigChanged).toBe(true);
    expect(f.testFilesChanged).toBe(true);
    expect(f.crossAppChanged).toBe(true);
    expect(f.publishSafetyChanged).toBe(false);
  });

  it('a tenant-dashboard source file runs data-access, not the test-only gates', () => {
    const f = flags('apps/tenant-dashboard/src/utils/format-number.ts');
    expect(f.dataAccessChanged).toBe(true);
    expect(f.testFilesChanged).toBe(false);
    expect(f.codeOrConfigChanged).toBe(true);
    // ee/ counts too.
    expect(pathScopeFlags('apps/tenant-dashboard/ee/services/x.ts').dataAccessChanged).toBe(true);
  });

  it('a package.json runs publish-safety + cross-app + knip, not data-access', () => {
    const f = flags('apps/gateway/package.json');
    expect(f.publishSafetyChanged).toBe(true);
    expect(f.crossAppChanged).toBe(true);
    expect(f.codeOrConfigChanged).toBe(true);
    expect(f.dataAccessChanged).toBe(false);
  });

  it('scopes tsup.config.ts to publish-safety only, and a packages/ source to knip only', () => {
    const tsup = flags('packages/capture/tsup.config.ts');
    expect(tsup.publishSafetyChanged).toBe(true);
    expect(tsup.crossAppChanged).toBe(false);
    const pkgSrc = flags('packages/gateway-core/src/services/x.ts');
    expect(pkgSrc.codeOrConfigChanged).toBe(true);
    expect(pkgSrc.testFilesChanged).toBe(false);
    expect(pkgSrc.dataAccessChanged).toBe(false);
    expect(pkgSrc.crossAppChanged).toBe(false);
    expect(pkgSrc.publishSafetyChanged).toBe(false);
  });

  it('counts .jsx/.mts/.cts sources as code changes for the knip scope', () => {
    expect(flags('apps/x/src/component.jsx').codeOrConfigChanged).toBe(true);
    expect(flags('packages/x/src/mod.mts').codeOrConfigChanged).toBe(true);
    expect(flags('packages/x/src/mod.cts').codeOrConfigChanged).toBe(true);
  });

  it('treats .mts/.cts/.mjs/.cjs test files as test-file changes', () => {
    expect(flags('apps/x/src/a.test.mts').testFilesChanged).toBe(true);
    expect(flags('apps/x/src/a.spec.cts').testFilesChanged).toBe(true);
    expect(flags('apps/x/src/a.test.mjs').testFilesChanged).toBe(true);
    expect(flags('apps/x/src/a.spec.cjs').testFilesChanged).toBe(true);
    // A plain .mts source is code, not a test file — the test-only gates skip it.
    expect(flags('apps/x/src/a.mts').testFilesChanged).toBe(false);
    expect(flags('apps/x/src/a.mts').codeOrConfigChanged).toBe(true);
  });

  it('detects the openapi pipeline inputs', () => {
    expect(pathScopeFlags('packages/gateway-core/src/openapi/routes/traces.ts').openapiChanged).toBe(
      true,
    );
    expect(pathScopeFlags('packages/gateway-core/src/services/x.ts').openapiChanged).toBe(false);
  });
});

/**
 * A ratchet gate that only re-ran when the SOURCE it scans changed had a hole:
 * lowering its frozen baseline (or editing the check itself) shipped ungated,
 * because a baseline edit touches no scanned source. Each gate must also fire on
 * its own inputs — and only its own, so a baseline-only diff runs that one gate
 * and the sibling ratchets still skip.
 */
describe('pathScopeFlags — ratchet gates fire on their own baseline/impl', () => {
  const f = (path: string) => pathScopeFlags(path);

  it('a weak-test-assertions baseline diff runs only its gate among the ratchets', () => {
    const r = f('scripts/weak-test-assertions.baseline.json');
    expect(r.weakTestAssertionsChanged).toBe(true);
    // Not a *.{test,spec}.* file, so the shared raw test signal stays false…
    expect(r.testFilesChanged).toBe(false);
    // …and the sibling ratchets do not run.
    expect(r.supabaseMocksChanged).toBe(false);
    expect(r.dataAccessChanged).toBe(false);
    // A .json baseline is not code, so knip stays skipped too.
    expect(r.codeOrConfigChanged).toBe(false);
  });

  it('a supabase-test-mocks baseline or config diff runs only its gate among the ratchets', () => {
    for (const p of [
      'scripts/no-supabase-test-mocks.baseline.json',
      'scripts/no-supabase-test-mocks.config.mjs',
    ]) {
      const r = f(p);
      expect(r.supabaseMocksChanged).toBe(true);
      expect(r.weakTestAssertionsChanged).toBe(false);
      expect(r.dataAccessChanged).toBe(false);
    }
    expect(f('scripts/no-supabase-test-mocks.baseline.json').codeOrConfigChanged).toBe(false);
  });

  it('a data-access-boundary baseline diff runs only its gate among the ratchets', () => {
    const r = f('scripts/data-access-boundary.baseline.json');
    expect(r.dataAccessChanged).toBe(true);
    expect(r.weakTestAssertionsChanged).toBe(false);
    expect(r.supabaseMocksChanged).toBe(false);
    expect(r.codeOrConfigChanged).toBe(false);
  });

  it('a check-script edit re-runs its own gate (implementation is an input)', () => {
    expect(f('scripts/check-weak-test-assertions.mjs').weakTestAssertionsChanged).toBe(true);
    expect(f('scripts/check-no-supabase-test-mocks.mjs').supabaseMocksChanged).toBe(true);
    expect(f('scripts/check-data-access-boundary.mjs').dataAccessChanged).toBe(true);
    expect(f('scripts/ci/check-cross-app-bundling.mjs').crossAppChanged).toBe(true);
    expect(f('scripts/ci/check-publish-safety.mjs').publishSafetyChanged).toBe(true);
    // A weak-gate impl edit does not trip a sibling ratchet.
    expect(f('scripts/check-weak-test-assertions.mjs').supabaseMocksChanged).toBe(false);
  });

  it('any scripts/ change runs the scripts vitest project; other trees do not', () => {
    expect(f('scripts/git/pre-push-scope.mjs').scriptsChanged).toBe(true);
    expect(f('scripts/weak-test-assertions.baseline.json').scriptsChanged).toBe(true);
    expect(f('apps/tenant-dashboard/src/foo.ts').scriptsChanged).toBe(false);
  });

  it('api-tenancy runs on an api route file, its allowlist, or its check — not other dashboard src', () => {
    expect(f('apps/tenant-dashboard/src/app/api/agents/sessions/route.ts').apiTenancyChanged).toBe(true);
    expect(f('scripts/ci/api-tenancy-allowlist.json').apiTenancyChanged).toBe(true);
    expect(f('scripts/ci/check-api-tenancy-allowlist.mjs').apiTenancyChanged).toBe(true);
    // A non-route dashboard source edit does not trip the gate.
    expect(f('apps/tenant-dashboard/src/app/api/agents/sessions/helper.ts').apiTenancyChanged).toBe(false);
    expect(f('apps/tenant-dashboard/src/utils/format-number.ts').apiTenancyChanged).toBe(false);
  });
});

/**
 * pushedChangedPaths must report the PUSH's own changes, not upstream drift.
 * The direction bug this guards: `HEAD...base` (the reverse three-dot range)
 * yields base's changes since the branch point, so a branch in sync with base
 * sees an empty set and every path-scoped gate wrongly skips. Set up a repo
 * where the branch adds one file and the base adds an unrelated one, and pin
 * that the branch's file is seen and the base's is not.
 */
describe('pushedChangedPaths — reports the push, not upstream drift', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8', env: gitEnv });

  // pushedChangedPaths spawns git with the ambient process env, so a leaked
  // GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE (set for any git hook, e.g. the very
  // pre-push run that executes this suite) would point it at the OUTER repo
  // instead of the temp one, and cwd cannot override those. Scrub them from
  // process.env for the duration of this block and restore after.
  const savedGitEnv: Record<string, string | undefined> = {};
  const GIT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'];

  beforeAll(() => {
    for (const v of GIT_VARS) {
      savedGitEnv[v] = process.env[v];
      delete process.env[v];
    }
    repo = mkdtempSync(join(tmpdir(), 'prepush-scope-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'base');

    // The branch (what we're "pushing") adds one source file.
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'branch-file.ts'), 'export const x = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'branch adds X');

    // main advances independently with an unrelated test file (upstream drift).
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'upstream-file.test.ts'), 'export const y = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'upstream adds Y');

    git('checkout', '-q', 'feature');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    for (const v of GIT_VARS) {
      if (savedGitEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedGitEnv[v];
    }
  });

  it('sees the branch file and NOT the upstream file', () => {
    const changed = pushedChangedPaths({ cwd: repo, base: 'main' })
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean)
      .sort();
    expect(changed).toEqual(['branch-file.ts']);
    expect(changed).not.toContain('upstream-file.test.ts');
  });

  it('the wrong direction (`base...HEAD` reversed) would key gates off the upstream test file', () => {
    // Guards the exact regression: with the reversed range the scope would see
    // the upstream *.test.ts and wrongly flag the test-only gates as needing to
    // run, while the push's real change is a plain source file. Proven here by
    // computing the reverse range directly.
    const reversed = execFileSync('git', ['diff', '--name-only', 'HEAD...main'], {
      cwd: repo,
      encoding: 'utf8',
      env: gitEnv,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(reversed).toEqual(['upstream-file.test.ts']);
    // The correct direction's flags: a plain source push, no test-gate run.
    const correct = pathScopeFlags(pushedChangedPaths({ cwd: repo, base: 'main' }));
    expect(correct.testFilesChanged).toBe(false);
    expect(correct.codeOrConfigChanged).toBe(true);
  });
});

/**
 * The diff read must fail CLOSED. A git error means the changed set is UNKNOWN,
 * not empty — returning '' there would skip every scoped gate on a broken read.
 * pushedChangedPaths returns a sentinel that pathScopeFlags expands to "run
 * everything", so an unknowable diff over-runs rather than silently under-runs.
 */
describe('pushedChangedPaths — fails closed to run-all on a broken diff', () => {
  it('returns the run-all sentinel and warns when git cannot resolve the range', () => {
    // Capture the warning instead of letting it hit real stderr: this test runs
    // inside the pre-push `scripts tests` gate, which forwards a passing
    // suite's stderr — an uncaptured warning surfaces in every push's output
    // looking like the push's own scope computation failed.
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A bogus base ref makes `git diff` exit non-zero regardless of cwd.
      const out = pushedChangedPaths({ base: 'no-such-ref-QwErTy' });
      expect(out).toBe(RUN_ALL_PATHS);
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining('could not determine changed paths'),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('the sentinel marks every scoped gate to run', () => {
    const flags = pathScopeFlags(RUN_ALL_PATHS);
    // Every flag true — spot-checked too so `every` can't pass on an empty object.
    expect(Object.values(flags).every((v) => v === true)).toBe(true);
    expect(flags.docsChanged).toBe(true);
    expect(flags.weakTestAssertionsChanged).toBe(true);
    expect(flags.supabaseMocksChanged).toBe(true);
    expect(flags.dataAccessChanged).toBe(true);
    expect(flags.scriptsChanged).toBe(true);
  });
});
