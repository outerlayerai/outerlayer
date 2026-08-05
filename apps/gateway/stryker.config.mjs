import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Yarn hoists @stryker-mutator/core to the monorepo root (gateway pins it
// exactly) while vitest-runner stays workspace-local. Stryker's default
// @stryker-mutator/* glob then scans root's @stryker-mutator/ dir and never
// finds vitest-runner. Passing an absolute path to the plugin's entry lets
// Stryker load it directly regardless of where core ended up hoisted.
const vitestRunnerPath = require.resolve('@stryker-mutator/vitest-runner');

// Per-shard break threshold. The ratcheted aggregate floor (apps/gateway)
// is enforced on the COMBINED score by scripts/ci/assert-gateway-mutation-gate.mjs
// in the nightly — NOT here. Each shard reads a low STATIC catastrophe floor
// (apps/gateway:shard-floor) so a climbing aggregate floor can never break an
// intentionally-weaker shard; the aggregate gate enforces the real floor and a
// per-shard tripwire catches an isolated collapse. See combine-gateway-scores.mjs.
// Falls back to the aggregate floor when no shard-floor is set (non-sharded runs).
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
    // `dir` is the SINGLE most important knob for fitting gateway in the
    // 2 h CI timeout. Stryker's vitest-runner hardcodes
    // `coverageAnalysis: 'perTest'` (ignores the stryker config's value)
    // and the perTest data grows with (mutants × covering tests). At
    // gateway's scale (224 source files / 1,626 tests) perTest data
    // becomes too large to process post-dry-run — Stryker hangs silently
    // (stryker-mutator/stryker-js#214). `dir` passes vitest's `--dir`
    // flag, restricting test discovery and shrinking the perTest data
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

  // Performance levers — see notes on each.
  //
  // `incremental: true` reuses prior results for mutants whose covering
  // tests haven't changed. PR runs hit a warm cache (restore-keys chain
  // in the workflow falls through PR head SHA → base SHA → main) and
  // typically reuse 70–90% of mutants. The Stryker team measured 94%
  // reuse on a 1-file PR. The dry run still runs every time.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',

  // `ignoreStatic: true` skips static mutants — code that runs only at
  // module load (top-level constants, env reads, route registration,
  // logger init). These can't use perTest filtering AND require a fresh
  // worker process, so each one runs the entire ~1500-test suite. The
  // Stryker team measured 70% wall-clock reduction on their own
  // codebase. The trade is mutation-score validity for those specific
  // mutants — acceptable here because the gateway's static code is
  // dominated by infrastructure wiring (route classes, OTel init) where
  // mutating a top-level constant rarely produces a meaningful test
  // signal anyway.
  ignoreStatic: true,

  // Trim low-value mutators. StringLiteral and Regex generate huge
  // mutant counts (a single regex like `/^\d{3}$/` becomes 5+ mutants;
  // a string concatenation can become 3+) without proportional value:
  // tests rarely assert exact string content or regex internals at the
  // level needed to kill these. BlockStatement removes entire block
  // bodies, which on a TypeScript codebase often produces "compile but
  // semantically meaningless" mutants. Disabling these typically drops
  // mutant count 20–40% with negligible loss in real-defect detection.
  // Documented anti-pattern in the Stryker maintainers' own retrospectives.
  mutator: {
    excludedMutations: ['StringLiteral', 'Regex', 'BlockStatement'],
  },

  // Narrow to high-business-logic files. After the runtime-decoupling
  // extraction, the runtime-agnostic bulk (services, lib, utils, openapi
  // routes, git) lives in packages/gateway-core and is mutated by THAT
  // workspace's stryker.config.mjs + its own nightly shards. What remains here
  // is the Cloudflare shell — mostly thin Workers-API wrappers where mutation
  // tests don't catch real regressions.
  //
  // EXCEPTION: a few files in otherwise-thin-wrapper dirs hold real, high-risk
  // logic and ARE mutated by name below — storage-cap-service.ts (the
  // storage-cap enforcement that stayed with the metering path) and the
  // metering job handlers (the billing AMOUNTS sent to Stripe + the
  // storage-cap usage — a silent regression here mis-bills customers). Don't
  // trust the dir-level "wrapper" assumption without reading the file. The
  // nightly covers these via the gateway-jobs and gateway-storage-cap shards
  // (stryker-nightly.yml).
  mutate: [
    'src/services/storage-cap-service.ts',
    // Billing job handlers — see EXCEPTION note above.
    'src/jobs/stripe-meter-event-handler.tsx',
    'src/jobs/storage-metering-handler.ts',
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
  // ubuntu-latest is 4 cores. concurrency 4 saturates the runner; the
  // Stryker scheduler doesn't oversubscribe, so going higher just
  // contends for vCPUs.
  concurrency: 4,
  // The dry run exercises the full vitest suite once with perTest
  // instrumentation. Stryker's 5 min default is tight on CI; 15 mirrors
  // apps/tenant-dashboard and gives headroom without masking genuine
  // hangs.
  dryRunTimeoutMinutes: 15,
  tempDirName: '.stryker-tmp',
};
export default config;
