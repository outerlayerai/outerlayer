import { defineConfig } from 'vitest/config';
import path from 'path';

const gatewayCoreSrc = path.resolve(__dirname, '../../packages/gateway-core/src');
// @outerlayer/session-schema entered gateway-core's RUNTIME import graph with
// the agents sync route. It ships source-entry exports and is never
// built in the integration jobs — alias it straight to source.
const sessionSchemaSrc = path.resolve(__dirname, '../../packages/session-schema/src/index.ts');
const tenantDashboardSrc = path.resolve(__dirname, '../tenant-dashboard/src');
const tenantDashboardRoot = path.resolve(__dirname, '../tenant-dashboard');
const transactionalEntry = path.resolve(__dirname, '../../packages/transactional/index.ts');

// Stub module for server-only (throws in real Next.js, needs to be no-op in tests)
const serverOnlyStub = path.resolve(__dirname, 'src/stubs/server-only.ts');

// Stub for next/headers — the real one needs a Next request scope that doesn't
// exist when a route handler is invoked directly in a test. Aliased (not
// vi.mock'd) so it applies to tenant-dashboard's `next` instance too. Also
// backs `cookies()` — the session-cookie fixture (`src/lib/session-cookie.ts`)
// loads a minted cookie jar into this same module.
const nextHeadersStub = path.resolve(__dirname, 'src/stubs/next-headers.ts');

// Stub for next/cache — `revalidatePath`/`revalidateTag` need a Next
// request/build scope that doesn't exist when a server action is invoked
// directly; actions that call them need this alias to run to completion.
const nextCacheStub = path.resolve(__dirname, 'src/stubs/next-cache.ts');

// @repo/api-schemas ships source-entry exports (packages/api-schemas/src/index.ts).
// Alias it straight to source so Vite transforms it — matching gateway-core below.
// The response-schema conformance suite imports the canonical zod schemas from here.
const apiSchemasSrc = path.resolve(__dirname, '../../packages/api-schemas/src/index.ts');

// Shared resolve aliases used by all projects — array format for reliable prefix matching
const sharedAlias = [
  { find: /^@repo\/api-schemas$/, replacement: apiSchemasSrc },
  // Resolve the extracted gateway core to its TS source so Vite transforms it
  // (extensionless relative imports throughout the package) rather than leaving
  // it to Node's native ESM loader via the node_modules symlink.
  { find: /^@repo\/gateway-core\/(.*)/, replacement: `${gatewayCoreSrc}/$1` },
  { find: '@outerlayer/session-schema', replacement: sessionSchemaSrc },
  { find: /^@repo\/gateway-core$/, replacement: `${gatewayCoreSrc}/index.ts` },
  // EE feature code (apps/tenant-dashboard/ee) — the ee/ carve.
  { find: /^@ee\/(.*)/, replacement: `${tenantDashboardRoot}/ee/$1` },
  { find: /^@\/(.*)/, replacement: `${tenantDashboardSrc}/$1` },
  { find: /^tenant-dashboard\/(.*)/, replacement: `${tenantDashboardRoot}/$1` },
  { find: '@repo/transactional', replacement: transactionalEntry },
  { find: 'server-only', replacement: serverOnlyStub },
  { find: /^next\/headers$/, replacement: nextHeadersStub },
  { find: /^next\/cache$/, replacement: nextCacheStub },
];

// Shared server.deps.inline for workspace packages with non-standard entry points
const sharedInline = [
  '@repo/transactional',
  '@outerlayer/locales',
  '@repo/shared-utils',
  'jose',
  /^@repo\//,
];

export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 35,
        branches: 25,
        functions: 35,
        lines: 35,
      },
    },
    // Local Supabase's Kong/PostgREST intermittently returns transient 502s
    // ("An invalid response was received from the upstream server") under the
    // parallel seed/RPC load these suites generate — a gateway blip. These are
    // handled at the OPERATION level by `retryOnTransientError` (src/lib/retry.ts),
    // which re-issues the specific idempotent call.
    //
    // There is deliberately NO whole-test `retry` here. A test-level retry
    // replays the entire test body — including non-idempotent seeds whose
    // cleanup only runs at the end — so a mid-test 502 orphaned a seeded row and
    // the replay then collided on it (duplicate key idx_environment_app_name_unique).
    // It also masks real races/logic bugs behind a green re-run. Transient infra
    // now surfaces honestly; wrap the offending call in `retryOnTransientError`
    // (or make the seed idempotent) if a specific 502 recurs.
    projects: [
      {
        test: {
          name: 'parallel',          environment: 'node',
          globals: true,
          setupFiles: ['./src/test-setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [
            '**/*.helpers.ts',
            '**/node_modules/**',
            // Business-behavior acceptance suites run under the dedicated
            // `acceptance` project below (the `test:acceptance` gate); keep them
            // out of `parallel` so they execute in exactly one place.
            'src/**/*.acceptance.test.ts',
            'src/tests/health-check.test.ts',
            'src/tests/traces.test.ts',
            'src/tests/clickhouse-errors.test.ts',
            'src/tests/analytics/**',
            'src/tests/billing/**',
            'src/tests/contracts/clickhouse-errors.test.ts',
            'src/tests/contracts/scores-insert.test.ts',
            'src/tests/contracts/retention-sweep.test.ts',
            'src/tests/gateway-http/**',
            'src/tests/api-keys/**',
            'src/tests/alerts/**',
            'src/tests/score-configs/**',
            'src/tests/self-host/**',
            // ClickHouse row-policy suites (security/clickhouse-*) run in the
            // `clickhouse` project, whose global-setup guarantees the container
            // + analytics_reader. The other security suites (Supabase secdef
            // grants) stay here — they need Postgres, not ClickHouse.
            'src/tests/security/clickhouse-*.test.ts',
            // Agent-sessions tenant-isolation suite reads real agent_session_summary/
            // otel_traces/agent_blobs rows — same ClickHouse-project reason as above.
            // Its sibling in this directory is a plain *.acceptance.test.ts (Supabase
            // RLS + app_authorize only), already routed by the acceptance project below.
            'src/tests/agent-sessions/agent-sessions-clickhouse.test.ts',
          ],
          testTimeout: 30000,
          server: { deps: { inline: sharedInline } },
        },
        resolve: { alias: sharedAlias },
      },
      {
        // Business-behavior acceptance suites (`*.acceptance.test.ts`): the same
        // real-local-Supabase, RLS-enforcing layer as `parallel`, but run as one
        // named gate (`test:acceptance`) so the tenancy/RBAC acceptance set is a
        // single blocking per-PR check.
        test: {
          name: 'acceptance',
          environment: 'node',
          globals: true,
          setupFiles: ['./src/test-setup.ts', './src/setup-acceptance.ts'],
          include: ['src/**/*.acceptance.test.ts'],
          // gateway-http acceptance suites need the wrangler global-setup and run
          // under the `gateway-http` project; keep them out of this Supabase-only
          // project so its glob does not run them without the gateway harness.
          // topics-tenancy touches real ClickHouse (trace_facets/trace_topic_maps
          // row policies) and dashboard-widget-data-query touches real ClickHouse
          // (otel_traces) — both run under the `clickhouse` project instead, whose
          // global-setup guarantees the container + analytics_reader.
          exclude: [
            '**/node_modules/**',
            'src/tests/gateway-http/**',
            'src/tests/topics/topics-tenancy.acceptance.test.ts',
            'src/tests/dashboards/dashboard-widget-data-query.acceptance.test.ts',
          ],
          testTimeout: 30000,
          server: { deps: { inline: sharedInline } },
        },
        resolve: { alias: sharedAlias },
      },
      {
        test: {
          name: 'clickhouse',          environment: 'node',
          globals: true,
          setupFiles: ['./src/test-setup.ts'],
          include: [
            'src/tests/health-check.test.ts',
            'src/tests/traces.test.ts',
            'src/tests/analytics/**/*.test.ts',
            'src/tests/billing/**/*.test.ts',
            // Topics tenancy acceptance: real trace_facets/trace_topic_maps row
            // policies (migration 29) + a real seeded temp_access_grant, so it
            // needs this project's container instead of the Supabase-only
            // `acceptance` project (excluded there).
            'src/tests/topics/topics-tenancy.acceptance.test.ts',
            'src/tests/contracts/clickhouse-errors.test.ts',
            'src/tests/contracts/scores-insert.test.ts',
            'src/tests/contracts/retention-sweep.test.ts',
            'src/tests/alerts/**/*.test.ts',
            'src/tests/self-host/**/*.test.ts',
            // Row-policy suites (raw-policy canary + app-path leak test) need the
            // container + analytics_reader this project's global-setup provisions.
            // Only the clickhouse-* security files — the secdef suite is Postgres.
            'src/tests/security/clickhouse-*.test.ts',
            // Agent-sessions tenant isolation on the real listSessions/getSessionDetail
            // read path plus the blob route's query — needs the same container.
            'src/tests/agent-sessions/agent-sessions-clickhouse.test.ts',
            // Widget-data query correctness: real otel_traces rows through the
            // exact AnalyticsService calls the re-pathed widget-data route makes.
            'src/tests/dashboards/dashboard-widget-data-query.acceptance.test.ts',
          ],
          testTimeout: 30000,
          fileParallelism: false,
          globalSetup: ['./clickhouse/global-setup.ts'],
          server: { deps: { inline: sharedInline } },
        },
        resolve: { alias: sharedAlias },
      },
      {
        // Gateway HTTP integration tests. Boots `wrangler dev` against local
        // Supabase + ClickHouse once (globalSetup), then runs HTTP-level
        // tests. Sequential to avoid contention on the single gateway port.
        // Longer timeout to absorb wrangler dev cold-start.
        test: {
          name: 'gateway-http',          environment: 'node',
          globals: true,
          include: [
            'src/tests/gateway-http/**/*.test.ts',
            'src/tests/api-keys/**/*.test.ts',
            'src/tests/score-configs/**/*.test.ts',
          ],
          testTimeout: 30000,
          hookTimeout: 120000,
          fileParallelism: false,
          globalSetup: ['./gateway-http/global-setup.ts'],
          server: { deps: { inline: sharedInline } },
        },
        resolve: { alias: sharedAlias },
      },
    ],
  },
});
