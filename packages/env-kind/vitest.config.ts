import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'env-kind',
    globals: true,
    include: ['*.{test,spec}.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 5000,
  },
});
