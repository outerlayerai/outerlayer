import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The package's tsconfig sets jsx: "preserve" for Next's own bundler; esbuild
  // needs a transform mode to actually compile the emails' JSX for the test run.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    name: 'transactional',
    globals: true,
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    testTimeout: 5000,
  },
});
