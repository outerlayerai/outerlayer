import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'llm-costs',
    globals: true,
    // The package is flat (cost-mapping.ts at the root), so match root-level
    // specs, not src/**.
    include: ['**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 5000,
  },
});
