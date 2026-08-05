/**
 * Post-deploy gateway /v1 READ probe.
 *
 * Why this exists: a ClickHouse reader-credential activation can deploy the
 * staging gateway with a reader var whose password secret does not exist yet,
 * so every gateway /v1 ClickHouse read (/v1/spans, /v1/scores, …) returns 500
 * — while the post-deploy staging e2e suite runs GREEN, because the browser
 * suite drives the dashboard UI whose analytics reads use the dashboard's OWN
 * ClickHouse credential path, never the gateway's. This probe closes that gap:
 * two authenticated reads against the
 * deployed gateway that traverse, in one request each, the auth middleware,
 * the API-key store (pepper + verify_api_key RPC), the ClickHouse reader
 * identity, row-policy scoping, and ClickHouse connectivity.
 *
 * Why a DEDICATED probe user: the probe authenticates as its own fixture
 * (org `agentmark-cd-probe`, user `cd-probe@agentmark.co`) that no human or
 * agent ever signs in as interactively. `app_metadata.tenant_id` is a user's
 * ACTIVE org and flips whenever someone signs in and creates/switches an org —
 * so a SHARED fixture (the browser-suite `demo@agentmark.co`) would carry a
 * real user session's tenant into a fresh probe sign-in and the gateway would
 * (correctly) 401 a wrong-tenant app id, flapping the deploy. A user nobody
 * logs into interactively cannot drift, removing that class. The
 * deploy-staging job seeds this fixture (seed-staging-fixture.ts, parameterized
 * via E2E_HIST_*) in the step immediately before this probe.
 *
 * What it does (fails the process — and the deploy job — on any non-2xx):
 *   1. Signs in the dedicated probe fixture user (seeded just before this step;
 *      this script never creates users/apps), resolves the fixture tenant by
 *      org name and the app scoped to that tenant, and asserts the JWT's
 *      active-tenant claim matches (a mismatch means the "nobody signs in as
 *      this user" invariant was violated — fail loudly rather than heal).
 *   2. Deletes any stale probe key left by a previous crashed run, then has
 *      the GATEWAY mint a fresh read-only API key (POST /v1/api-keys with the
 *      user's bearer JWT). Minting through the gateway — rather than writing
 *      the key-store directly — means the probe needs NO API_KEY_PEPPER
 *      secret in CI and additionally proves the deployed worker's pepper and
 *      key-store RPCs agree.
 *   3. GETs /v1/spans?limit=1 and /v1/scores?limit=1 with that key and
 *      asserts HTTP 200 + a JSON `data` array. An empty array is a PASS —
 *      the probe asserts the read PATH works, not that data exists.
 *   4. Deletes the probe key (best-effort; step 2 self-heals leftovers).
 *
 * Required env:
 *   E2E_GATEWAY_URL            deployed gateway (e.g. https://api-stg.agentmark.co)
 *   NEXT_PUBLIC_SUPABASE_URL   staging Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY  staging service-role key (app-id lookup +
 *                              GoTrue apikey for the password sign-in)
 * Optional (defaults are the dedicated probe fixture; the deploy-staging seed
 * step passes the SAME values to seed-staging-fixture.ts via these vars):
 *   E2E_HIST_APP / E2E_HIST_ORG / E2E_HIST_LOGIN_EMAIL / E2E_HIST_LOGIN_PASSWORD
 *
 * Run with: tsx apps/e2e/scripts/probe-gateway-read.ts
 */

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Config — the dedicated probe fixture (see the "Why a DEDICATED probe user"
// note above). These defaults MUST match the E2E_HIST_* values the
// deploy-staging seed step passes to seed-staging-fixture.ts.
// ---------------------------------------------------------------------------

const GATEWAY_URL = (
  process.env.E2E_GATEWAY_URL ?? 'https://api-stg.agentmark.co'
).replace(/\/+$/, '');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_NAME = process.env.E2E_HIST_APP ?? 'cd-probe-app';
const ORG_NAME = process.env.E2E_HIST_ORG ?? 'agentmark-cd-probe';
const USER_EMAIL = process.env.E2E_HIST_LOGIN_EMAIL ?? 'cd-probe@agentmark.co';
// No default — see the matching note in seed-staging-fixture.ts. A committed
// password is invisible to secret scanning (low entropy) and this probe signs
// in as a real staging account that can mint a gateway API key.
const USER_PASSWORD = process.env.E2E_HIST_LOGIN_PASSWORD;

// Fixed name so a crashed run's leftover key is found and replaced next run
// (api_key has a UNIQUE (name, app_id) constraint — a stale key would 409 the
// mint forever if we never cleaned it up).
const PROBE_KEY_NAME = 'cd-gateway-read-probe';

// The read endpoints under test + retry budget for transient (network/5xx
// blip) noise. The incident this guards against is a PERSISTENT 500, so a
// couple of short retries cannot mask it — they only stop a one-off blip from
// flagging a healthy deploy.
const READ_ENDPOINTS = ['/v1/spans?limit=1', '/v1/scores?limit=1'] as const;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

function fatal(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!SUPABASE_URL) fatal('NEXT_PUBLIC_SUPABASE_URL is not set');
if (!SERVICE_ROLE_KEY) fatal('SUPABASE_SERVICE_ROLE_KEY is not set');
if (!USER_PASSWORD) fatal('E2E_HIST_LOGIN_PASSWORD is not set (no default by design)');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Gateway fetch helper — returns status + parsed body, never throws on HTTP
// errors (callers assert on status so failures print the gateway's actual
// error envelope, the single most useful diagnostic).
// ---------------------------------------------------------------------------

interface GatewayResponse {
  status: number;
  body: unknown;
}

async function gatewayFetch(params: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  token: string;
  appId: string;
  jsonBody?: unknown;
}): Promise<GatewayResponse> {
  const { method, path, token, appId, jsonBody } = params;
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Outerlayer-App-Id': appId,
      ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  });
  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- 1. Resolve the fixture app + a user JWT ------------------------------
  // Two clients on purpose: signing in mutates a client's auth state, so the
  // admin (service-role) client must never be the one that calls
  // signInWithPassword (see the RLS signIn-pollution incident).
  const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const authClient = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signIn, error: signInErr } =
    await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      // Non-null: guarded at module load alongside SUPABASE_URL/SERVICE_ROLE_KEY.
      password: USER_PASSWORD!,
    });
  if (signInErr || !signIn.session) {
    fatal(
      `sign-in as fixture user ${USER_EMAIL} failed: ${signInErr?.message ?? 'no session'}`,
    );
  }
  const jwt = signIn.session.access_token;
  const jwtTenant = (
    signIn.user?.app_metadata as { tenant_id?: string } | undefined
  )?.tenant_id;

  // Resolve the fixture tenant by organization_name (UNIQUE) — never by the
  // user's claim — so the app lookup below can be tenant-scoped.
  const { data: tenant, error: tenantErr } = await admin
    .from('tenant')
    .select('tenant_id')
    .eq('organization_name', ORG_NAME)
    .single();
  if (tenantErr || !tenant) {
    fatal(
      `fixture tenant "${ORG_NAME}" not found (did the deploy-staging seed step run seed-staging-fixture.ts?): ${tenantErr?.message ?? 'no row'}`,
    );
  }
  const fixtureTenantId = tenant.tenant_id as string;

  // Invariant: this is a DEDICATED probe user nobody signs in as interactively,
  // so its active-tenant claim (minted at the sign-in above) must already equal
  // the tenant the seed pinned. app_metadata.tenant_id only flips when someone
  // signs in as the user and switches/creates an org — so a mismatch means the
  // "nobody logs in as the probe user" contract was broken. Fail loudly instead
  // of silently healing: a shared, self-healing fixture is exactly the ambient
  // mutable state a dedicated user exists to eliminate.
  if (jwtTenant !== fixtureTenantId) {
    fatal(
      `probe user's active-tenant claim is ${jwtTenant ?? 'unset'}, expected ${fixtureTenantId}: ` +
        `the dedicated fixture ${USER_EMAIL} was signed into interactively and its claim drifted. ` +
        'Re-run the deploy-staging seed step (it re-pins the claim) and stop using this user for anything but the probe.',
    );
  }

  // Resolve the fixture app SCOPED TO THE FIXTURE TENANT. The service role
  // sees every tenant, and e2e suites create fixture-named apps in their own
  // throwaway tenants — an unscoped by-name lookup can resolve a same-named
  // app the fixture user has no membership in, and the gateway then answers
  // a correct (but baffling) 401 for the whole probe.
  const { data: app, error: appErr } = await admin
    .from('app')
    .select('id')
    .eq('name', APP_NAME)
    .eq('tenant_id', fixtureTenantId)
    .single();
  if (appErr || !app) {
    fatal(
      `fixture app "${APP_NAME}" not found in tenant ${fixtureTenantId} (has seed-staging-fixture.ts ever run?): ${appErr?.message ?? 'no row'}`,
    );
  }
  const appId = app.id as string;
  console.log(`✓ signed in as ${USER_EMAIL} (tenant ${fixtureTenantId}); fixture app ${appId}`);

  // --- 2. Replace any stale probe key, then mint a fresh one ----------------
  // This is the FIRST authenticated request the fresh deployment serves (the
  // health gate only hits /health, which does no auth). verify-bearer fails
  // CLOSED to 401 when its cold-isolate Supabase lookups hiccup, so a single
  // shot conflates "auth is broken" with "first request raced the cold
  // start". Retry a bounded number of times, logging every response — the
  // attempt pattern in the CD log is the diagnostic: fails-then-passes means
  // cold start; all-fail means the deployment is genuinely broken (and the
  // auto-rollback that follows is correct).
  const LIST_ATTEMPTS = 3;
  const LIST_RETRY_DELAY_MS = 10_000;
  let list: GatewayResponse | undefined;
  for (let attempt = 1; attempt <= LIST_ATTEMPTS; attempt++) {
    list = await gatewayFetch({
      method: 'GET',
      path: '/v1/api-keys?limit=100',
      token: jwt,
      appId,
    });
    if (list.status === 200) {
      if (attempt > 1) {
        console.log(
          `✓ GET /v1/api-keys recovered on attempt ${attempt}/${LIST_ATTEMPTS} — first-request cold-start race, not an auth regression`,
        );
      }
      break;
    }
    console.log(
      `✗ GET /v1/api-keys attempt ${attempt}/${LIST_ATTEMPTS} → HTTP ${list.status}: ${JSON.stringify(list.body)}`,
    );
    if (attempt < LIST_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, LIST_RETRY_DELAY_MS));
    }
  }
  if (!list || list.status !== 200) {
    fatal(
      `GET /v1/api-keys → HTTP ${list?.status} after ${LIST_ATTEMPTS} attempts over ${((LIST_ATTEMPTS - 1) * LIST_RETRY_DELAY_MS) / 1000}s (expected 200): ${JSON.stringify(list?.body)}`,
    );
  }
  const keys = (list.body as { data?: Array<{ id: string; name: string }> })
    .data;
  for (const stale of (keys ?? []).filter((k) => k.name === PROBE_KEY_NAME)) {
    const del = await gatewayFetch({
      method: 'DELETE',
      path: `/v1/api-keys/${stale.id}`,
      token: jwt,
      appId,
    });
    if (del.status < 200 || del.status >= 300) {
      fatal(
        `DELETE stale probe key ${stale.id} → HTTP ${del.status}: ${JSON.stringify(del.body)}`,
      );
    }
    console.log(`✓ deleted stale probe key ${stale.id}`);
  }

  const create = await gatewayFetch({
    method: 'POST',
    path: '/v1/api-keys',
    token: jwt,
    appId,
    jsonBody: {
      name: PROBE_KEY_NAME,
      app_id: appId,
      permissions: ['span.read', 'score.read'],
    },
  });
  if (create.status !== 201) {
    fatal(
      `POST /v1/api-keys → HTTP ${create.status} (expected 201): ${JSON.stringify(create.body)}`,
    );
  }
  const created = (
    create.body as { data: { id: string; plaintext_key: string } }
  ).data;
  console.log(`✓ minted read-only probe key ${created.id}`);

  // --- 3. Probe the /v1 read surface with the minted key --------------------
  let failure: string | null = null;
  for (const endpoint of READ_ENDPOINTS) {
    let last: GatewayResponse | { status: 'network-error'; body: string } = {
      status: 'network-error',
      body: 'not attempted',
    };
    let passed = false;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const res = await gatewayFetch({
          method: 'GET',
          path: endpoint,
          token: created.plaintext_key,
          appId,
        });
        last = res;
        const data = (res.body as { data?: unknown } | null)?.data;
        if (res.status === 200 && Array.isArray(data)) {
          console.log(
            `✓ GET ${endpoint} → 200, data[] length ${data.length} (attempt ${attempt})`,
          );
          passed = true;
          break;
        }
      } catch (err) {
        last = { status: 'network-error', body: String(err) };
      }
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
    if (!passed) {
      failure = `GET ${endpoint} failed after ${ATTEMPTS} attempts — last: HTTP ${last.status}, body ${JSON.stringify(last.body)}`;
      break;
    }
  }

  // --- 4. Cleanup (best-effort — step 2 self-heals leftovers) ---------------
  const cleanup = await gatewayFetch({
    method: 'DELETE',
    path: `/v1/api-keys/${created.id}`,
    token: jwt,
    appId,
  }).catch((err) => ({ status: 0, body: String(err) }) as GatewayResponse);
  if (cleanup.status >= 200 && cleanup.status < 300) {
    console.log(`✓ deleted probe key ${created.id}`);
  } else {
    console.warn(
      `⚠ could not delete probe key ${created.id} (HTTP ${cleanup.status}) — next run replaces it by name`,
    );
  }

  if (failure) {
    fatal(
      `${failure}\nThe deployed gateway cannot serve /v1 ClickHouse reads — ` +
        'check CLICKHOUSE_* vars/secrets on the worker.',
    );
  }
  console.log('✓ gateway /v1 read probe passed');
}

main().catch((err) => {
  fatal(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
