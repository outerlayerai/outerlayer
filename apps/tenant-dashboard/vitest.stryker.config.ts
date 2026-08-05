/* eslint-disable import/no-unused-modules -- Loaded by vitest/stryker at runtime, not via static import */
import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config for Stryker mutation testing.
 *
 * Extends the main vitest.config.ts but excludes the two schema-drift tests:
 *
 *   - src/lib/api/__tests__/types-drift.test.ts
 *   - src/lib/api/__tests__/spec-drift.test.ts
 *
 * Both spawn external CLIs (openapi-typescript / openapi-typescript-spec) via
 * execFileSync and compare their output to a committed file. The CLI output
 * differs subtly when spawned from inside Stryker's test-runner process,
 * even though it matches in standalone `vitest run`. Root cause unknown.
 *
 * These tests are schema-consistency checks, not behavior tests — mutation
 * testing doesn't benefit from grading them. Excluding them lets Stryker's
 * dry run succeed on tenant-dashboard.
 */
export default mergeConfig(base, {
  test: {
    exclude: [
      '**/*.helpers.ts',
      '**/node_modules/**',
      'src/lib/api/__tests__/types-drift.test.ts',
      'src/lib/api/__tests__/spec-drift.test.ts',
    ],
  },
});
