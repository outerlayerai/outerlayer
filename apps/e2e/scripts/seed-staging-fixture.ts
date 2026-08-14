/**
 * Idempotent, staging-safe seed for the persistent staging E2E fixture.
 *
 * No spec drives this seed directly anymore (the env-switch spec died with the
 * breadcrumb env switcher — default-env-only posture), but the fixture itself
 * is still in use: the staging suite's login helper and the CD gateway
 * /v1 read probe (probe-gateway-read.ts) both authenticate as this user, and
 * the has-traces gate below keeps the fixture app's trace pages reachable.
 *
 * Defaults to the fixture (org `outerlayer-test`, app `melicent-awadhi-cyan`,
 * user `demo@agentmark.co`, envs `dev`/`staging`/`prod`).
 *
 * This script CREATES-IF-ABSENT every layer of that fixture AND reconciles the
 * fields the spec depends on when a partially- or mis-seeded
 * fixture already exists: the demo user's password, an active `owner`
 * membership, and `dev` as the app's sole default env. (Create-if-absent alone
 * is not enough — the fixture is hand-seeded and currently broken on staging,
 * so drift, not absence, is the likely starting state.) It is safe to run on
 * every deploy, never deletes, never touches rows outside this fixture, and
 * fails loudly + non-zero on any unexpected error.
 *
 * --- ClickHouse leg (onboarding-v2 setup gate) --------------------
 * Trace-family pages (including /traces, where both specs land) redirect to
 * /setup until the app has >= 1 ClickHouse trace inside the dashboard's 7-day
 * default lookback. `ensureFirstTraces` seeds one tiny GENERATION row per env
 * over the ClickHouse HTTP interface, refreshed when the newest row is older
 * than TRACE_FRESHNESS_DAYS. Gated on CLICKHOUSE_HOST (+ USER/PASSWORD/DB);
 * absent => loud skip, and the 055 spec will fail on the /setup redirect.
 *
 * --- Why direct inserts (not @repo/environments-service) --------------------
 * apps/e2e depends only on @supabase/supabase-js + @playwright/test (see
 * apps/e2e/package.json). It deliberately has no @repo/* workspace deps, so
 * EnvironmentService is not importable here without breaking the package
 * boundary + this package's `tsc -p tsconfig.json` typecheck. The
 * integration-tests helpers CAN use EnvironmentService because that app lists
 * it as a dependency. Here we mirror their direct-insert seeders instead —
 * `seedPinnedEnvironment` / `insertSagaDeploymentRow` in
 * apps/integration-tests/src/tests/environments/helpers.ts — writing the same
 * column set the service would.
 *
 * --- Why `owner` is enough for the specs ------------------------------------
 * The specs require the seed user to have `environment.read`.
 * `public.app_authorize` (02-functions-core.sql) has an owner-bypass branch:
 *     IF public.authorize(requested_permission) AND
 *        (SELECT role FROM public.membership WHERE id = v_membership_id) = 'owner'
 *     THEN RETURN true;
 * and `public.authorize` reads `public.role_permissions`, which is seeded with
 * `('owner','environment.read')` by migration
 * 20260524150001_environments_promotion_and_navigation.sql. So an `owner`
 * membership grants the permission the specs need.
 *
 * Run with: tsx apps/e2e/scripts/seed-staging-fixture.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Fixture identifiers. Defaults are the shared browser-suite fixture (org
// `outerlayer-test`, app `melicent-awadhi-cyan`, user `demo@agentmark.co`) —
// they MUST match the staging login helper. They are ALSO overridable via
// E2E_HIST_* so this same idempotent seeder can provision a SECOND, isolated
// fixture: the CD gateway read probe seeds its own dedicated user/org/app this
// way (see probe-gateway-read.ts), whose active-tenant claim never drifts
// because no human or agent ever signs in as it interactively. The override
// names MUST match the probe's defaults exactly.
// ---------------------------------------------------------------------------

const ORG_NAME = process.env.E2E_HIST_ORG ?? 'outerlayer-test';
const APP_NAME = process.env.E2E_HIST_APP ?? 'melicent-awadhi-cyan';
const USER_EMAIL = process.env.E2E_HIST_LOGIN_EMAIL ?? 'demo@agentmark.co';
const USER_NAME = process.env.E2E_HIST_USER_NAME ?? 'OuterLayer Demo';

// No default. This seeder calls `admin.updateUserById({ password })` on every
// run, so a literal here is not merely a committed credential — it also resets
// the account's password back to that literal on every deploy, silently undoing
// any out-of-band rotation. A password is also the one value a secret scanner
// cannot flag: it is low-entropy prose, so no detector fires on it.
// Fail loudly instead, before any Supabase call.
const USER_PASSWORD = requireEnv('E2E_HIST_LOGIN_PASSWORD');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required and has no default. Set it from the environment's ` +
        `secret store (CI: a repository secret; local: your shell). It must never ` +
        `be committed — this seeder resets the account password to it on every run.`,
    );
  }
  return value;
}

const DEFAULT_ENV_NAME = 'dev';
const STAGING_ENV_NAME = 'staging';
const PROD_ENV_NAME = 'prod';

// ---------------------------------------------------------------------------
// ClickHouse fixture traces (onboarding-v2 setup gate).
// ---------------------------------------------------------------------------
//
// Every trace-family page (/traces included) redirects to /setup
// until the app has >= 1 trace: the app-provider calls
// `/api/orgs/[orgName]/has-traces?appId=…`, which counts `otel_traces` rows for the
// app (any environment) inside the dashboard's DEFAULT 7-DAY lookback window
// (`getDefaultTracesStartDate`). A traceless fixture app gets bounced to
// `/setup`, so any spec landing on a trace-family page times out.
//
// This step seeds one tiny GENERATION row per fixture env over the ClickHouse
// HTTP interface (plain fetch — apps/e2e takes no @clickhouse/client dep, same
// boundary rule as the Supabase direct-inserts above). Because the gate's
// window is 7 days, "exists at all" is not enough — the row must be RECENT. We
// re-insert whenever the newest fixture trace is older than TRACE_FRESHNESS_
// DAYS, so the gate is guaranteed open for the suite that runs right after
// this seed. Old rows age out via the table's 90-day TTL.
//
// Skipped loudly (never fatal) when CLICKHOUSE_HOST is unset — but note the
// fixture app's trace pages stay gated behind /setup until these are provided.
const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST || null;
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'default';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB || 'default';

// Must stay UNDER the dashboard's 7-day default traces lookback
// (packages/observability-service/src/date-utils.ts#getDefaultTracesStartDate)
// so a row seeded at the threshold is still inside the has-traces window for
// the whole E2E run that follows.
const TRACE_FRESHNESS_DAYS = 6;

// The terms gate is NON-BLOCKING for existing agreements: TermsAgreementService
// .checkTermsStatus (lib/system/terms-agreement.ts) blocks only a user with
// ZERO agreements — any version satisfies it. So the exact version here is
// irrelevant to the login gate; the seed only needs the user to have >= 1
// agreement row. We default to the canonical version; the override exists only
// for cosmetic alignment with the deployed app.
const TERMS_VERSION = process.env.NEXT_PUBLIC_TERMS_VERSION || '2026-01-10';

// ---------------------------------------------------------------------------
// Connection config (env-driven). Fail loudly if missing.
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error(
    'Missing Supabase URL: set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL).',
  );
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY.');
}

// persistSession:false — we never want the admin client to adopt a user
// session; service_role must stay service_role so RLS-bypassing inserts work
// (mirrors getSupabaseAdmin in apps/e2e/tests/utils/test-helpers.ts).
const admin: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);

// ---------------------------------------------------------------------------
// Summary accounting — printed at the end.
// ---------------------------------------------------------------------------

type Disposition = 'created' | 'existed' | 'reconciled' | 'skipped';
const summary: Array<{ resource: string; disposition: Disposition; id?: string }> =
  [];

function record(resource: string, disposition: Disposition, id?: string): void {
  summary.push({ resource, disposition, id });
}

/** Fail loudly: wrap a Supabase error into a thrown Error with context. */
function fail(context: string, error: unknown): never {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? (error as { message: string }).message
      : String(error);
  throw new Error(`${context}: ${message}`);
}

// ---------------------------------------------------------------------------
// Step 1 — Auth user (demo@agentmark.co)
// ---------------------------------------------------------------------------
//
// Look up the user by email via listUsers (Supabase admin has no get-by-email).
// If present, reuse it untouched — do NOT recreate or reset its password. If
// absent, create it with the fixture password + email confirmed.

async function ensureAuthUser(): Promise<string> {
  // listUsers is paginated; the fixture tenant is tiny but staging is not, so
  // page through until we find the email or run out of pages.
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) fail('listUsers (finding demo user)', error);
    const found = data.users.find(
      (u) => u.email?.toLowerCase() === USER_EMAIL.toLowerCase(),
    );
    if (found) {
      // Dedicated fixture account (demo@agentmark.co / outerlayer-test /
      // melicent-awadhi-cyan are fixture-only identifiers, never a real
      // user) — enforce the exact password + email-confirmed state the specs
      // log in with. Reusing the row untouched would leave the seed unable to
      // self-heal an account created with a different password (login fails,
      // then every spec times out). Idempotent: same password on re-runs.
      const { error: updErr } = await admin.auth.admin.updateUserById(found.id, {
        password: USER_PASSWORD,
        email_confirm: true,
      });
      if (updErr) fail('reset demo user password', updErr);
      record('auth user', 'reconciled', found.id);
      return found.id;
    }
    if (data.users.length < perPage) break; // last page, not found
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: USER_EMAIL,
    password: USER_PASSWORD,
    email_confirm: true,
    user_metadata: { name: USER_NAME },
  });
  if (error) fail('createUser (demo user)', error);
  if (!data.user) throw new Error('createUser returned no user');
  record('auth user', 'created', data.user.id);
  return data.user.id;
}

// ---------------------------------------------------------------------------
// Step 2 — Profile row (public.profile, PK = auth user id)
// ---------------------------------------------------------------------------

async function ensureProfile(userId: string): Promise<void> {
  const { data: existing, error: selErr } = await admin
    .from('profile')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (selErr) fail('select profile', selErr);
  if (existing) {
    record('profile', 'existed', userId);
    return;
  }

  const { error } = await admin
    .from('profile')
    .insert({ id: userId, email: USER_EMAIL, name: USER_NAME });
  if (error) fail('insert profile', error);
  record('profile', 'created', userId);
}

// ---------------------------------------------------------------------------
// Step 3 — Terms agreement (public.terms_agreement)
// ---------------------------------------------------------------------------
//
// UNIQUE (user_id, terms_version) is the stable identifier. Create-if-absent
// scoped to (this user, current terms version).

async function ensureTermsAgreement(userId: string): Promise<void> {
  const { data: existing, error: selErr } = await admin
    .from('terms_agreement')
    .select('id')
    .eq('user_id', userId)
    .eq('terms_version', TERMS_VERSION)
    .maybeSingle();
  if (selErr) fail('select terms_agreement', selErr);
  if (existing) {
    record(`terms_agreement (${TERMS_VERSION})`, 'existed');
    return;
  }

  const { error } = await admin.from('terms_agreement').insert({
    user_id: userId,
    terms_version: TERMS_VERSION,
    agreed_at: new Date().toISOString(),
    consent_type: 'explicit',
    created_by: userId,
  });
  if (error) fail('insert terms_agreement', error);
  record(`terms_agreement (${TERMS_VERSION})`, 'created');
}

// ---------------------------------------------------------------------------
// Step 4 — Tenant / organization (public.tenant)
// ---------------------------------------------------------------------------
//
// organization_name is UNIQUE — the stable lookup key.

async function ensureTenant(userId: string): Promise<string> {
  const { data: existing, error: selErr } = await admin
    .from('tenant')
    .select('tenant_id')
    .eq('organization_name', ORG_NAME)
    .maybeSingle();
  if (selErr) fail('select tenant', selErr);
  if (existing) {
    record('tenant', 'existed', existing.tenant_id as string);
    return existing.tenant_id as string;
  }

  const { data, error } = await admin
    .from('tenant')
    .insert({
      organization_name: ORG_NAME,
      company_name: 'OuterLayer Test',
      created_by: userId,
    })
    .select('tenant_id')
    .single();
  if (error) fail('insert tenant', error);
  if (!data) throw new Error('insert tenant returned no row');
  record('tenant', 'created', data.tenant_id as string);
  return data.tenant_id as string;
}

// ---------------------------------------------------------------------------
// Step 5 — Owner membership (public.membership)
// ---------------------------------------------------------------------------
//
// UNIQUE (user_id, tenant_id) is the stable key. If a row already exists we
// leave it as-is (we do NOT downgrade/upgrade an existing role — only ensure a
// row is present). If absent, create an active OWNER membership so the user
// gets environment.read via the owner-bypass in app_authorize().

async function ensureOwnerMembership(
  userId: string,
  tenantId: string,
): Promise<void> {
  const { data: existing, error: selErr } = await admin
    .from('membership')
    .select('id, role, status')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (selErr) fail('select membership', selErr);
  if (existing) {
    // Reconcile drift: the specs need an ACTIVE OWNER membership (owner-bypass
    // grants environment.read). If a row exists with a different role/status,
    // repair it — silently reusing a non-owner / pending row would surface
    // later as a confusing 403 mid-spec, not a clear failure.
    if (existing.role !== 'owner' || existing.status !== 'active') {
      const { error: updErr } = await admin
        .from('membership')
        .update({
          role: 'owner',
          status: 'active',
          accepted_at: new Date().toISOString(),
        })
        .eq('id', existing.id as string);
      if (updErr) fail('reconcile membership to active owner', updErr);
      record(
        `membership (was role=${existing.role as string}/status=${existing.status as string} -> owner/active)`,
        'reconciled',
        existing.id as string,
      );
      return;
    }
    record('membership (role=owner, status=active)', 'existed', existing.id as string);
    return;
  }

  const { data, error } = await admin
    .from('membership')
    .insert({
      user_id: userId,
      tenant_id: tenantId,
      role: 'owner',
      status: 'active',
      accepted_at: new Date().toISOString(),
      created_by: userId,
    })
    .select('id')
    .single();
  if (error) fail('insert membership', error);
  if (!data) throw new Error('insert membership returned no row');
  record('membership (role=owner)', 'created', data.id as string);
}

// ---------------------------------------------------------------------------
// Step 6 — JWT claims (set_claim RPC): tenant_id + role=owner
// ---------------------------------------------------------------------------
//
// set_claim merges into auth.users.raw_app_meta_data. It is idempotent (the
// merge overwrites the same key with the same value), so we call it
// unconditionally — same path createTestOwnerWithOrg + the integration helpers
// take. Without these claims app_authorize()/tenant_id() can't resolve the
// tenant and every dashboard permission check 403s (the comment in
// test-helpers.ts documents this exact staging failure).

async function ensureClaims(userId: string, tenantId: string): Promise<void> {
  for (const [claim, value] of [
    ['tenant_id', tenantId],
    ['role', 'owner'],
  ] as const) {
    const { data, error } = await admin.rpc('set_claim', {
      uid: userId,
      claim,
      value,
    });
    if (error) fail(`set_claim(${claim})`, error);
    // set_claim returns 'ok' on success, 'error: access denied' otherwise.
    if (typeof data === 'string' && data.startsWith('error')) {
      throw new Error(`set_claim(${claim}) returned "${data}"`);
    }
  }
  // set_claim is an idempotent merge we enforce unconditionally — report as
  // reconciled rather than implying a fresh creation on every run.
  record('jwt claims (tenant_id + role=owner)', 'reconciled');
}

// ---------------------------------------------------------------------------
// Step 7 — Billing record (public.billing, hobby tier, PK = tenant_id)
// ---------------------------------------------------------------------------
//
// Mirrors createTestBillingRecord. Org creation in the app provisions a Stripe
// customer; the seeded fixture uses a synthetic customer id. billing.tenant_id
// IS the tenant_id (1:1) and is the table's primary key, so it's the stable key.

async function ensureBilling(tenantId: string, userId: string): Promise<void> {
  const { data: existing, error: selErr } = await admin
    .from('billing')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (selErr) fail('select billing', selErr);
  if (existing) {
    record('billing', 'existed', tenantId);
    return;
  }

  const { error } = await admin.from('billing').insert({
    tenant_id: tenantId,
    // Deterministic per-tenant so re-runs against a partially-seeded fixture
    // never collide on stripe_customer_id_key (the row is created-if-absent,
    // so this value is only ever inserted once per tenant).
    stripe_customer_id: `cus_e2e_fixture_${tenantId}`,
    stripe_subscription_id: null,
    tier_id: 'hobby',
    created_by: userId,
  });
  if (error) fail('insert billing', error);
  record('billing', 'created', tenantId);
}

// ---------------------------------------------------------------------------
// Step 8 — App (public.app)
// ---------------------------------------------------------------------------
//
// UNIQUE (tenant_id, name). The `app` table carries NO Fly columns (those moved
// onto `environment` in migration 20260526000003) — a bare app insert sets only
// identity + audit columns (matches createTestApp's comment).

async function ensureApp(tenantId: string, userId: string): Promise<string> {
  const { data: existing, error: selErr } = await admin
    .from('app')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', APP_NAME)
    .maybeSingle();
  if (selErr) fail('select app', selErr);
  if (existing) {
    record('app', 'existed', existing.id as string);
    return existing.id as string;
  }

  const { data, error } = await admin
    .from('app')
    .insert({ tenant_id: tenantId, name: APP_NAME, created_by: userId })
    .select('id')
    .single();
  if (error) fail('insert app', error);
  if (!data) throw new Error('insert app returned no row');
  record('app', 'created', data.id as string);
  return data.id as string;
}

// ---------------------------------------------------------------------------
// Step 9 — Environments (public.environment)
// ---------------------------------------------------------------------------
//
// UNIQUE (app_id, name) per env — the stable key. Three envs:
//   dev     — is_default=true, current_version=0 (environment_default_unpinned
//             CHECK requires default => current_version=0)
//   staging — non-default
//   prod    — non-default
//
// fly_app_name is left NULL on all three: the spec doesn't require a Fly app,
// the no-op-Fly default-env path leaves it NULL, and the unique index on
// fly_app_name is partial (WHERE fly_app_name IS NOT NULL), so NULL avoids any
// cross-run collision in the shared staging tenant.

interface SeededEnv {
  id: string;
  name: string;
  epoch: number;
  current_version: number;
}

async function ensureEnvironment(
  tenantId: string,
  appId: string,
  userId: string,
  name: string,
  isDefault: boolean,
): Promise<SeededEnv> {
  // For the default env: demote any OTHER env currently holding the default
  // flag FIRST, so the one-default-per-app partial unique index
  // (idx_environment_one_default_per_app WHERE is_default) is free for `name`.
  // A drifted fixture whose default is some other env would otherwise make the
  // insert/promote below fail — or leave `name` non-default, breaking the
  // default-env pin every env-scoped page resolves against. Scoped to
  // this app; at most one row can match (the partial unique index guarantees
  // it), so this never demotes more than the single current default.
  if (isDefault) {
    const { error: demoteErr } = await admin
      .from('environment')
      .update({ is_default: false })
      .eq('app_id', appId)
      .eq('is_default', true)
      .neq('name', name);
    if (demoteErr) fail(`demote other default before ${name}`, demoteErr);
  }

  const { data: existing, error: selErr } = await admin
    .from('environment')
    .select('id, name, epoch, current_version, is_default')
    .eq('app_id', appId)
    .eq('name', name)
    .maybeSingle();
  if (selErr) fail(`select environment (${name})`, selErr);
  if (existing) {
    // Reconcile drift: promote to default if it should be one and isn't
    // (other defaults already demoted above, so no unique-index conflict).
    if (isDefault && existing.is_default !== true) {
      // Reset to the no-pin state in the same update: the
      // environment_default_unpinned CHECK requires a default env to have
      // current_version=0, so a `dev` that drifted to a pinned version
      // (current_version>0 while non-default) would fail the promote without
      // this. Clearing the pin pointers keeps the default a coherent no-pin
      // env. (Identified by cubic.)
      const { error: promoteErr } = await admin
        .from('environment')
        .update({
          is_default: true,
          current_version: 0,
          current_commit_sha: null,
        })
        .eq('id', existing.id as string);
      if (promoteErr) fail(`promote ${name} to default`, promoteErr);
      record(`environment (${name}) -> default`, 'reconciled', existing.id as string);
    } else {
      record(`environment (${name})`, 'existed', existing.id as string);
    }
    return {
      id: existing.id as string,
      name: existing.name as string,
      epoch: existing.epoch as number,
      current_version: existing.current_version as number,
    };
  }

  const { data, error } = await admin
    .from('environment')
    .insert({
      tenant_id: tenantId,
      app_id: appId,
      name,
      is_default: isDefault,
      current_version: 0,
      created_by: userId,
    })
    .select('id, name, epoch, current_version')
    .single();
  if (error) fail(`insert environment (${name})`, error);
  if (!data) throw new Error(`insert environment (${name}) returned no row`);
  record(`environment (${name})`, 'created', data.id as string);
  return {
    id: data.id as string,
    name: data.name as string,
    epoch: data.epoch as number,
    current_version: data.current_version as number,
  };
}

// ---------------------------------------------------------------------------
// Step 11 — Fixture traces (onboarding-v2 has-traces gate)
// ---------------------------------------------------------------------------
//
// See the CLICKHOUSE_* constants block for the full rationale. One GENERATION
// row per fixture env, refreshed whenever the newest row is older than
// TRACE_FRESHNESS_DAYS (the gate only counts rows in its 7-day window —
// "exists" is not enough, "recent" is the contract).

/** Minimal ClickHouse HTTP-interface call: query via URL param, optional
 *  INSERT payload via body, bound params via `param_*` (never interpolated). */
async function chRequest(
  query: string,
  opts: { params?: Record<string, string>; body?: string } = {},
): Promise<string> {
  const url = new URL(CLICKHOUSE_HOST as string);
  url.searchParams.set('database', CLICKHOUSE_DB);
  url.searchParams.set('date_time_input_format', 'best_effort');
  url.searchParams.set('query', query);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    url.searchParams.set(`param_${key}`, value);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': CLICKHOUSE_USER,
      'X-ClickHouse-Key': CLICKHOUSE_PASSWORD,
    },
    body: opts.body ?? '',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `ClickHouse HTTP ${res.status} for query "${query.slice(0, 80)}…": ${text.slice(0, 500)}`,
    );
  }
  return text;
}

async function ensureFirstTraces(
  tenantId: string,
  appId: string,
): Promise<void> {
  if (!CLICKHOUSE_HOST) {
    console.warn(
      '\n[seed] ⚠️  FIXTURE TRACES SKIPPED — CLICKHOUSE_HOST is unset.\n' +
        '[seed]    The onboarding setup-gate redirects /traces -> /setup for a\n' +
        '[seed]    traceless app, so trace-page specs will FAIL until the\n' +
        '[seed]    CLICKHOUSE_HOST/USER/PASSWORD/DB env vars are provided to this seed.\n',
    );
    record('fixture traces (has-traces gate)', 'skipped');
    return;
  }

  // Freshness check, not existence check: the gate's lookback is 7 days, so a
  // stale row is as bad as no row. Bounded growth: at most one row per env per
  // TRACE_FRESHNESS_DAYS; the table TTL reaps them after 90 days.
  const countText = await chRequest(
    `SELECT count() FROM otel_traces
     WHERE TenantId = {tenantId:String} AND AppId = {appId:String}
       AND IsDeleted = 0
       AND Timestamp >= now() - INTERVAL ${TRACE_FRESHNESS_DAYS} DAY
     FORMAT TabSeparated`,
    { params: { tenantId, appId } },
  );
  const freshCount = Number(countText.trim());
  if (!Number.isFinite(freshCount)) {
    throw new Error(
      `fixture-trace freshness check returned non-numeric "${countText.trim()}"`,
    );
  }
  if (freshCount > 0) {
    record(`fixture traces (${freshCount} fresh rows)`, 'existed');
    return;
  }

  // One root GENERATION span per env. Environment is span-grain but
  // trace-uniform; the has-traces gate is app-level (any env counts), but
  // per-env rows also keep each env's /traces view non-empty after a switch.
  // Unspecified columns take the table defaults (JSONEachRow,
  // input_format_defaults_for_omitted_fields=1 is the server default).
  const now = new Date();
  const chTimestamp = now.toISOString().replace('T', ' ').replace('Z', '');
  const runId = now.getTime();
  const envNames = [DEFAULT_ENV_NAME, STAGING_ENV_NAME, PROD_ENV_NAME];
  const rows = envNames.map((envName) =>
    JSON.stringify({
      Timestamp: chTimestamp,
      TraceId: `e2e-seed-${envName}-${runId}`,
      SpanId: `e2e-seed-span-${envName}-${runId}`,
      ParentSpanId: '',
      Type: 'GENERATION',
      SpanName: 'e2e-seed-generation',
      TraceName: 'e2e-staging-seed',
      ServiceName: 'e2e-staging-seed',
      Environment: envName,
      EnvironmentVersion: 0,
      StatusCode: '1',
      Duration: 1200,
      InputTokens: 10,
      OutputTokens: 20,
      TotalTokens: 30,
      Cost: 0.0001,
      Input: 'e2e staging fixture seed input',
      Output: 'e2e staging fixture seed output',
      Model: 'gpt-4',
      UserId: 'e2e-staging-seed',
      TenantId: tenantId,
      AppId: appId,
    }),
  );
  await chRequest('INSERT INTO otel_traces FORMAT JSONEachRow', {
    body: rows.join('\n'),
  });
  record(
    `fixture traces (1 per env: ${envNames.join(', ')} @ ${chTimestamp})`,
    'created',
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[seed] Supabase URL: ${SUPABASE_URL}`);
  console.log(
    `[seed] Fixture: org="${ORG_NAME}" app="${APP_NAME}" user="${USER_EMAIL}"`,
  );

  const userId = await ensureAuthUser();
  await ensureProfile(userId);
  await ensureTermsAgreement(userId);

  const tenantId = await ensureTenant(userId);
  await ensureOwnerMembership(userId, tenantId);
  await ensureClaims(userId, tenantId);
  await ensureBilling(tenantId, userId);

  const appId = await ensureApp(tenantId, userId);

  // dev must be the app's sole default; staging + prod non-default (the
  // default-env pin is what every env-scoped page resolves against).
  await ensureEnvironment(tenantId, appId, userId, DEFAULT_ENV_NAME, true);
  await ensureEnvironment(tenantId, appId, userId, STAGING_ENV_NAME, false);
  await ensureEnvironment(tenantId, appId, userId, PROD_ENV_NAME, false);

  // Open the onboarding setup-gate: trace-family pages redirect to /setup
  // until the app has a trace inside the gate's 7-day window. Skipped loudly
  // when CLICKHOUSE_HOST is unset.
  await ensureFirstTraces(tenantId, appId);

  // --- Summary ---
  const created = summary.filter((s) => s.disposition === 'created');
  const reconciled = summary.filter((s) => s.disposition === 'reconciled');
  const existed = summary.filter((s) => s.disposition === 'existed');
  const skipped = summary.filter((s) => s.disposition === 'skipped');

  console.log('\n[seed] ----- Summary -----');
  console.log(`[seed] Created (${created.length}):`);
  for (const s of created) {
    console.log(`[seed]   + ${s.resource}${s.id ? ` (${s.id})` : ''}`);
  }
  console.log(`[seed] Reconciled (${reconciled.length}):`);
  for (const s of reconciled) {
    console.log(`[seed]   ~ ${s.resource}${s.id ? ` (${s.id})` : ''}`);
  }
  console.log(`[seed] Already present (${existed.length}):`);
  for (const s of existed) {
    console.log(`[seed]   = ${s.resource}${s.id ? ` (${s.id})` : ''}`);
  }
  console.log(`[seed] Skipped (${skipped.length}):`);
  for (const s of skipped) {
    console.log(`[seed]   ⚠ ${s.resource}${s.id ? ` (${s.id})` : ''}`);
  }
  console.log(
    `\n[seed] Fixture ready. tenant_id=${tenantId} app_id=${appId} user_id=${userId}`,
  );
}

main().catch((err) => {
  console.error('\n[seed] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
