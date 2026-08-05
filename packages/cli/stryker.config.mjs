/* consumed by stryker CLI */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Break threshold is ratchet-managed — see scripts/ci/mutation-score-floors.json.
// null disables the break check while the baseline is established; the nightly
// records the score and the ratchet job promotes the floor.
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['packages/cli'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    related: false,
  },
  // Unlike the other workspaces' configs, this one runs sandboxed
  // (`inPlace: false`, Stryker's default): settings.ts and init.ts fall back
  // to the real `process.cwd()`/`homedir()` when a caller omits those
  // options, and only one existing test exercises the `cwd`-fallback branch.
  // A mutant on that fallback (e.g. flipping the `??`) makes the mutated code
  // ignore the test's tmp `cwd` and write a real `.claude/settings.json`
  // into the actual package directory before the assertion catches it and
  // the mutant is killed — the mutant is still correctly scored, but running
  // in-place lets that one test run leave a real file on disk. Sandboxing
  // routes every mutant's file writes into Stryker's own tmp sandbox copy
  // instead of this working tree.
  inPlace: false,
  coverageAnalysis: 'perTest',

  // See apps/gateway/stryker.config.mjs for the rationale on each lever.
  // Cold every run. Incremental mode reuses verdicts for code it believes
  // unchanged, and a shift in the reachable surface (un-exporting a symbol,
  // say) carries stale "killed" results forward — the score then reads as
  // measured when it isn't, and this score gates merges. The three files here
  // are small enough that a full run is cheap.
  incremental: false,
  ignoreStatic: true,
  mutator: {
    excludedMutations: ['StringLiteral', 'Regex', 'BlockStatement'],
  },

  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  timeoutMS: 15000,
  dryRunTimeoutMinutes: 5,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },

  // Narrow to the three files that run unattended against real user state or
  // inside Claude Code's own loop — the rest of the package is command
  // wiring (cli.ts, doctor.ts, sync-cmd.ts, …) that the patch gate already
  // reaches on any future edit, but isn't worth the whole-package mutant count
  // today.
  mutate: [
    // Dispatched synchronously from Claude Code on every hook event, with a
    // hard sub-50ms budget and an always-exit-0 contract — a silently-passing
    // test here means a broken or slow hook path on every user's machine.
    'src/hook-fast.ts',
    // Reads, merges, and writes the user's real `.claude/settings.json`. A bug
    // in the merge/removal logic corrupts hooks other tools installed there,
    // not just our own.
    'src/settings.ts',
    // Governs which transcripts a sync considers "already shipped". A bug
    // here either re-ships a user's whole history or silently drops events
    // that were never actually synced.
    'src/watermark.ts',
    // Wraps the user's own hook command and sits in its critical path. It must
    // propagate the child's exit code and stdout untouched, and write its
    // start record before spawning — a bug here breaks a blocking hook or
    // loses the only evidence a hung hook ever leaves.
    'src/hook-wrap-fast.ts',
    // Decides whether an execution completed, was killed, or vanished. A
    // misread here is a hang that never gets named, which is the whole point
    // of recording this evidence.
    'src/hook-exec-merge.ts',
    '!**/*.test.ts',
    '!**/*.spec.ts',
    '!**/*.d.ts',
  ],
};
export default config;
