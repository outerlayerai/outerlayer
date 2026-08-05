import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const vitestRunnerPath = require.resolve('@stryker-mutator/vitest-runner');

const floorsPath = join(__dirname, '..', '..', 'scripts', 'ci', 'mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const breakThreshold = floors['packages/trace-topics'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
    related: false,
  },
  inPlace: true,
  coverageAnalysis: 'perTest',
  plugins: [vitestRunnerPath],

  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  ignoreStatic: true,
  mutator: {
    excludedMutations: ['StringLiteral', 'Regex', 'BlockStatement'],
  },

  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/*.spec.ts'],
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
