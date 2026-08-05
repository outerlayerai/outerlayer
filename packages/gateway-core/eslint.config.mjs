import libraryConfig from '@repo/eslint-config/library.mjs';
import supabaseTestMocksPlugin from '@repo/eslint-config/supabase-test-mocks.mjs';

// ---------------------------------------------------------------------------
// This config governs the runtime-neutral gateway core. The admin-client/RLS
// ban, the zod-from-api-schemas rule, and the Supabase-test-mock ban all exist
// for the files here (the /v1 route handlers, lib/admin-client,
// lib/system-client). Kept in lockstep with apps/gateway/eslint.config.mjs.
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
  'See src/lib/scoped-client.ts, src/lib/jwt.ts, and src/lib/system-client.ts for the designed',
  'chain. Importing lib/admin-client directly is allowlisted for lib/system-client.ts only.',
].join(' ');

const ZOD_MESSAGE =
  'Import schemas from @repo/api-schemas instead. Use z from ./_shared only for path params.';
const SUPABASE_TEST_MOCK_MESSAGE =
  'Do not add module-level Supabase mocks in gateway-core tests. Use MSW for boundary tests and app-owned seams for narrower unit tests.';

/**
 * Files permitted to import createSupabaseAdminClient directly. Target
 * (reached): system-client.ts + its test. Every other file routes through
 * resolveTenantAndScope (tenant-derivable) or createSystemAdminClient
 * (cross-tenant by design). New entries require justifying why neither fits.
 */
const ADMIN_CLIENT_ALLOWLIST = [
  'src/lib/system-client.ts',
  'src/lib/system-client.test.ts',
];

const adminClientPatterns = [
  {
    group: ['**/lib/admin-client', '**/lib/admin-client.ts'],
    message: ADMIN_CLIENT_MESSAGE,
  },
];

const zodPath = { name: 'zod', message: ZOD_MESSAGE };

export default [
  { ignores: ['node_modules/**', 'dist/**', '*.config.ts', '*.config.js', '*.config.mjs'] },
  ...libraryConfig,
  {
    // library.mjs sets parserOptions.project: true (nearest tsconfig.json), but
    // ours excludes tests — point the typed parser at the lint project instead.
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
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

  // Default: forbid imports from lib/admin-client everywhere.
  {
    rules: {
      'no-restricted-imports': ['error', { patterns: adminClientPatterns }],
    },
  },

  // /v1 OpenAPI handlers must import schemas from @repo/api-schemas,
  // not inline with zod.
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

  // Admin-client allowlist.
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
