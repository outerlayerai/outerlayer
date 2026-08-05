#!/usr/bin/env node

/**
 * Patch mutation gate.
 *
 * Runs Stryker mutation testing scoped to ONLY the source files a PR changed,
 * and fails if the changed code's tests don't kill enough mutants. This catches
 * fake-green tests (e.g. a 0%-mutation billing test that runs the code and
 * asserts nothing) at PR time instead of in the nightly — turning "green CI"
 * from "the tests ran" into "the tests would catch a bug".
 *
 * Companion to check-patch-coverage.mjs:
 *   - patch coverage:  did the new line execute under test?
 *   - patch mutation:  would a bug on that line be caught?
 *
 * Scope mapping (a changed file → what to mutate for it):
 *   - changed source `src/x/foo.ts`            → mutate ONLY ITS CHANGED LINES,
 *     via Stryker mutation ranges (`foo.ts:12-25`). Line ranges come from the
 *     PR files API patch hunks (CI) or `git diff -U0` (local). Whole-FILE
 *     mutation at gateway-route scale generates mutant counts no PR budget can
 *     absorb (3 changed route files → 840 mutants ≈ 3-4 h at the openapi
 *     shards' observed ~13-17 s/mutant — see stryker-nightly.yml), burning the
 *     full 24-min budget for zero enforcement. Line-scoping keeps the cost
 *     proportional to the DIFF, which is the thing this gate exists to grade.
 *   - line info unavailable (no patch in the API response, plain-list changed
 *     files file)                               → fall back to the WHOLE file
 *   - a deletion-only change to a source file   → contributes NO targets (no
 *     added lines to mutate; the nightly still covers the remaining file)
 *   - a TEST-ONLY change                        → contributes NO targets (skip)
 * The gate validates CHANGED PRODUCTION CODE — "would a bug in this diff be
 * caught?". A PR that only adds or edits tests changes no production code, so
 * there is nothing to gate and the gate is SKIPPED. Catching fake-green tests
 * on PRE-EXISTING source is the nightly find-fake-green report's job, not a
 * blocking PR gate: mapping a changed test back onto its whole source dir would
 * make adding tests to a legacy-undertested file — or to any dir holding React
 * components Stryker's runner can't cover — unshippable.
 * Generated / type-declaration / test files — and `.tsx` React components
 * (presentation, mutation-graded only by the nightly's `.ts`-logic set) — are
 * never mutate targets. See `targetsForChange`.
 *
 * Only workspaces with their own `stryker.config.mjs` participate. `--mutate`
 * REPLACES the config's mutate glob, so a changed file is checked even if the
 * nightly excludes its directory as a "thin wrapper" (the exact blind spot that
 * let the metering jobs ship at 0% mutation — see the test-coverage roadmap).
 *
 * Resilience: a genuine low score fails the gate; an infra failure (Stryker
 * can't run a workspace, an unmutatable file, zero mutants) warns and passes —
 * so this gate catches weak tests without becoming the flaky blocker.
 *
 * Inputs (env):
 *   PATCH_MUTATION_BASE            git ref to diff against (default origin/main)
 *   PATCH_MUTATION_CHANGED_FILES   optional path to the changed-files list. CI
 *                                  writes NDJSON ({"filename","patch"} per line,
 *                                  straight from the PR files API) so the gate
 *                                  can line-scope; a plain newline list of paths
 *                                  is still accepted (whole-file fallback).
 *                                  Falls back to `git diff -U0` when unset.
 *   PATCH_MUTATION_THRESHOLD       base min mutation score % on changed files
 *                                  (def 60). The effective bar per workspace is
 *                                  max(base, that workspace's nightly floor from
 *                                  mutation-score-floors.json), so the PR gate is
 *                                  never weaker than the nightly.
 *   PATCH_MUTATION_MIN_MUTANTS     don't enforce below this many mutants (def 8)
 *
 * Exit: 0 pass / skip / infra-tolerated, 1 a changed file is below threshold.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import {
  GATEWAY_SCOPED_WORKSPACES,
  scopeForFile,
  scopeEnv,
} from './gateway-mutation-scopes.mjs';

const cwd = process.cwd();
const BASE = process.env.PATCH_MUTATION_BASE ?? 'origin/main';
const THRESHOLD = Number(process.env.PATCH_MUTATION_THRESHOLD ?? 60);
const MIN_MUTANTS = Number(process.env.PATCH_MUTATION_MIN_MUTANTS ?? 8);
// CI fans the changed files across N parallel shards ("k/N") so the mutant
// phase — the dominant cost on a large diff (~70% of a slow run) — executes on
// N runners at once. Unset (local runs, the nightly) means one shard: every
// target, exactly today's behaviour.
const SHARD = process.env.PATCH_MUTATION_SHARD ?? '';
// Below this many total targets, don't fan out: the per-shard whole-suite dry
// run (~4-5 min) is a fixed floor that would just be duplicated across runners
// for little wall-clock gain, so shard 1 takes everything and the rest skip.
const SHARD_MIN_TARGETS = Number(process.env.PATCH_MUTATION_SHARD_MIN ?? 4);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

// Self-imposed wall-clock budget. Stryker's runtime scales with the diff (the
// dry run alone exercises the whole suite, then every mutant runs its covering
// tests), so a large PR can outrun the JOB's `timeout-minutes`. When THAT fires,
// GitHub hard-CANCELS the job — and a cancelled job reds the CI Gate before this
// script can apply its own "infra trouble → warn and pass" fallback (see the
// resilience note in the header). So the script owns its own clock: it bounds
// total Stryker runtime BELOW the job timeout and degrades an over-budget run to
// an advisory pass, with the nightly (stryker-nightly.yml) remaining the source
// of truth. Keep PATCH_MUTATION_BUDGET_MIN comfortably under the job's
// timeout-minutes in ci.yml so this fires first.
//
// 12m (was 24m): with high-fan-in env/config wiring excluded (NON_MUTATABLE_RE),
// a normal PR mutates a handful of logic files and finishes in a few minutes;
// 12m is ample headroom for that while HALVING the worst-case runner time any
// future pathological/oversized diff can burn before degrading to advisory.
const BUDGET_MIN = Number(process.env.PATCH_MUTATION_BUDGET_MIN ?? 12);
const BUDGET_MS = (Number.isFinite(BUDGET_MIN) && BUDGET_MIN > 0 ? BUDGET_MIN : 12) * 60_000;
// Don't launch a run with less than this left on the clock — it can't finish, so
// skip straight to the advisory path rather than burn the remainder.
const MIN_RUN_MS = 60_000;
// The nightly floors live next to this script. We diff against them so the PR
// gate is never *weaker* than the nightly bar for a workspace.
const FLOORS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'mutation-score-floors.json',
);

const TEST_RE = /\.(test|spec)\.[tj]sx?$/;
const SRC_RE = /\.(ts|tsx)$/;
// Source files we never mutate:
//   - type decls (.d.ts), generated code, and test scaffolding (the dirs);
//   - high-fan-in declarative env/config WIRING — `env.ts` (the t3-env schema
//     + runtimeEnv map) and `config-global[.server].ts` (its re-exports).
//
// Why the wiring files are excluded (the "unacceptable CI" class): they are
// imported across nearly the ENTIRE app, so Stryker's per-test coverage marks
// ~the whole suite as covering each mutant in them. Mutating one such file
// therefore re-runs thousands of tests per mutant — many minutes (×N shards,
// each paying a full dry run) for near-zero signal, because the files are
// declarative plumbing with no branching logic worth a mutant. A PR that only
// touches env/config used to burn the entire PATCH_MUTATION_BUDGET_MIN before
// degrading to an advisory pass. Their behaviour is covered by ordinary unit
// tests + the env-default-invariant guard, so dropping them from the mutate
// set keeps the gate (CI AND local pre-push) fast with no real loss of rigor.
// Add future app-wide declarative wiring here rather than paying that cost.
const NON_MUTATABLE_RE =
  /(\.d\.ts$|(^|\/)(__tests__|__mocks__|test-helpers|test-utils|fixtures|generated)\/|(^|\/)(env|config-global(\.server)?)\.ts$)/;
const MUTATE_EXCLUDES =
  '!src/**/*.test.ts,!src/**/*.spec.ts,!src/**/*.test.tsx,!src/**/*.spec.tsx,!src/**/__tests__/**,!src/**/*.d.ts';

/**
 * Load the nightly floor map (`mutation-score-floors.json`). Returns {} if the
 * file is missing or unparseable — the gate then falls back to the flat base
 * threshold rather than failing on a config read.
 */
export function loadFloors() {
  try {
    return JSON.parse(readFileSync(FLOORS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The PR-gate threshold for a workspace: the higher of the flat base (60) and
 * the workspace's own nightly floor. This stops a PR from dragging a sensitive
 * file below its nightly bar (e.g. api-key-service 87) yet passing the PR gate
 * at a flat 60, only to fail next-day nightly *after* it has merged. A `null`
 * floor (baseline pending) or absent entry falls back to the base. Suffixed
 * keys like `<ws>:shard-floor` are not exact workspace ids, so they never
 * match here.
 */
export function thresholdForWorkspace(ws, floors, base = THRESHOLD) {
  const floor = floors?.[ws];
  return typeof floor === 'number' ? Math.max(base, floor) : base;
}

/**
 * Path-scoped mutation floors. Specific high-blast-radius files are held to a
 * higher bar than their workspace's general floor — e.g. the tenant-dashboard
 * money-and-auth core (Stripe checkout/portal/upgrade server actions + the
 * payment webhook) sits in a workspace whose broad UI/server mutants justify a
 * lax 49 floor, but the money path itself must clear the gateway/builder bar.
 * The floor VALUE is ratchet-adjacent in mutation-score-floors.json under a
 * suffixed key (`<ws>:<scope>`); the path list lives here.
 */
export const SCOPED_FLOORS = [
  {
    key: 'apps/tenant-dashboard:money-auth',
    workspace: 'apps/tenant-dashboard',
    files: [
      // The billing feature slice: `actions.ts` carries the permission gates
      // (billing.insert/update/read) and `service.ts` carries the Stripe
      // calls + RLS-scoped reads those actions delegate to.
      'src/features/billing/actions.ts',
      'src/features/billing/service.ts',
      'src/app/api/webhooks/payment/route.ts',
      // Stripe checkout line-item + subscription swap/delete computation. A
      // silent bug here mis-bills customers, so it is held to the money-auth
      // bar (85) instead of the lax tenant-dashboard workspace floor (49).
      'src/config/stripe-prices.ts',
    ],
  },
];

/**
 * The scoped floor for a workspace-relative changed file, if it belongs to a
 * path-scoped group with a numeric floor. Returns null when the file is in no
 * scope (caller falls back to the workspace floor), or when the scope's floor
 * is null/absent (baseline pending).
 */
export function scopedFloorFor(ws, relFile, floors) {
  for (const scope of SCOPED_FLOORS) {
    if (scope.workspace !== ws) continue;
    if (!scope.files.includes(relFile)) continue;
    const floor = floors?.[scope.key];
    return typeof floor === 'number' ? floor : null;
  }
  return null;
}

/**
 * Attach an effective threshold to each Stryker run group, splitting a group
 * when its files span different floors. Most files use the workspace floor;
 * path-scoped files (SCOPED_FLOORS) use `max(base, scopedFloor)` so a PR can't
 * quietly weaken them to the lax workspace bar. Files of differing thresholds
 * are split into separate runs so each is graded at exactly its own bar — a
 * combined run produces one score and would otherwise grade an ordinary file
 * at the stricter scoped bar (a false block) or vice-versa.
 */
export function thresholdGroupsFor(ws, groups, floors, base = THRESHOLD) {
  const wsThreshold = thresholdForWorkspace(ws, floors, base);
  const out = [];
  for (const group of groups) {
    const byThreshold = new Map();
    for (const f of group.files) {
      const scoped = scopedFloorFor(ws, f, floors);
      const threshold = scoped === null ? wsThreshold : Math.max(base, scoped);
      let g = byThreshold.get(threshold);
      if (!g) {
        g = { ...group, files: [], threshold };
        byThreshold.set(threshold, g);
      }
      g.files.push(f);
    }
    // Stable order: lower threshold first.
    for (const t of [...byThreshold.keys()].sort((a, b) => a - b)) {
      out.push(byThreshold.get(t));
    }
  }
  return out;
}

export function strykerWorkspaces() {
  const out = [];
  for (const root of ['apps', 'packages']) {
    const abs = path.join(cwd, root);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (existsSync(path.join(abs, name, 'stryker.config.mjs'))) {
        out.push(`${root}/${name}`);
      }
    }
  }
  return out;
}

/**
 * Estimated mutant load for one changed target, used to balance the CI shards.
 * The proxy is the count of changed MUTABLE lines — Stryker's mutant count on a
 * line-scoped run tracks the number of changed lines, and that data is already
 * computed for scoping. A whole-file target (ranges unknown/deletion-only, so it
 * mutates the entire file) has no changed-line count, so it is weighted by
 * `wholeFileLines` — the file's own length — which is the right proxy for the
 * whole-file mutant load the shard will pay. Pure, so it is unit-tested.
 */
export function targetWeight(ranges, wholeFileLines) {
  if (Array.isArray(ranges)) {
    const changed = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    if (changed > 0) return changed;
  }
  return Math.max(wholeFileLines, 1);
}

/**
 * Partition the per-workspace target map (`Map<ws, files[]>`) across N parallel
 * CI shards so the mutant phase runs on N runners at once. Pure (no fs, no
 * Stryker) so the split is unit-tested; `weightOf(ws, file)` supplies each
 * target's estimated mutant load ({@link targetWeight}).
 *
 * `spec` is "k/N" (1-indexed). The split packs at TWO levels so a workspace
 * pays its per-shard whole-suite dry run — the dominant fixed cost — as few
 * times as possible. Each workspace is one packing UNIT: all its changed files
 * ride the same shard, so that shard runs the workspace's dry run once and no
 * other shard pays it. The exception is a workspace heavier than a single
 * shard's fair share (ceil(totalWeight / N)): keeping it whole would overload
 * one shard, so its files split into per-file units and spread across shards.
 * Units are then greedy longest-processing-time bin-packed: ordered
 * heaviest-first, each placed on the currently-lightest shard, which keeps the
 * slowest shard near the mean even when one unit dominates. A shard with no
 * units returns an empty map; the gate skips it in seconds (no Stryker, no dry
 * run).
 *
 * Deterministic: units are ordered by (weight desc, workspace asc, key-path
 * asc) with ties placed on the lowest shard index, and files are grouped and
 * emitted in sorted order, so a file lands on the same shard every run
 * regardless of the input map's iteration order.
 *
 * Enforcement is unchanged: every target is still graded at its own threshold
 * in exactly one shard, and the CI Gate ANDs the shards (any shard below bar →
 * the gate fails). Sharding moves WHERE a file is mutated, never WHETHER.
 *
 * Guards that fall back to the whole map (no sharding): an absent/!"k/N" spec,
 * N≤1, an out-of-range k, or a diff smaller than `minTargets` (where the
 * duplicated per-shard dry-run isn't worth the split — shard 1 takes all).
 */
export function shardTargets(byWs, spec = SHARD, minTargets = SHARD_MIN_TARGETS, weightOf = () => 1) {
  if (!spec) return byWs;
  const m = /^(\d+)\/(\d+)$/.exec(String(spec).trim());
  if (!m) return byWs;
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (!(n > 1) || !(k >= 1 && k <= n)) return byWs;

  const flat = [];
  for (const [ws, files] of byWs) {
    for (const f of files) flat.push([ws, f]);
  }

  // Too small to fan out: shard 1 runs everything, the other shards skip. This
  // is a COUNT floor — a tiny target set never justifies the tripled dry-run,
  // regardless of any single target's weight.
  if (flat.length < minTargets) return k === 1 ? byWs : new Map();

  // Weigh every target once; total per workspace and overall.
  const weightByTarget = new Map();
  const weightByWs = new Map();
  const filesByWs = new Map();
  let grandTotal = 0;
  for (const [ws, f] of flat) {
    const w = weightOf(ws, f);
    weightByTarget.set(`${ws} ${f}`, w);
    weightByWs.set(ws, (weightByWs.get(ws) ?? 0) + w);
    grandTotal += w;
    if (!filesByWs.has(ws)) filesByWs.set(ws, []);
    filesByWs.get(ws).push(f);
  }

  // A workspace's whole-suite dry run is the per-shard fixed cost, so keep its
  // files together on ONE shard whenever they fit a shard's fair share. Only a
  // workspace heavier than the fair share is split into per-file units, so it
  // can spread across shards without any one shard exceeding the share.
  const fairShare = Math.max(1, Math.ceil(grandTotal / n));
  const units = [];
  for (const ws of [...filesByWs.keys()].sort()) {
    const files = filesByWs.get(ws).slice().sort();
    if ((weightByWs.get(ws) ?? 0) <= fairShare) {
      units.push({ ws, files, w: weightByWs.get(ws) ?? 0, key: files[0] ?? '' });
    } else {
      for (const f of files) {
        units.push({ ws, files: [f], w: weightByTarget.get(`${ws} ${f}`) ?? 1, key: f });
      }
    }
  }

  const byWeightThenPath = (a, b) =>
    b.w - a.w || (a.ws === b.ws ? a.key.localeCompare(b.key) : a.ws.localeCompare(b.ws));
  units.sort(byWeightThenPath);

  const loads = new Array(n).fill(0);
  const assigned = Array.from({ length: n }, () => []);
  for (const unit of units) {
    let best = 0;
    for (let b = 1; b < n; b += 1) {
      if (loads[b] < loads[best]) best = b;
    }
    loads[best] += unit.w;
    assigned[best].push(unit);
  }

  const out = new Map();
  for (const unit of assigned[k - 1].sort(byWeightThenPath)) {
    if (!out.has(unit.ws)) out.set(unit.ws, []);
    out.get(unit.ws).push(...unit.files);
  }
  for (const [ws, files] of out) out.set(ws, files.sort());
  return out;
}

/**
 * Parse one file's unified-diff patch text (the PR files API `patch` field, or
 * one file's section of `git diff -U0`) into the line ranges ADDED in the new
 * file, merged where adjacent. These become Stryker mutation ranges
 * (`file.ts:start-end`) so the gate mutates the DIFF, not the whole file.
 *
 * Hunk headers alone are not enough: an API patch carries 3 context lines per
 * hunk, and the header's `+start,count` counts context too. So walk each hunk
 * body tracking the new-file line counter and record only `+` lines.
 *
 * Return shape is tri-state, and each state has a distinct downstream meaning:
 *   null  → no patch text available → caller falls back to the WHOLE file
 *   []    → patch exists but adds no lines (deletion-only) → NO target
 *   [...] → mutate exactly these line ranges
 */
export function addedLineRanges(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return null;
  const ranges = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // file header lines (---, +++, index …)
    if (raw.startsWith('+')) {
      const last = ranges[ranges.length - 1];
      if (last && newLine <= last.end + 1) last.end = newLine;
      else ranges.push({ start: newLine, end: newLine });
      newLine += 1;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // deleted line / "\ No newline at end of file" — no new-file line consumed
    } else {
      newLine += 1; // context line
    }
  }
  return ranges;
}

/**
 * Parse the changed-files file content into `{ file, ranges }` entries. Two
 * formats, distinguished per line so a mixed/garbled file degrades safely:
 *   - NDJSON `{"filename": "...", "patch": "..."}` (CI: the PR files API
 *     response verbatim) → ranges from the patch hunks (null when the API
 *     omitted the patch, e.g. very large or binary files → whole-file fallback)
 *   - a plain path per line (the legacy list)      → ranges null (whole file)
 */
export function parseChangedEntries(content) {
  const entries = [];
  for (const line of content.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.filename === 'string') {
          entries.push({ file: obj.filename, ranges: addedLineRanges(obj.patch) });
          continue;
        }
      } catch {
        /* not JSON after all — treat as a plain path below */
      }
    }
    entries.push({ file: line, ranges: null });
  }
  return entries;
}

/**
 * Split multi-file `git diff -U0` output into per-file `{ file, ranges }`
 * entries (the local-run counterpart of the NDJSON path). `-U0` means zero
 * context lines, but addedLineRanges handles any context width, so the two
 * sources share one parser.
 */
export function parseUnifiedDiff(diffText) {
  const entries = [];
  let file = null;
  let patchLines = [];
  const flush = () => {
    if (file) entries.push({ file, ranges: addedLineRanges(patchLines.join('\n')) ?? [] });
    file = null;
    patchLines = [];
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
    } else if (file) {
      patchLines.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Escape a literal file path for use as a Stryker `--mutate` glob.
 *
 * Stryker matches mutate patterns with minimatch, so a Next.js dynamic-route
 * path like `src/app/api/apps/[appId]/route.ts` is read as a character class
 * and can never match the literal file — the pattern doesn't even match
 * itself, Stryker finds nothing to mutate, and the gate's infra tolerance
 * silently passed the group.
 *
 * Backslash escaping is NOT an option: Stryker normalizes every `\` in the
 * pattern to `/` (normalizeFileName) before matching. Wrapping each glob-magic
 * character in its own character class survives that normalization — `[x]`
 * can only be satisfied by the literal `x`. Escaping `(` also defuses the
 * extglob forms (`@(`, `!(`, `+(` …), so `@` / `!` / `+` need no handling of
 * their own beyond the wrap. Verified against Stryker's own FileMatcher for
 * `[id]`, `[...slug]`, `[[...slug]]`, `(group)`, `@slot`, and `(.)intercept`
 * paths.
 */
export function escapeMutateGlob(filePath) {
  return filePath.replace(/[[\]*?(){}@+|]/g, (c) => `[${c}]`);
}

/**
 * Compose the Stryker `--mutate` patterns for a run: a file with known ranges
 * contributes one `file:start-end` range pattern per range (Stryker unions
 * same-file ranges); a file with unknown ranges (null) contributes itself
 * whole. Range-less files were already dropped as targets upstream.
 * Paths are glob-escaped ({@link escapeMutateGlob}); Stryker strips the
 * `:start-end` suffix before glob matching, so ranges compose with escaping.
 */
export function mutatePatternsFor(files, rangesFor = () => null) {
  return files.flatMap((f) => {
    const glob = escapeMutateGlob(f);
    const ranges = rangesFor(f);
    if (!Array.isArray(ranges) || ranges.length === 0) return [glob];
    return ranges.map((r) => `${glob}:${r.start}-${r.end}`);
  });
}

/**
 * Self-check for the composed `--mutate` patterns: every target file must be
 * matched by at least one of its patterns under the same glob semantics
 * Stryker uses. Returns the files that would be SILENTLY SKIPPED — a pattern
 * that matches nothing produces no report, and the gate's infra tolerance
 * would pass the group without grading it. The caller fails the
 * gate on a non-empty result, so any future unescaped glob-magic path char
 * surfaces as a loud failure instead of a fake green.
 */
export function unmatchedMutateTargets(files, patterns) {
  const globs = patterns.map((p) => {
    // Same range-stripping Stryker applies (MUTATION_RANGE_REGEX) before
    // glob-matching the remainder.
    const m = /(.*?):(\d+)(?::\d+)?-(\d+)(?::\d+)?$/.exec(p);
    return m ? m[1] : p;
  });
  return files.filter((f) => !globs.some((g) => minimatch(f, g)));
}

/** Changed files with their added-line ranges: `Array<{file, ranges}>`. */
function changedFiles() {
  const listFile = process.env.PATCH_MUTATION_CHANGED_FILES;
  if (listFile && existsSync(listFile)) {
    return parseChangedEntries(readFileSync(listFile, 'utf8'));
  }
  // Default spawnSync maxBuffer is 1 MiB — a branch with a large test diff
  // overflows it and the gate dies with ENOBUFS before grading anything.
  const run = (args) =>
    execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
  let out = '';
  try {
    out = run(['diff', '-U0', '--diff-filter=d', `${BASE}...HEAD`]);
  } catch {
    out = run(['diff', '-U0', '--diff-filter=d', BASE]);
  }
  return parseUnifiedDiff(out);
}

/**
 * Map one changed file to the source file(s) to mutate for it. ONLY a changed
 * source file is a target — the gate exists to validate changed PRODUCTION
 * code. A test-only change contributes nothing: its sibling source did not
 * change, so the diff introduces no new risk to gate, and requiring a whole
 * pre-existing file (or a dir of React components Stryker can't cover) to clear
 * the bar would make adding tests to undertested code unshippable. Test quality
 * on EXISTING source is the nightly find-fake-green report's job.
 */
// React components (`.tsx`) are out of the patch gate's scope, matching the
// nightly config's mutate set — pure-TS business logic only (see
// `apps/tenant-dashboard/stryker.config.mjs`, which globs `**/*.ts`, never
// `.tsx`). A component diff's mutants are dominated by presentation: MUI
// `sx={{…}}` style objects and conditional JSX rendering. Killing those requires
// asserting exact computed styles (`getComputedStyle(el).marginBottom === '24px'`)
// — the brittle, refactor-hostile pins the repo's Test Quality guidance warns
// against — and pure-display components legitimately carry no unit test. Measured
// on a styling-only MUI-v9 migration: ~4% score with ~86% of mutants being
// un-killable-without-brittle-style-tests `sx`. Real component LOGIC worth
// grading belongs in a `.ts` module (extract-and-test), which this gate still
// grades; the nightly (source of truth) likewise never mutates `.tsx`.
const COMPONENT_RE = /\.tsx$/;

export function targetsForChange(file) {
  if (TEST_RE.test(file)) return [];
  if (COMPONENT_RE.test(file)) return [];
  if (SRC_RE.test(file) && !NON_MUTATABLE_RE.test(file)) return [file];
  return [];
}

/**
 * Split a workspace's changed source files into independent Stryker runs.
 *
 * One Stryker run uses one test-discovery scope. For most workspaces that's the
 * whole suite, so all files run together with no extra env. The gateway is the
 * exception: BOTH gateway workspaces (packages/gateway-core and apps/gateway)
 * have suites that overrun perTest, and a single run can only set one
 * `STRYKER_VITEST_DIR`, so files are grouped by their scope (services / lib /
 * openapi / …) and each group runs separately. Gateway files no shard mutates
 * (thin-wrapper dirs) are returned in `skipped` — the gate reports them as
 * out-of-scope rather than failing, matching the nightly, which never mutates
 * them.
 *
 * @returns {{ groups: Array<{label: string|null, files: string[], env: object}>, skipped: string[] }}
 */
export function scopeGroups(ws, relFiles, scopeFor = scopeForFile) {
  if (!GATEWAY_SCOPED_WORKSPACES.includes(ws)) {
    return { groups: [{ label: null, files: relFiles, env: {} }], skipped: [] };
  }
  const byScope = new Map();
  const skipped = [];
  for (const f of relFiles) {
    const scope = scopeFor(ws, f);
    if (!scope) {
      skipped.push(f);
      continue;
    }
    const key = `${scope.vitestDir}|${scope.include ?? ''}`;
    let group = byScope.get(key);
    if (!group) {
      group = { label: scope.vitestDir, files: [], env: scopeEnv(scope) };
      byScope.set(key, group);
    }
    group.files.push(f);
  }
  return { groups: [...byScope.values()], skipped };
}

// A workspace may ship a PR-gate Stryker config that scopes the dry run to the
// changed files' covering tests (related:true) instead of the full suite. When
// present, the patch gate uses it; the nightly keeps the default full-suite
// config. Opt-in per workspace — workspaces without this file are unchanged.
const PATCH_CONFIG = 'stryker.config.patch.mjs';

/**
 * Parse a Stryker `mutation.json` report string into a score record. Pure (no
 * fs), so the tally is unit-testable. NoCoverage mutants count toward the
 * denominator — an untested changed line is exactly the fake-green this gate
 * exists to catch — and are listed as survivors tagged `(no coverage)`.
 */
export function parseReport(jsonStr) {
  const report = JSON.parse(jsonStr);
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  const survivors = [];
  for (const [fp, data] of Object.entries(report.files ?? {})) {
    const name = path.basename(fp);
    for (const m of data.mutants ?? []) {
      switch (m.status) {
        case 'Killed':
          killed += 1;
          break;
        case 'Timeout':
          timeout += 1;
          break;
        case 'Survived':
          survived += 1;
          survivors.push(`${name}:${m.location.start.line} ${m.mutatorName}`);
          break;
        case 'NoCoverage':
          noCoverage += 1;
          survivors.push(`${name}:${m.location.start.line} ${m.mutatorName} (no coverage)`);
          break;
        default:
          break; // CompileError / RuntimeError / Ignored — out of denominator
      }
    }
  }
  const total = killed + survived + timeout + noCoverage;
  const detected = killed + timeout;
  const score = total === 0 ? 100 : (detected / total) * 100;
  return { killed, survived, timeout, noCoverage, total, score, survivors };
}

/**
 * The signature of "test scoping resolved NO covering tests": every mutant
 * landed NoCoverage and none was exercised. Under the related-scoped patch
 * config this means the import graph failed to find the changed file's tests —
 * indistinguishable from a genuinely untested file by the report alone, which
 * is why the caller settles it with a full-suite re-run rather than failing.
 * Pure, so it is unit-testable. False for null / budgetExceeded / empty runs.
 */
export function isAllNoCoverage(result) {
  if (!result || typeof result.total !== 'number' || result.total === 0) return false;
  return result.killed + result.survived + result.timeout === 0 && result.noCoverage === result.total;
}

/**
 * Run Stryker once over `relFiles` (workspace-relative) in `wsAbs`, optionally
 * with a specific `configFile` (positional Stryker arg). Returns a score record
 * (via parseReport), `{ budgetExceeded: true }` if it ran past `budgetMs`, or
 * null if no report was produced (infra / unmutatable file).
 */
function runStrykerOnce(wsAbs, mutate, { configFile = null, extraEnv = {}, budgetMs }) {
  // Out of budget before we even start — a run that can't finish would just get
  // killed mid-flight, so report it as over-budget straight away.
  if (budgetMs < MIN_RUN_MS) return { budgetExceeded: true };

  const reportPath = path.join(wsAbs, 'reports/mutation/mutation.json');
  rmSync(reportPath, { force: true });
  rmSync(path.join(wsAbs, 'reports/mutation/stryker-incremental.json'), { force: true });

  // Stryker takes the config file as a positional arg, before flags.
  const args = ['stryker', 'run'];
  if (configFile) args.push(configFile);
  args.push('--mutate', mutate, '--reporters', 'clear-text,json');

  let budgetExceeded = false;
  try {
    execFileSync('npx', args, {
      cwd: wsAbs,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      // Own the clock here so the JOB timeout never hard-cancels us first.
      timeout: budgetMs,
      killSignal: 'SIGTERM',
    });
  } catch (err) {
    // Node sets `killed`/SIGTERM when IT terminates the child for outrunning
    // `timeout` — that's our budget firing, so degrade to an advisory pass
    // (handled by the caller) rather than a hard failure. Any OTHER non-zero is
    // Stryker hitting its OWN break threshold, which is expected: we compute our
    // own verdict from the report below. A genuine infra failure (no report)
    // also falls through to the null return.
    if (err && (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')) {
      budgetExceeded = true;
    }
  }
  if (budgetExceeded) return { budgetExceeded: true };

  if (!existsSync(reportPath)) return null;
  try {
    return parseReport(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run Stryker over `mutatePatterns` (workspace-relative mutate patterns —
 * plain files and/or `file:start-end` line ranges) in `ws`. Returns a score
 * record, or null if Stryker could not produce a report (infra error).
 *
 * When the workspace ships a {@link PATCH_CONFIG}, the first run uses it: the
 * dry run is scoped to the changed files' covering tests (related:true), so the
 * gate's cost tracks the diff instead of paying for the full ~3,100-test
 * baseline on every PR. Safety net: if that scoping resolves no covering tests
 * (every mutant NoCoverage — see {@link isAllNoCoverage}), re-run once on the
 * full-suite default config so a graph-resolution miss can never falsely fail a
 * PR. A genuinely untested file stays all-NoCoverage under the full suite and
 * fails for real; the nightly (full suite) remains the source of truth either way.
 *
 * `extraEnv` carries per-run test-discovery scoping. Most workspaces discover
 * all their own tests under one config and pass `{}`. The gateway is the
 * exception: its ~1,600-test suite overruns Stryker's hardcoded perTest
 * coverage analysis (stryker-mutator/stryker-js#214), so the caller groups
 * gateway files by source area (see `scopeGroups`) and passes
 * STRYKER_VITEST_DIR / STRYKER_INCLUDE — the SAME knobs the nightly shards use
 * — to narrow vitest discovery and keep the scoped run tractable.
 */
function runStryker(ws, mutatePatterns, extraEnv = {}, budgetMs = BUDGET_MS) {
  const wsAbs = path.join(cwd, ws);
  const mutate = `${mutatePatterns.join(',')},${MUTATE_EXCLUDES}`;
  const patchConfig = existsSync(path.join(wsAbs, PATCH_CONFIG)) ? PATCH_CONFIG : null;

  const start = Date.now();
  const first = runStrykerOnce(wsAbs, mutate, { configFile: patchConfig, extraEnv, budgetMs });

  if (patchConfig && isAllNoCoverage(first)) {
    console.warn(
      `[patch-mutation] related-scoped run found no covering tests for ` +
        `${mutatePatterns.join(', ')} — re-running on the full suite to confirm before grading.`,
    );
    return runStrykerOnce(wsAbs, mutate, {
      configFile: null,
      extraEnv,
      budgetMs: budgetMs - (Date.now() - start),
    });
  }
  return first;
}

/**
 * Turn one group's `runStryker` result into report lines + a fail verdict.
 * Pure (no Stryker, no fs), so the gate's pass/fail logic is unit-testable.
 *
 * The result is one of:
 *   { budgetExceeded: true } — ran past the PR wall-clock budget. Advisory, NOT
 *                              a failure: a slow run must never red the gate (it
 *                              used to, by letting the job time out → cancelled).
 *                              The nightly full run stays the source of truth.
 *   null                     — Stryker produced no report (infra / unmutatable
 *                              file). Advisory, NOT a failure (existing policy).
 *   score record             — enforce the threshold; fail ONLY on a real low
 *                              score with enough mutants (the fake-green catch).
 *
 * @returns {{ lines: string[], failed: boolean }}
 */
export function renderGroupResult(result, threshold, minMutants = MIN_MUTANTS, budgetMin = BUDGET_MIN) {
  if (result?.budgetExceeded) {
    return {
      failed: false,
      lines: [
        `⏱️ Mutation testing hit the ${budgetMin}-min PR budget before finishing — not enforced for ` +
          'this group. The nightly full run (`stryker-nightly.yml`) is the source of truth; this bound ' +
          'keeps a large diff from timing out and hard-cancelling the CI job.',
        '',
      ],
    };
  }
  if (!result) {
    return {
      failed: false,
      lines: [
        '⚠️ Stryker could not produce a report (infra / unmutatable file) — not enforced for this group.',
        '',
      ],
    };
  }

  const r = result;
  const enforced = r.total >= minMutants;
  const pass = r.score >= threshold;
  const mark = !enforced ? 'ℹ️' : pass ? '✅' : '❌';
  const lines = [
    `${mark} **${r.score.toFixed(1)}%** mutation on changed code ` +
      `(${r.killed + r.timeout}/${r.total} killed) — threshold ${threshold}%` +
      (enforced ? '' : ` · not enforced (<${minMutants} mutants)`),
    '',
  ];

  let failed = false;
  if (enforced && !pass) {
    failed = true;
    lines.push('Surviving mutants — a bug at these spots would NOT fail your tests:', '');
    for (const s of r.survivors.slice(0, 30)) lines.push(`- ${s}`);
    if (r.survivors.length > 30) lines.push(`- …and ${r.survivors.length - 30} more`);
    lines.push('');
  }
  return { failed, lines };
}

function main() {
  const workspaces = strykerWorkspaces();
  const changes = changedFiles();
  const floors = loadFloors();
  // Shared wall-clock deadline across ALL Stryker runs this invocation, so two
  // workspaces (or gateway scope groups) in one PR can't collectively overrun
  // the job timeout. See BUDGET_MS.
  const deadline = Date.now() + BUDGET_MS;

  const allWs = new Map();
  // Added-line ranges per target, keyed `<ws>/<relFile>` (the full repo path).
  // null = unknown (mutate the whole file); targets whose diff added no lines
  // (deletion-only) never become targets at all.
  const rangesByTarget = new Map();
  for (const ws of workspaces) {
    const prefix = `${ws}/`;
    const targets = new Set();
    for (const { file: f, ranges } of changes) {
      if (!f.startsWith(prefix)) continue;
      const rel = f.slice(prefix.length);
      if (!rel.startsWith('src/')) continue;
      for (const t of targetsForChange(f)) {
        if (Array.isArray(ranges) && ranges.length === 0) continue; // deletion-only
        const tRel = t.startsWith(prefix) ? t.slice(prefix.length) : path.relative(ws, t);
        if (tRel.startsWith('src/')) {
          targets.add(tRel);
          rangesByTarget.set(`${ws}/${tRel}`, ranges);
        }
      }
    }
    if (targets.size > 0) allWs.set(ws, [...targets].sort());
  }

  // Keep only this shard's slice of the changed files (all of them when CI did
  // not set PATCH_MUTATION_SHARD). Each file is still graded at its own
  // threshold in exactly one shard and the CI Gate ANDs the shards, so this
  // changes only WHERE a file is mutated — never WHETHER it's enforced. Balance
  // the shards by estimated mutant load: a target's changed-line count, or its
  // file length when the whole file is mutated (ranges unknown).
  const weightOf = (ws, f) => {
    const ranges = rangesByTarget.get(`${ws}/${f}`);
    let wholeFileLines = 1;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      try {
        wholeFileLines = readFileSync(path.join(cwd, ws, f), 'utf8').split('\n').length;
      } catch {
        /* unreadable — leave at 1; the target still shards, just unweighted */
      }
    }
    return targetWeight(ranges, wholeFileLines);
  };
  const byWs = shardTargets(allWs, SHARD, SHARD_MIN_TARGETS, weightOf);

  const out = ['## Patch Mutation', ''];
  if (byWs.size === 0) {
    out.push(
      SHARD
        ? `_No changed source files assigned to shard ${SHARD}. Skipping._`
        : '_No changed source files in a Stryker-configured workspace. Skipping._',
    );
    return finish(out, 0);
  }

  let failed = false;
  for (const [ws, relFiles] of byWs) {
    out.push(`### \`${ws}\``, '');

    const { groups, skipped } = scopeGroups(ws, relFiles);
    if (skipped.length > 0) {
      // Files no gateway shard mutates (thin-wrapper dirs) — reported, not gated,
      // matching the nightly which never mutates them.
      out.push(
        `_Out of mutation scope (not gated): ${skipped.map((f) => `\`${f}\``).join(', ')}_`,
        '',
      );
    }

    // Split each scope group by effective threshold so path-scoped files (e.g.
    // the money-auth core) are graded at their stricter bar, not the lax
    // workspace floor.
    const thresholdGroups = thresholdGroupsFor(ws, groups, floors, THRESHOLD);
    for (const group of thresholdGroups) {
      const threshold = group.threshold;
      const scopeNote = group.label ? ` _(scope: \`${group.label}\`)_` : '';
      // Line-scope each file to its diff (whole file only when ranges are
      // unknown) — whole-file mutation at gateway-route scale produces mutant
      // counts the PR budget can never absorb. See the header's scope mapping.
      const patterns = mutatePatternsFor(group.files, (f) =>
        rangesByTarget.get(`${ws}/${f}`) ?? null,
      );
      // Guard: a pattern that matches nothing means Stryker mutates
      // nothing and the no-report tolerance would silently pass the group.
      // Fail loudly instead — this fires only if a path contains glob-magic
      // characters escapeMutateGlob doesn't cover yet.
      const unmatched = unmatchedMutateTargets(group.files, patterns);
      if (unmatched.length > 0) {
        failed = true;
        out.push(
          `❌ mutate-pattern self-check failed — these changed files would be silently ` +
            `skipped by Stryker's glob matching: ${unmatched.map((f) => `\`${f}\``).join(', ')}. ` +
            'Extend `escapeMutateGlob` in `scripts/ci/patch-mutation.mjs`.',
          '',
        );
        continue;
      }
      out.push(
        `Mutating ${group.files.length} changed file(s)${scopeNote}: ${patterns.map((p) => `\`${p}\``).join(', ')}`,
        '',
      );

      // Pass the budget remaining on the shared deadline; an over-budget run is
      // killed by runStryker and rendered as an advisory pass, never a failure.
      const r = runStryker(ws, patterns, group.env, deadline - Date.now());
      const { lines, failed: groupFailed } = renderGroupResult(r, threshold);
      out.push(...lines);
      if (groupFailed) failed = true;
    }
  }

  return finish(out, failed ? 1 : 0);
}

function finish(lines, code) {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, text);
    } catch {
      /* summary is best-effort */
    }
  }
  process.exit(code);
}

// Run as a CLI only when invoked directly — importable for unit tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
