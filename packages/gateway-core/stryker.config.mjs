import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Yarn hoists @stryker-mutator/core to the monorepo root (gateway-core pins it
// exactly) while vitest-runner stays workspace-local. Stryker's default
// @stryker-mutator/* glob then scans root's @stryker-mutator/ dir and never
// finds vitest-runner. Passing an absolute path to the plugin's entry lets
// Stryker load it directly regardless of where core ended up hoisted.
const vitestRunnerPath = require.resolve('@stryker-mutator/vitest-runner');

// Per-shard break threshold. gateway-core shards combine with apps/gateway's
// shell shards into ONE gateway score (combine-gateway-scores.mjs globs
// score-gateway-*), so the ratcheted aggregate floor (apps/gateway) is enforced
// on the COMBINED score by scripts/ci/assert-gateway-mutation-gate.mjs — NOT
// here. Each shard reads the same low STATIC catastrophe floor
// (apps/gateway:shard-floor) so a climbing aggregate floor can never break an
// intentionally-weaker shard. Falls back to the aggregate floor when no
// shard-floor is set (non-sharded runs).
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['apps/gateway:shard-floor'] ?? floors['apps/gateway'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    // Use vitest.stryker.config.ts because the base vitest.config.ts has
    // an absolute-rooted include glob (`src/**/*.test.ts`) which breaks
    // when Stryker sets `dir: 'src/<shard>'`. The stryker config has a
    // dir-relative include so tests resolve correctly. See that file
    // for full notes.
    configFile: 'vitest.stryker.config.ts',
    // This default config drives the nightly's source-of-truth run, which grades
    // against the FULL suite — so related-matching is off and coverage analysis
    // over every test decides each mutant's fate. The PR patch gate uses
    // stryker.config.patch.mjs (related: true) to scope the dry run to the changed
    // files' covering tests instead.
    related: false,
    // `dir` is the SINGLE most important knob for fitting gateway-core in the
    // CI timeout. Stryker's vitest-runner hardcodes
    // `coverageAnalysis: 'perTest'` (ignores the stryker config's value)
    // and the perTest data grows with (mutants × covering tests). At
    // gateway-core's scale (~180 source files / ~118 test files) perTest data
    // becomes too large to process post-dry-run — Stryker hangs silently
    // (stryker-mutator/stryker-js#214). `dir` passes vitest's `dir`
    // option, restricting test discovery and shrinking the perTest data
    // proportionally. Shards in stryker-nightly.yml set STRYKER_VITEST_DIR
    // to the source directory whose tests cover the shard's mutate scope
    // (`src/services` for the services shard, `src/openapi` for routes,
    // etc.). Local runs without that env var fall through to undefined
    // (vitest's default: discover all tests).
    ...(process.env.STRYKER_VITEST_DIR ? { dir: process.env.STRYKER_VITEST_DIR } : {}),
  },
  // Without sandboxing, Stryker runs in place. This avoids Stryker copying
  // the workspace to .stryker-tmp/sandbox-*/ and then failing to resolve the
  // monorepo-root paths that vitest.config.ts depends on. Stryker still backs
  // up originals to .stryker-tmp/backup-*/ and restores on exit.
  inPlace: true,
  coverageAnalysis: 'perTest',
  plugins: [vitestRunnerPath],

  // Performance levers — see the fuller notes in apps/gateway/stryker.config.mjs.
  // `incremental` reuses prior results for unchanged mutants; `ignoreStatic`
  // skips module-load-only mutants that each need a fresh full-suite worker.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  ignoreStatic: true,

  // Trim low-value mutators (StringLiteral / Regex / BlockStatement) that
  // generate huge mutant counts without proportional test signal. See the
  // apps/gateway config for the rationale.
  mutator: {
    excludedMutations: ['StringLiteral', 'Regex', 'BlockStatement'],
  },

  // Narrow to high-business-logic files. gateway-core holds the runtime-
  // agnostic bulk of the gateway: services, lib, utils, the openapi route
  // handlers, and crypto.ts (token encryption — the only file in git/ with
  // real logic to mutate). stores/, policies/,
  // types/, and the runtime/ DI interfaces are thin shape-only modules where
  // mutation testing doesn't catch real regressions. The nightly shards this
  // scope across services / lib / utils / openapi-route / git jobs
  // (stryker-nightly.yml); the storage-cap service + queues / jobs that
  // stayed in apps/gateway are mutated by that workspace's own shards.
  mutate: [
    'src/lib/**/*.ts',
    'src/services/**/*.ts',
    'src/utils.ts',
    'src/utils/**/*.ts',
    'src/openapi/routes/**/*.ts',
    'src/git/crypto.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
  ],

  reporters: ['html', 'clear-text', 'progress', 'json'],
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },
  timeoutMS: 60000,
  concurrency: 4,
  dryRunTimeoutMinutes: 15,
  tempDirName: '.stryker-tmp',
};
export default config;
