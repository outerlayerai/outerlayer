/* consumed by stryker CLI */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Break threshold is ratchet-managed — see scripts/ci/mutation-score-floors.json.
// Absent/null disables the break check while the baseline is established.
const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['packages/ee-license'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    related: false,
  },
  inPlace: true,
  coverageAnalysis: 'perTest',

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
  dryRunTimeoutMinutes: 5,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },

  // Mutate the verifier and the self-host rules. A surviving mutant here is
  // exactly the bug class this package exists to prevent: a forged/expired
  // license validating, or an EE feature resolving open without a license.
  mutate: [
    'src/license.ts',
    'src/self-host.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.d.ts',
  ],
};
export default config;
