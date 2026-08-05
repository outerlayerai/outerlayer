import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    // Stub plain CSS files to empty modules — prevents "Unknown file extension .css"
    // errors from packages like @mui/x-data-grid that import their own CSS from
    // a nested node_modules copy.
    {
      name: 'stub-css',
      transform(_code: string, id: string) {
        if (id.endsWith('.css')) return { code: '', map: null };
      },
    },
  ],
  resolve: {
    // Dedupe React to prevent dual-instance errors when a workspace package
    // resolves React from its own nested node_modules instead of the root.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    alias: {
      // Force React and MUI to the single hoisted copy at the repo root. These
      // packages are deduped to one physical instance there (workspace peer deps
      // + no per-app hoisting limit), so pinning the resolver to it keeps every
      // module — including inlined workspace packages — on the same React and
      // MUI instance, avoiding dual-instance context errors in tests.
      'react': path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(__dirname, '../../node_modules/react/jsx-dev-runtime'),
      '@mui/material': path.resolve(__dirname, '../../node_modules/@mui/material'),
      '@mui/system': path.resolve(__dirname, '../../node_modules/@mui/system'),
      '@mui/lab': path.resolve(__dirname, '../../node_modules/@mui/lab'),
      '@mui/utils': path.resolve(__dirname, '../../node_modules/@mui/utils'),
      '@mui/private-theming': path.resolve(__dirname, '../../node_modules/@mui/private-theming'),
      '@mui/styled-engine': path.resolve(__dirname, '../../node_modules/@mui/styled-engine'),
      // Same single-copy pin for @iconify/react so it resolves the root React.
      '@iconify/react': path.resolve(__dirname, '../../node_modules/@iconify/react'),
      '@/': path.resolve(__dirname, './src/'),
      // Workspace packages with non-standard entry points — resolve to actual files
      '@repo/transactional': path.resolve(__dirname, '../../packages/transactional/index.ts'),
      '@outerlayer/locales': path.resolve(__dirname, '../../packages/locales/index.ts'),
      // Stub @mui/x-data-grid to prevent CSS import errors from its nested
      // node_modules copy. Tests that need DataGrid
      // components use vi.mock() to provide their own implementations.
      '@mui/x-data-grid': path.resolve(__dirname, './src/test-helpers/stubs/mui-x-data-grid.ts'),
      // Resolve `server-only` to the no-op `empty.js` that the package itself
      // ships under its `react-server` export condition. Under Next.js the
      // server build picks `empty.js`; vitest does not activate the
      // `react-server` condition, so the default `index.js` (which throws on
      // import) would otherwise fail any test whose graph reaches a
      // `import 'server-only'` module — e.g. server-only library code pulled
      // in transitively by API-route tests. This mirrors how individual
      // tests already `vi.mock('server-only')`, but applies it once at the
      // resolver so transitive imports are covered without per-file mocks.
      'server-only': path.resolve(__dirname, '../../node_modules/server-only/empty.js'),
    },
  },
  // MUI X v9's @mui/x-internals imports core-js-pure polyfills as bare DIRECTORY
  // specifiers (e.g. `core-js-pure/actual/disposable-stack`). Node's ESM loader —
  // which vitest uses for externalized node_modules — can't resolve directory
  // imports, so any test whose graph reaches the real @mui/x-* (e.g. via
  // @outerlayer/locales → @mui/x-data-grid/locales) crashes at load. Forcing Vite
  // to bundle the X chain makes Vite (which DOES resolve directories → index.js)
  // own the resolution.
  ssr: {
    noExternal: [/@mui\/x-data-grid/, /@mui\/x-date-pickers/, /@mui\/x-tree-view/, /@mui\/x-internals/, /core-js-pure/],
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
  test: {
    name: 'tenant-dashboard',
    // `node` is the default; DOM-dependent files opt into jsdom with a
    // `// @vitest-environment jsdom` docblock on line 1. Of 271 test files only
    // 77 touch the DOM (63 *.tsx components + 14 *.ts React-hook tests); the
    // other ~194 are pure logic (services, utils, lib, API routes, server
    // actions). Building a jsdom Document/Window for every file cost ~64s of
    // the ~116s coverage run — more than the tests themselves — and ~73% of
    // that was pure waste for files that never read the DOM. jsdom-everywhere
    // was the lazy default carried over from the Jest migration; the split
    // makes the cheap environment the default and the expensive one explicit.
    // A new component test that forgets the docblock fails loudly under node
    // (`document is not defined`) — caught the first run, fixed with one line.
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test-helpers/unit-test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'ee/**/*.{test,spec}.{ts,tsx}'],
    // Exact path, not a `*.integration.test.ts` glob: the routes/dashboards/
    // smtp integration-named tests are mock-based, RUN IN THIS SUITE, and
    // carry real coverage — a glob silently stops running them. Only the
    // CH+clustering-gated suite lives outside it.
    exclude: [
      '**/*.helpers.ts',
      '**/node_modules/**',
      'src/lib/analytics/topics/topics-generation.integration.test.ts',
    ],
    // 5s sat *below* this suite's legitimate p99 and caused `timed out in
    // 5000ms` flakes (never assertion failures), worst in the pre-push gate
    // where `ci:unit` oversubscribes CPU. The irreducibly-slow tests are the
    // RTL dialog tests — `userEvent` typing into controlled MUI inputs costs a
    // React re-render per keystroke (~4–6s; `delay: null` does NOT help, it's
    // the renders, not the inter-key delay) — and the codegen/manifest drift
    // tests, which carry their own explicit 30s timeouts. The pre-push
    // concurrency cap (see the `ci:unit` script) keeps those from being starved
    // further. 15s gives ~3× headroom over the 4–6s dialog baseline while still
    // failing a genuine hang. Per-test `{ timeout }` overrides remain available.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // `threads` over `forks`: the suite (271 files × 3878 tests) is dominated
    // by per-file overhead — jsdom setup + the 408-line setupFile with 23
    // `vi.mock`s re-runs for every file. Under `forks`, each file pays full
    // Node process startup + module re-import; locally `test:coverage` took
    // ~9 minutes wall and overran CI's 10-minute Unit Tests budget. Threads
    // share the V8 heap across files inside a worker — same per-file isolation
    // via VM contexts, ~4× faster wall time (8m51s → 2m22s without coverage;
    // ~3m38s with coverage). Do not switch to `forks` without re-measuring:
    // it costs roughly the whole CI budget for this job.
    pool: 'threads',
    maxWorkers: process.env.CI ? undefined : 2,
    css: {
      modules: {
        classNameStrategy: 'non-scoped',
      },
    },
    deps: {
      // Pre-bundle MUI X v9 with esbuild so its bare-directory core-js-pure imports
      // (unresolvable by Node's ESM loader that vitest uses for externalized deps)
      // are flattened into a single chunk. noExternal alone didn't force it here.
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@mui/x-data-grid',
            '@mui/x-date-pickers',
          ],
        },
      },
    },
    server: {
      deps: {
        // Inline workspace packages that need transformation (TSX entry points, etc.)
        inline: [
          '@repo/transactional',
          '@repo/test-msw',
          '@outerlayer/locales',
          '@repo/shared-utils',
          '@t3-oss/env-nextjs',
          // Inline @mui packages so Vite rewrites their React imports through our
          // dedupe aliases, preventing dual React-instance errors.
          /^@mui\//,
          /^@repo\//,
          // Milkdown (rich editor) ships ESM-only sub-packages and pulls in
          // @milkdown/prose, its own copy of prosemirror-*; inline the whole
          // scope so Vite transforms it and dedupes to a single instance,
          // mirroring the @mui treatment (dual-instance crash otherwise).
          /^@milkdown\//,
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/*.stories.{ts,tsx}',
        '**/test-helpers/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
      ],
      thresholds: {
        statements: 22,
        branches: 19,
        functions: 17,
        lines: 22,
      },
    },
  },
});
