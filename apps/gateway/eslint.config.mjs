import libraryConfig from '@repo/eslint-config/library.mjs';
import supabaseTestMocksPlugin from '@repo/eslint-config/supabase-test-mocks.mjs';

// ---------------------------------------------------------------------------
// Shared messages (reused across multiple rule blocks below)
// ---------------------------------------------------------------------------

const ADMIN_CLIENT_MESSAGE = [
  "Don't import from lib/admin-client. createSupabaseAdminClient uses the service-role key and",
  'bypasses RLS entirely — tenant isolation then depends solely on hand-written `.eq("app_id", ...)`',
  'filters, which is the failure mode we had to stop.',
  '',
  'Three sanctioned alternatives, in descending preference:',
  '',
  '1. createTenantScopedClient (from the gateway supabase module) — you have an API-key user',
  '   context with user.tenantId. This is the default for /v1/* handlers. Mints a short-lived JWT',
  '   with `role: "gateway"`; PostgREST switches into the gateway Postgres role and RLS enforces',
  '   tenant isolation at the DB.',
  '',
  '2. resolveTenantAndScope (from lib/system-client) — inbound webhook / async callback where the',
  '   tenant is derivable from a payload identifier (run_id, incident_id, ...). One admin lookup',
  '   resolves the tenant, then a scoped client takes over.',
  '',
  '3. createSystemAdminClient (from lib/system-client) — genuinely cross-tenant path (scheduled',
  '   jobs iterating all tenants, platform-level tables with no tenant_id column). Documented',
  '   escape hatch; every call site should explain why scoped doesn\'t apply.',
  '',
  'See packages/gateway-core/src/lib/scoped-client.ts, packages/gateway-core/src/lib/jwt.ts, and',
  'packages/gateway-core/src/lib/system-client.ts for the designed chain. Importing lib/admin-client',
  'directly is allowlisted for lib/system-client.ts only; the allowlist shrinks to zero.',
].join(' ');

const ZOD_MESSAGE =
  'Import schemas from @repo/api-schemas instead. Use z from ./_shared only for path params.';
const SUPABASE_TEST_MOCK_MESSAGE =
  'Do not add module-level Supabase mocks in gateway tests. Use MSW for boundary tests and app-owned seams for narrower unit tests.';

/**
 * Files that are permitted to import createSupabaseAdminClient directly.
 *
 * Target (reached): `[src/lib/system-client.ts]` and its test. Every
 * other file routes through `resolveTenantAndScope` (tenant-derivable)
 * or `createSystemAdminClient` (cross-tenant by design), both exported
 * from system-client.
 *
 * Adding a new entry here requires justifying why neither helper fits.
 * "I'm doing cross-tenant reads" → use createSystemAdminClient. "I need
 * the tenant isolation to come from one place" → use
 * resolveTenantAndScope. New direct consumers are almost never the
 * right answer.
 */
const ADMIN_CLIENT_ALLOWLIST = [
  // The single sanctioned admin-client consumer. Re-exports admin
  // capability under two narrower APIs (resolveTenantAndScope +
  // createSystemAdminClient) so every other file imports from here.
  'src/lib/system-client.ts',
  'src/lib/system-client.test.ts',
];

// ---------------------------------------------------------------------------
// Rule config
// ---------------------------------------------------------------------------

/**
 * Rule config that forbids importing the gateway's admin client factory.
 *
 * The factory lives at `packages/gateway-core/src/lib/admin-client.ts`. A single
 * glob catches it regardless of how deep the relative path is from the
 * importing file (`../lib/admin-client`, `../../lib/admin-client`, etc.),
 * so moving a file does not silently drop it out of the rule.
 *
 * Combined with zodPath (via `patterns` + `paths`) if the caller needs
 * both restrictions.
 */
const adminClientPatterns = [
  {
    group: ['**/lib/admin-client', '**/lib/admin-client.ts'],
    message: ADMIN_CLIENT_MESSAGE,
  },
];

const zodPath = { name: 'zod', message: ZOD_MESSAGE };

export default [
  { ignores: ['node_modules/**', 'dist/**', '*.config.ts', '*.config.js'] },
  ...libraryConfig,
  {
    languageOptions: {
      globals: {
        BodyInit: 'readonly',
        ResponseInit: 'readonly',
        RequestInit: 'readonly',
        WebSocketPair: 'readonly',
      },
    },
    rules: {
      'import/no-unused-modules': 'off',
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // Default: forbid imports from lib/admin-client everywhere. Overridden
  // for allowlisted files and for files that ALSO have the zod
  // restriction (so both rules apply).
  // ─────────────────────────────────────────────────────────────────────
  {
    rules: {
      'no-restricted-imports': ['error', { patterns: adminClientPatterns }],
    },
  },

  // /v1 OpenAPI handlers must import schemas from @repo/api-schemas,
  // not inline with zod. Admin-client pattern applies uniformly — these
  // handlers all have user context and must use createTenantScopedClient.
  {
    files: [
      'src/openapi/routes/spans.ts',
      'src/openapi/routes/sessions.ts',
      'src/openapi/routes/scores.ts',
      'src/openapi/routes/metrics.ts',
      'src/openapi/routes/traces.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [zodPath], patterns: adminClientPatterns },
      ],
    },
  },

  // Admin-client allowlist (see block comment on ADMIN_CLIENT_ALLOWLIST).
  // Turning the rule off for these files permits the import; nothing
  // else the rule guards is affected because these files are not in
  // the zod-restricted list.
  {
    files: ADMIN_CLIENT_ALLOWLIST,
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    plugins: {
      '@repo/supabase-test-mocks': supabaseTestMocksPlugin,
    },
    rules: {
      '@repo/supabase-test-mocks/no-supabase-test-mocks': [
        'error',
        { message: SUPABASE_TEST_MOCK_MESSAGE },
      ],
    },
  },
];
