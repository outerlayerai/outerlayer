/* eslint-disable import/no-unused-modules -- Loaded by vitest/stryker at runtime, not via static import */
import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config for Stryker mutation testing.
 *
 * Extends the main vitest.config.ts but excludes tenant-id-enforcement.test.ts,
 * which source-scans `services/*.ts` for a TenantId predicate by reading the
 * files off disk with `readFileSync`. Under Stryker's `inPlace: true` mode the
 * files on disk ARE the instrumented copies (mutant-switch wrapping injected
 * around every expression), which mangles the inline SQL template literals the
 * scanner matches against — a false positive on unmodified, correctly-scoped
 * queries. It passes on every real run (`ci:unit`, the nightly, local dev);
 * only the on-disk-instrumented byte content under Stryker trips it.
 *
 * This is a source-scanning meta-test, not a behavior test — mutation testing
 * doesn't grade it (there's no code path for a mutant to break), so excluding
 * it here costs no coverage. Do NOT weaken the test itself; it stays exactly
 * as strict for every other test runner.
 */
export default mergeConfig(base, {
  test: {
    exclude: ['**/node_modules/**', 'src/__tests__/tenant-id-enforcement.test.ts'],
  },
});
