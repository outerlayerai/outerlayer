/* consumed by stryker CLI */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Break threshold is ratchet-managed — see scripts/ci/mutation-score-floors.json.
// null disables the break check (baseline still being established). The first
// nightly run records the score; the ratchet job promotes the floor on
// subsequent runs once a stable baseline is in place.
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['packages/entitlements'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    related: false,
  },
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
  // Single source file (resolver.ts, ~315 LOC). 5 min dry-run is generous.
  dryRunTimeoutMinutes: 5,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },

  // Mutate the resolver. Override-vs-tier precedence, type guards on the
  // dual-typed override schema, and the UNLIMITED sentinel arithmetic are
  // the high-risk parts — a silently-passing test here is how a paying tenant
  // accidentally gets a hobby-tier limit, or how an override of the wrong
  // type silently shrinks a quota. Index.ts is re-exports only.
  mutate: [
    'src/resolver.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.d.ts',
  ],
};
export default config;
