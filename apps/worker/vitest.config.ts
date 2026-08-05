import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    passWithNoTests: true,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/__fixtures__/**'],
    },
  },
});
