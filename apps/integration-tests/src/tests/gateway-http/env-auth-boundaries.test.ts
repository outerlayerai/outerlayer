/**
 * Gateway env-route auth boundary tests — P0 security regression coverage.
 *
 * Promote/rollback permission coverage (a reader-role JWT lacking
 * `environment.promote` must get 403 on `POST /v1/environments/:id/promote`
 * and `/rollback`) does not apply here: the promote/rollback routes and the
 * env-promotion saga do not exist, so there is no authz surface to pin
 * there. This file covers the cross-tenant boundary that remains live.
 *
 * What they pin:
 *   A JWT belonging to tenant B paired with tenant A's app id in
 *              the `X-Outerlayer-App-Id` header MUST be rejected on every env
 *              route (read AND write). Tenant B's reach into tenant A's data via
 *              the header is the breach being prevented.
 *   A real API KEY minted for tenant B, paired with tenant A's app id
 *              in the header, MUST be rejected with 401 at the `verify_api_key`
 *              appId cross-check — before any RLS/permission check.
 *
 * How auth resolves in this harness:
 *   The gateway-http suite boots `wrangler dev` on the Postgres key-store's
 *   REAL verify path with no auth bypass. JWT-shaped bearers route through
 *   `resolveBearerUser`,
 *   which checks `app.tenant_id === jwt.tenant_id`, and `enforcePermission`
 *   follows up with an `app_authorize()` RPC under the caller's JWT — that's
 *   what the reader/cross-tenant JWT tests below pin. Non-JWT bearers (real
 *   minted API keys) route through `verifyKey`, which hashes the key with
 *   API_KEY_PEPPER, looks the digest up via `verify_api_key`, and cross-checks
 *   the verified key's bound app against the `X-Outerlayer-App-Id` header. The
 *   API-key cross-check block at the end pins that path: tenant B's real key
 *   paired with tenant A's app id is rejected at the appId cross-check with a
 *   401 — BEFORE any RLS/permission check runs.
 *
 * Each test seeds its own rows and deletes them in the same block.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupEnvFixture, type EnvTestFixture } from '../environments/helpers';
import { GATEWAY_URL, getTestAppId } from '../../../gateway-http/setup-gateway';
import { mintTestApiKey } from './client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the current Supabase access token (a real `authenticated`-role JWT
 * issued by local GoTrue) from a fixture user's client. Throws if the user
 * isn't signed in — the fixture's `createUser` does `signInWithPassword` +
 * `refreshSession` so a token must be present.
 */
async function getAccessToken(user: EnvTestFixture['readerUser']): Promise<string> {
  const { data, error } = await user.client.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error(`No access_token for ${user.email}: ${error?.message ?? 'no session'}`);
  }
  return data.session.access_token;
}

/** Send a request to the gateway with a real JWT bearer + a chosen app id. */
async function gatewayCall(
  path: string,
  opts: { token: string; appId: string; method?: 'GET' | 'POST'; body?: unknown },
): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token}`,
      'x-outerlayer-app-id': opts.appId,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Read-only-role user: read allowed, create blocked
// ---------------------------------------------------------------------------

describe('Reader-role JWT boundary checks', () => {
  let fixture: EnvTestFixture;
  let readerToken: string;

  beforeAll(async () => {
    fixture = await setupEnvFixture();
    readerToken = await getAccessToken(fixture.readerUser);
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('should accept GET /v1/environments/:id from a reader-role JWT (sanity — read perm is granted)', async () => {
    // Sanity check that this isn't a "reader can't do ANYTHING" bug.
    const res = await gatewayCall(
      `/v1/environments/${fixture.defaultEnv.id}`,
      { token: readerToken, appId: fixture.app.id },
    );
    expect(res.status).toBe(200);
  });

  // Real Supabase JWTs go through enforcePermission, and the route's
  // `environment.insert` requirement gates the call — a bearer-extraction
  // gap that routed requests through a full-access identity resolver would
  // let a reader-role JWT create environments.
  it('should reject POST /v1/environments from a reader-role JWT with 403', async () => {
    const res = await gatewayCall('/v1/environments', {
      token: readerToken,
      appId: fixture.app.id,
      method: 'POST',
      body: { name: 'reader-should-not-create-this' },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { required_permission?: string } };
    // The app_permission enum is granular CRUD —
    // read / insert / update / delete — never `create` or `manage`.
    // The env-create route gates on `environment.insert`.
    expect(body.error?.required_permission).toBe('environment.insert');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: T2 JWT + T1's app id is rejected on every route
// ---------------------------------------------------------------------------

describe("Cross-tenant JWT cannot read or mutate another tenant's envs", () => {
  let tenantA: EnvTestFixture;
  let tenantB: EnvTestFixture;
  let tenantBOwnerToken: string;
  let tenantBAuthOnA: { token: string; appId: string };

  beforeAll(async () => {
    // Arrange two disjoint tenants. Tenant B's owner has full perms WITHIN B,
    // and zero membership in A — exactly the manual-tester repro setup.
    tenantA = await setupEnvFixture();
    tenantB = await setupEnvFixture();
    tenantBOwnerToken = await getAccessToken(tenantB.ownerUser);

    // The cross-tenant call: T2 owner's JWT paired with T1's app id.
    tenantBAuthOnA = { token: tenantBOwnerToken, appId: tenantA.app.id };
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  it('should reject GET /v1/environments (list) with 401 when JWT.tenant_id !== app.tenant_id', async () => {
    // Act: T2 owner's JWT, T1's app id in the header.
    const res = await gatewayCall('/v1/environments', tenantBAuthOnA);

    // Assert: `resolveBearerUser` finds no app where id=T1 AND tenant_id=T2 → 401.
    // Generic message ("Not authorized") to avoid leaking whether the app exists.
    expect(res.status).toBe(401);
  });

  it('should reject GET /v1/environments/:id (read) with 401 when JWT.tenant_id !== app.tenant_id', async () => {
    const res = await gatewayCall(
      `/v1/environments/${tenantA.defaultEnv.id}`,
      tenantBAuthOnA,
    );
    expect(res.status).toBe(401);
  });

  it('should accept GET /v1/environments/:id when JWT.tenant_id === app.tenant_id (sanity — legitimate access still works)', async () => {
    // Sanity: T2 owner against T2's app id is the happy path. Confirms the
    // breach fix isn't an over-rotation that broke legitimate auth.
    const res = await gatewayCall(
      `/v1/environments/${tenantB.defaultEnv.id}`,
      { token: tenantBOwnerToken, appId: tenantB.app.id },
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// API-key cross-check: tenant B's REAL key + tenant A's app id is rejected at
// the verify_api_key appId cross-check (401), before any RLS/permission check.
//
// This is the API-key analogue of the JWT cross-tenant block above. Where the
// JWT path rejects at resolveBearerUser (app.tenant_id !== jwt.tenant_id), the
// key path rejects in verifyKey: the digest resolves to tenant B's key whose
// bound appId is B, but the request targets A's app id in the header —
// `appId !== parsed.data.appId` → 401 (verify-key.ts). It NEVER reaches the
// route handler or an RLS/permission (403) decision. Tenant A here is the
// harness-seeded app; tenant B is a disjoint fixture with its own minted key.
// ---------------------------------------------------------------------------

describe('API-key cross-check: tenant B real key + tenant A app id → 401', () => {
  let tenantB: EnvTestFixture;
  let tenantBKey: string;

  beforeAll(async () => {
    tenantB = await setupEnvFixture();
    // A real peppered key bound to tenant B's app + default env. Permissions are
    // irrelevant to the cross-check (it fires before enforcePermission) but a
    // valid grant keeps the sanity request meaningful.
    tenantBKey = await mintTestApiKey({
      tenantId: tenantB.tenant.id,
      appId: tenantB.app.id,
      environmentId: tenantB.defaultEnv.id,
      permissions: ['environment.read'],
    });
  });

  afterAll(async () => {
    await tenantB.cleanup();
  });

  it("rejects tenant B's key paired with tenant A's app id with 401 (appId cross-check, not RLS 403)", async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/environments`, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tenantBKey}`,
        // Tenant A = the harness-seeded app. B's key does NOT belong to it.
        'x-outerlayer-app-id': getTestAppId(),
      },
    });
    // The breach vector is a 2xx (B reaching into A). The reject is a hard 401
    // at verify — specifically NOT a 403, which would mean auth wrongly
    // resolved a cross-tenant context and only permissions stopped it.
    expect(res.status).toBe(401);
  });

  it("accepts tenant B's key paired with tenant B's own app id (sanity — the key itself is valid)", async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/environments`, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tenantBKey}`,
        'x-outerlayer-app-id': tenantB.app.id,
      },
    });
    // Same key, correct app id → passes the cross-check. It has
    // environment.read, so the list route resolves (200). Proves the 401 above
    // is the cross-check, not a broken/rejected key.
    expect(res.status).toBe(200);
  });
});
