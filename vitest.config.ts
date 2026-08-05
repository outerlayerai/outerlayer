import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/tenant-dashboard',
      'apps/integration-tests',
      'apps/gateway',
      'apps/worker',
      'packages/worker-core',
      'scripts',
    ],
  },
});
