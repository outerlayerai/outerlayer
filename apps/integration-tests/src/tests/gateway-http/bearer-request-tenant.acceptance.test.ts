/**
 * Acceptance: the gateway bearer path honors an explicit, membership-validated
 * request tenant.
 *
 * Driven end-to-end through the real HTTP boundary (`wrangler dev` on the
 * Postgres key-store's real verify path — no auth bypass). A user who belongs
 * to TWO tenants signs in; their session JWT carries tenant A as the embedded
 * "active tenant" claim. Each test sends a real `Authorization: Bearer <jwt>`
 * and varies the `X-Tenant-Id` header, then asserts the OBSERVABLE outcome:
 * which tenant the action actually landed in / whether it was denied. The
 * header/claim wiring is setup; the tenant a row ends up in is the assertion.
 *
 * The case that matters most is the wrong-tenant write: a first-create with the
 * claim naming A but the header naming B must create the app in B, not A —
 * the exact class a stale session-global claim caused for a multi-org user.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { retryOnTransientError } from '../../lib/retry';
import { GATEWAY_URL } from '../../../gateway-http/setup-gateway';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// ---------------------------------------------------------------------------
// A single user who owns two disjoint tenants.
//
// The JWT claim ("active tenant") is A; the user is an active owner in BOTH A
// and B. That makes A the claim source and B the header source, so every test
// below is unambiguous about which one drove the outcome — and RLS allows the
// write in either, so a landed row proves the SCOPE followed the header, not a
// missing permission.
// ---------------------------------------------------------------------------

interface TwoOrgOwner {
  userId: string;
  token: string;
  tenantAId: string;
  tenantBId: string;
  client: SupabaseClient;
  cleanup: () => Promise<void>;
}

async function seedTenant(
  admin: SupabaseClient,
  createdBy: string,
  rid: string,
): Promise<string> {
  const tenantId = randomUUID();
  const { error } = await retryOnTransientError(() =>
    admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `bearer-tenant-${rid}`,
      organization_name: `bearer-org-${rid}`,
      created_by: createdBy,
    }),
  );
  if (error) throw new Error(`Tenant create: ${error.message}`);
  return tenantId;
}

async function addOwnerMembership(
  admin: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<void> {
  const { error } = await retryOnTransientError(() =>
    admin.from('membership').insert({
      user_id: userId,
      tenant_id: tenantId,
      role: 'owner',
      status: 'active',
    }),
  );
  if (error) throw new Error(`Membership create: ${error.message}`);
}

async function createTwoOrgOwner(): Promise<TwoOrgOwner> {
  const admin = createSupabaseAdminClient();
  const rid = Math.random().toString(36).substring(2, 8);
  const email = `two-org-${Date.now()}-${rid}@bearer-tenant.test`;
  const password = 'TestPassword123!';

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData?.user) throw new Error(`Auth user create: ${authError?.message}`);
  const userId = authData.user.id;

  const { error: profileError } = await retryOnTransientError(() =>
    admin.from('profile').insert({ id: userId, name: `Two-org ${rid}`, email }),
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  const tenantAId = await seedTenant(admin, userId, `a-${rid}`);
  const tenantBId = await seedTenant(admin, userId, `b-${rid}`);
  await addOwnerMembership(admin, userId, tenantAId);
  await addOwnerMembership(admin, userId, tenantBId);

  // The session-global "active tenant" claim the JWT carries is A. The header
  // path never reads it; the no-header path falls back to it.
  await admin.rpc('set_claim', { claim: 'tenant_id', uid: userId, value: tenantAId });
  await admin.rpc('set_claim', { claim: 'role', uid: userId, value: 'owner' });

  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();
  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('No access token after sign-in');

  const cleanup = async () => {
    for (const tenantId of [tenantAId, tenantBId]) {
      await admin.from('app').delete().eq('tenant_id', tenantId);
      await admin.from('membership').delete().eq('tenant_id', tenantId);
      await admin.from('tenant').delete().eq('tenant_id', tenantId);
    }
    await admin.from('profile').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);
  };

  return { userId, token, tenantAId, tenantBId, client, cleanup };
}

/** POST /v1/apps as a bearer caller, optionally carrying an explicit tenant. */
async function createApp(opts: {
  token: string;
  name: string;
  requestTenantId?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.token}`,
  };
  if (opts.requestTenantId !== undefined) headers['x-tenant-id'] = opts.requestTenantId;
  return fetch(`${GATEWAY_URL}/v1/apps`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: opts.name }),
  });
}

/** GET /v1/apps/:appId as a bearer caller, optionally carrying a tenant. */
async function getApp(opts: {
  token: string;
  appId: string;
  requestTenantId?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.token}`,
    'x-outerlayer-app-id': opts.appId,
  };
  if (opts.requestTenantId !== undefined) headers['x-tenant-id'] = opts.requestTenantId;
  return fetch(`${GATEWAY_URL}/v1/apps/${opts.appId}`, { headers });
}

// ---------------------------------------------------------------------------

/** Extract the created app's id from a 201 POST /v1/apps response. */
async function createdAppId(res: Response): Promise<string> {
  const body = (await res.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error(`No app id in create response: ${JSON.stringify(body)}`);
  return id;
}

describe('gateway bearer path — explicit request tenant', () => {
  let owner: TwoOrgOwner;
  // A second, unrelated account whose tenants EXIST but the primary caller is
  // not a member of — the spoof probe needs a real tenant, because a random
  // UUID cannot distinguish the membership check from a tenant-existence check.
  let stranger: TwoOrgOwner;
  // Apps created through the two tenant-resolution paths. Each tenant ends the
  // suite with a single app, so no per-tenant app quota is exercised.
  let appInAId: string;
  let appInBId: string;

  beforeAll(async () => {
    owner = await createTwoOrgOwner();
    stranger = await createTwoOrgOwner();
  });

  afterAll(async () => {
    await owner.cleanup();
    await stranger.cleanup();
  });

  it('no header creates in the claim tenant (A): reachable under A, denied under B', async () => {
    // No X-Tenant-Id ⇒ the embedded claim (A) serves exactly as before this
    // path learned about the header. Asserted through the gateway's own reads
    // (real RLS), not an admin backdoor: the created app resolves under the
    // claim/explicit-A but is invisible under a B header — it landed in A.
    const res = await createApp({ token: owner.token, name: `no-header-${randomUUID()}` });
    expect(res.status).toBe(201);
    appInAId = await createdAppId(res);

    expect((await getApp({ token: owner.token, appId: appInAId })).status).toBe(200);
    expect(
      (await getApp({ token: owner.token, appId: appInAId, requestTenantId: owner.tenantAId })).status,
    ).toBe(200);
    // App-ownership cross-check under a header-resolved tenant: A's app is not
    // in B, so a B header denies it.
    expect(
      (await getApp({ token: owner.token, appId: appInAId, requestTenantId: owner.tenantBId })).status,
    ).toBe(401);
  });

  // proves AC-060-11
  it('an explicit header creates in the HEADER tenant (B) for a two-org member, not the claim (A)', async () => {
    // The wrong-tenant-write class: claim = A, header = B, and the app must
    // land in B. Proven by gateway reads — reachable under a B header, denied
    // under the claim tenant A.
    const res = await createApp({
      token: owner.token,
      name: `header-wins-${randomUUID()}`,
      requestTenantId: owner.tenantBId,
    });
    expect(res.status).toBe(201);
    appInBId = await createdAppId(res);

    expect(
      (await getApp({ token: owner.token, appId: appInBId, requestTenantId: owner.tenantBId })).status,
    ).toBe(200);
    // Under the claim tenant A the B-app is invisible → it did NOT land in A.
    expect(
      (await getApp({ token: owner.token, appId: appInBId, requestTenantId: owner.tenantAId })).status,
    ).toBe(401);
  });

  // proves AC-060-12
  it('hard-denies a header naming a tenant the caller is not a member of — no claim fallback', async () => {
    // The user belongs to A and B only. A header naming an unrelated tenant
    // must 401 — never silently fall back to the valid claim (which would
    // otherwise create the app). The 401 fires in auth, before any write.
    const res = await createApp({
      token: owner.token,
      name: `spoof-${randomUUID()}`,
      requestTenantId: randomUUID(),
    });
    expect(res.status).toBe(401);

    // The same denial for a tenant that EXISTS but the caller is not a member
    // of — a membership check regressing to a tenant-existence check would
    // pass the random-UUID probe above and fail only here.
    const resReal = await createApp({
      token: owner.token,
      name: `spoof-real-${randomUUID()}`,
      requestTenantId: stranger.tenantAId,
    });
    expect(resReal.status).toBe(401);
  });
});
