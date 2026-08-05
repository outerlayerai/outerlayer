/* consumed by stryker CLI */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Break threshold is ratchet-managed — see scripts/ci/mutation-score-floors.json.
// null disables the break check (for workspaces still establishing baseline).
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['apps/tenant-dashboard'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    // Stryker-specific vitest config excludes schema-drift tests that behave
    // differently under Stryker's test-runner process (they spawn openapi-
    // typescript via execFileSync and diff against committed types.ts; the
    // byte-diff is a Stryker-specific artifact). See vitest.stryker.config.ts
    // for the exclude list.
    configFile: 'vitest.stryker.config.ts',
    // This default config drives the nightly's source-of-truth run, which grades
    // against the FULL suite — so related-matching is off and coverage analysis
    // over every test decides each mutant's fate. The PR patch gate uses
    // stryker.config.patch.mjs (related: true) to scope the dry run to the changed
    // files' covering tests instead.
    related: false,
  },
  // inPlace skips Stryker's sandbox copy. Without this, the copy fails to
  // resolve the monorepo-root paths vitest.config.ts depends on (they're not
  // in the sandbox tree). Stryker still backs up originals to
  // .stryker-tmp/backup-*/ and restores on exit.
  inPlace: true,
  coverageAnalysis: 'perTest',
  checkers: [],

  // See apps/gateway/stryker.config.mjs for the rationale on each of
  // these performance levers.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  ignoreStatic: true,
  mutator: {
    excludedMutations: ['StringLiteral', 'Regex', 'BlockStatement'],
  },

  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  timeoutMS: 30000,
  // The dry run (initial coverage baseline) exercises the full 3,100+ unit
  // test suite. Locally this takes ~2:30 with raw vitest, longer with Stryker
  // instrumentation. Stryker's 5-minute default is tight; 15 gives headroom
  // without masking genuine hangs.
  dryRunTimeoutMinutes: 15,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },
  // Narrow to files with colocated or service-adjacent unit tests. The full
  // `src/**/*.ts` glob mutates ~3800 files — an hours-long nightly, most of
  // which is React server/client page code that Stryker's vitest runner
  // can't usefully cover. This set focuses on pure-TS business logic.
  mutate: [
    'src/config/**/*.ts',
    'src/utils/**/*.ts',
    // EE feature logic (apps/tenant-dashboard/ee) — same bar as the rest of this list.
    'ee/features/**/*.ts',
    'src/lib/analytics/**/*.ts',
    'src/lib/dashboards/**/*.ts',
    // src/lib/system and src/features hold this app's business logic —
    // same bar as any other pure-TS business logic in this list.
    'src/lib/system/**/*.ts',
    'src/features/**/*.ts',
    // Same tier: these src/lib/* subtrees hold logic that lives alongside
    // src/lib/system rather than under a feature directory.
    'src/lib/observability/**/*.ts',
    'src/lib/external-services/**/*.ts',
    'src/lib/auth/**/*.ts',
    'src/lib/environments/**/*.ts',
    // Shared registries/constants that a "use client" surface and a
    // lib/system service both need — lib/system can't import features and
    // client code can't import lib/system, so these live flat under lib/.
    'src/lib/worker-agents.ts',
    'src/lib/path-limits.ts',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
    '!src/**/*.d.ts',
    '!src/**/*.stories.ts',
    '!src/**/*.stories.tsx',
    '!src/test-helpers/**',
    '!src/**/__tests__/**',
    '!ee/**/*.test.ts',
    '!ee/**/*.test.tsx',
    '!ee/**/__tests__/**',
    // Preview-env fallback data generators. These return deterministic
    // seeded fake data on Vercel preview branches where ClickHouse isn't
    // provisioned — production hot-path code paths run the real service.
    // Mutating ~1,000 LOC of fake-data generation was bloating the
    // survivor count (mock-service.ts + mock-data.ts alone accounted for
    // ~23% of all survivors in the 2026-05-29 nightly) and pulling the
    // headline score down without any signal about real regressions.
    // The right test for the fallback is a single boundary check ("when
    // ClickHouse is absent, MockAnalyticsService is selected"), not a
    // mutation campaign on its internals.
    '!src/lib/**/mock-*.ts',
  ],
};

export default config;
