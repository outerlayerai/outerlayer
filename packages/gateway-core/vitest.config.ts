import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // @repo/transactional's email templates use the automatic JSX runtime (no
  // `import React` — matches gateway-core's own tsconfig `"jsx": "react-jsx"`).
  // Vite/esbuild default to the classic transform, which would emit an
  // unbound `React.createElement` reference.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      // @outerlayer/session-schema resolved from source, ships source-entry
      // exports (no built dist). See tsconfig.json paths.
      '@outerlayer/session-schema': path.resolve(
        __dirname,
        '../../packages/session-schema/src/index.ts',
      ),
    },
  },
  test: {
    name: 'gateway-core',
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-helpers/unit-test-setup.ts'],
    pool: 'forks',
    maxWorkers: process.env.CI ? undefined : 2,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    },
    server: {
      deps: {
        // Same inline set as apps/gateway: `@repo/test-msw` ships as TS source,
        // and the OSS templatedx markdown stack transitively imports JSON-main
        // packages that Node's native ESM loader rejects — inline the whole
        // chain so Vitest's transformer owns the graph. See apps/gateway's
        // vitest.config.ts for the full rationale.
        inline: [
          '@repo/test-msw',
          /[\\/]node_modules[\\/](unified|remark-[^\\/]+|rehype-[^\\/]+)[\\/]/,
          /[\\/]node_modules[\\/](micromark|micromark-[^\\/]+)[\\/]/,
          /[\\/]node_modules[\\/](mdast-util-[^\\/]+|hast-util-[^\\/]+)[\\/]/,
          /[\\/]node_modules[\\/](unist-util-[^\\/]+|vfile|vfile-[^\\/]+)[\\/]/,
          /[\\/]node_modules[\\/](parse-entities|stringify-entities)[\\/]/,
          /[\\/]node_modules[\\/](decode-named-character-reference|character-reference-invalid)[\\/]/,
          /[\\/]node_modules[\\/]character-entities(-legacy|-html4)?[\\/]/,
        ],
      },
    },
  },
});
