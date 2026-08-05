/* consumed by stryker CLI */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Break threshold is ratchet-managed — see scripts/ci/mutation-score-floors.json.
// null disables the break check (for workspaces still establishing baseline).
// First nightly run will produce an initial score; ratchet job promotes the
// floor to (baseline - small margin) on subsequent runs.
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['packages/api-key-service'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    // Disable vitest's related-files matching — same rationale as the
    // gateway and tenant-dashboard configs. The runner falls through to
    // coverage-analysis-driven test selection, which is correct.
    related: false,
  },
  // inPlace avoids Stryker's sandbox copy. The package's vitest.config.ts is
  // self-contained, so this is more about consistency with the other workspace
  // stryker configs than strict necessity.
  inPlace: true,
  coverageAnalysis: 'perTest',

  // See apps/gateway/stryker.config.mjs for the rationale on each lever.
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
  timeoutMS: 15000,
  // Tiny package (2 source files, ~20 tests). 5 min dry-run is generous.
  dryRunTimeoutMinutes: 5,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },

  // Mutate the security-critical primitives this package owns — Unkey key
  // creation + metadata builder. Skip `index.ts` (pure re-exports — every
  // mutation produces a compile error or no behavior change, polluting the
  // score with low-signal mutants).
  mutate: [
    'src/crypto.ts',
    'src/mint-key.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.d.ts',
  ],
};
export default config;
