import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'analytics-service',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    testTimeout: 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}'],
      thresholds: {
        statements: 65,
        branches: 55,
        functions: 65,
        lines: 65,
      },
    },
  },
});
