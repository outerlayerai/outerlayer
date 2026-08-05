import path from 'path';
import { defineConfig } from 'vitest/config';

// Integration config: real ClickHouse, NO MSW setup (which blocks real HTTP
// with an error strategy). Exact file list, gated at runtime by
// RUN_CH_INTEGRATION — src/integration/* are mock-based unit tests that need
// the unit setup this config deliberately lacks, so a *.integration.test.ts
// glob would break them here. Mirrors the resolve aliases of vitest.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': path.resolve(__dirname, 'src/__mocks__/cloudflare-workers.ts'),
      '@repo/gateway-core': path.resolve(__dirname, '../../packages/gateway-core/src'),
    },
  },
  test: {
    name: 'integration',
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['src/services/topics-enrichment.integration.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
