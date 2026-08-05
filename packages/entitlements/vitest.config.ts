import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'entitlements',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    testTimeout: 5000,
  },
});
