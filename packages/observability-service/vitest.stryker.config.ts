/* eslint-disable import/no-unused-modules -- Loaded by vitest/stryker at runtime, not via static import */
import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config for Stryker mutation testing.
 *
 * Extends the main vitest.config.ts but excludes tenant-id-source-scan.test.ts,
 * which source-scans `services/*.ts` for a TenantId predicate by reading the
 * files off disk with `readFileSync`. Under Stryker's `inPlace: true` mode the
 * files on disk ARE the instrumented copies (mutant-switch wrapping injected
 * around every expression), which mangles the inline SQL template literals the
 * scanner matches against — a false positive on unmodified, correctly-scoped
 * queries. It passes on every real run (`ci:unit`, the nightly, local dev);
 * only the on-disk-instrumented byte content under Stryker trips it.
 *
 * The exclusion is exactly the source-scanning file and nothing more: the
 * builder-invoking TenantId suites (tenant-id-enforcement.test.ts) work on
 * imported values, so they run under Stryker and kill mutants that drop a
 * tenant predicate from emitted SQL. Do NOT widen this exclusion.
 */
export default mergeConfig(base, {
  test: {
    exclude: ['**/node_modules/**', 'src/__tests__/tenant-id-source-scan.test.ts'],
  },
});
