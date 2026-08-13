import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // @repo/gateway-core imports @repo/transactional's email templates, which use
  // the automatic JSX runtime (no `import React`). See
  // packages/gateway-core/vitest.config.ts for the same fix.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      // Redirect the CF Workers virtual module to a Node.js-compatible stub so
      // Vitest can resolve it before vi.mock() intercepts it at test time.
      'cloudflare:workers': path.resolve(__dirname, 'src/__mocks__/cloudflare-workers.ts'),
      // Resolve the extracted gateway core straight to its TS source so Vite
      // transforms it (handling extensionless relative imports throughout the
      // package). Without this it resolves through the node_modules symlink and
      // Node's native ESM loader chokes on `./system-client`-style imports.
      '@repo/gateway-core': path.resolve(__dirname, '../../packages/gateway-core/src'),
    },
  },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-helpers/unit-test-setup.ts'],
    pool: 'forks',
    maxWorkers: process.env.CI ? undefined : 2,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Exact path, not a `*.integration.test.ts` glob: src/integration/* are
    // mock-based tests that RUN IN THIS SUITE and carry real coverage — a glob
    // silently drops them (and their coverage) from the unit run. Only the
    // CH-gated suite lives outside it.
    exclude: ['src/index.test.ts', 'src/services/topics-enrichment.integration.test.ts'],
    // 5s in CI, where this suite has the machine largely to itself and a
    // stalled test should fail fast. Locally the pre-push runner starts every
    // gate at once — typecheck, lint and this suite each fan out across the
    // cores — so a CPU-bound test can exceed 5s while working perfectly. That
    // produced pre-push failures on tests that pass in 2.6s run alone. Mirrors
    // the same CI-vs-local split `maxWorkers` above already makes.
    testTimeout: process.env.CI ? 5000 : 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        // The Worker entry imports `cloudflare:workers`, so it can't load in
        // the node/unit pool — it's exercised by the workers-pool suite
        // (vitest.workers.config.mts, index.test.ts), whose coverage isn't part
        // of this unit report. Instrumenting it here just books every line as
        // uncovered. Composition-root wiring only; no branching logic to unit-test.
        'src/index.ts',
      ],
      thresholds: {
        statements: 30,
        branches: 20,
        functions: 25,
        lines: 30,
      },
    },
    server: {
      deps: {
        // `@repo/test-msw` ships as TS source and must be transformed.
        //
        // The OSS `@agentmark-ai/templatedx` markdown stack
        // (unified/remark/micromark/mdast) transitively imports the
        // JSON-main packages `character-entities` / `character-entities-legacy`
        // via `decode-named-character-reference` and `parse-entities`. On
        // Node 22+ the native ESM loader rejects their bare
        // `import 'character-entities'` because the resolved `index.json`
        // lacks an `import ... with { type: 'json' }` attribute.
        //
        // Externalized modules are loaded natively, so a deep leaf cannot be
        // fixed in isolation — the whole chain from templatedx's direct
        // markdown imports down to the JSON leaves must be inlined so
        // Vitest's transformer (which handles JSON) owns the graph.
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
