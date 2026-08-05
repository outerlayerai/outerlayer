import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'path';

// Integration config: real ClickHouse + real topics-clustering container, NO
// MSW setup (which blocks real HTTP). Exact file list, gated at runtime by
// RUN_CH_INTEGRATION so normal CI skips it — other integration-named tests in
// this app are mock-based unit tests needing the unit setup this config lacks,
// so a *.integration.test.ts glob would break them here. topics-service is
// pure server logic (no React/MUI), so only the server-only alias + tsconfig
// paths are needed.
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, '../../node_modules/server-only/empty.js'),
    },
  },
  test: {
    name: 'dashboard-integration',
    environment: 'node',
    globals: true,
    include: ['src/lib/analytics/topics/topics-generation.integration.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
