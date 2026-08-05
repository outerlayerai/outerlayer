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
const breakThreshold = floors['packages/context-sync'];

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
  // Single source file (sync.ts, ~355 LOC). 5 min dry-run is generous.
  dryRunTimeoutMinutes: 5,
  concurrency: 4,
  thresholds: {
    high: 90,
    low: 80,
    break: breakThreshold,
  },

  // Mutate the sync algorithm's I/O orchestration — the branch/self-heal
  // decisions in computePushOutcome, the oversize/hasBlob skip guards in
  // ensureSnapshotAt, and the one-event-per-attempt bookkeeping in
  // eventFor/recordEvent are where a silent regression would corrupt the
  // context mirror or the audit ledger. index.ts and types.ts are re-exports
  // and pure type declarations — no runtime behavior to mutate.
  mutate: [
    'src/sync.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.d.ts',
  ],
};
export default config;
