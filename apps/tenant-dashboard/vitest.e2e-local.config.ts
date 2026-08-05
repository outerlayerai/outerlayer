/**
 * Minimal Vitest config for LOCAL e2e scripts that must hit the real local
 * Supabase over real HTTP — no MSW setup files, no jsdom, no mocks.
 * Used by: scripts/dora-e2e-segmentation.e2e.ts
 *
 *   yarn vitest run --config vitest.e2e-local.config.ts
 */
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['scripts/**/*.e2e.ts'],
    globals: true,
    testTimeout: 60_000,
    // Both e2e files seed/clean the SAME local database — they must never
    // run concurrently or their fixtures race.
    fileParallelism: false,
  },
});
