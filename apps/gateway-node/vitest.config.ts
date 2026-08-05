import { defineConfig } from 'vitest/config';

// gateway-node's tests import @repo/gateway-core source. Inline the ESM markdown
// chain so Vitest's transformer owns the graph (Node's native ESM loader rejects
// its JSON-main packages). See packages/gateway-core/vitest.config.ts.
export default defineConfig({
  test: {
    name: 'gateway-node',
    globals: true,
    environment: 'node',
    // No unit tests remain in this thin composition-root package (the in-process
    // broker that carried the only suite is gone); it's covered by the self-host
    // integration tests. Don't fail the run on an empty suite.
    passWithNoTests: true,
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 15000,
    server: {
      deps: {
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
