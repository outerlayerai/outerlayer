/**
 * Connector-token PostgREST confinement (SEC-1).
 *
 * Supabase's OAuth 2.1 server mints a connector's access token (claude.ai /
 * ChatGPT custom connector) as an ordinary `role: authenticated` user JWT,
 * distinguished only by a `client_id` claim — Supabase does not enforce
 * OAuth scopes. The gateway confines these tokens to the MCP mount in
 * application code (`allowConnectorToken` in
 * packages/gateway-core/src/lib/verify-bearer.ts), but that confinement did
 * nothing to stop the SAME token being replayed directly against
 * `/rest/v1/*` with the full power of the approving user's role.
 *
 * `apps/tenant-dashboard/supabase/schemas/98a-connector-token-confinement.sql`
 * closes that gap with a RESTRICTIVE RLS policy. This test proves, against a
 * live local Supabase:
 *
 *   1. A JWT carrying `client_id` is denied on representative sensitive
 *      tables (tenant, billing, api_key) — direct PostgREST replay gets
 *      zero rows.
 *   2. The identical claims WITHOUT `client_id` (an ordinary session) are
 *      unaffected on those same tables.
 *   3. The MCP bearer auth path still resolves a connector token end to end:
 *      `resolveBearerUser` (the real production auth function, not a
 *      reimplementation) authenticates it, the `app_authorize` RPC the
 *      gateway's `checkBearerPermission` calls still returns a real answer,
 *      and the small exemption list (`membership`, `environment`) the MCP
 *      tool handlers depend on still reads normally.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveBearerUser, checkBearerPermission } from '@repo/gateway-core/lib/verify-bearer';
import type { Env } from '@repo/gateway-core/types';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  createTestApp,
  createBillingRecord,
  SameTenantUser,
} from './custom-roles/helpers';
import { createSupabaseAdminClient } from '../lib/supabase-admin';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long';

const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const env = {
  SUPABASE_API_BASE_URL: SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: SUPABASE_ANON_KEY,
  SUPABASE_SECRET_KEY: SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: JWT_SECRET,
} as unknown as Env;

// ---------------------------------------------------------------------------
// JWT minting — mirrors gateway-rls-matrix.test.ts, but for `role:
// authenticated` (the shape both a dashboard session and a connector token
// take), with and without the connector's `client_id` claim.
// ---------------------------------------------------------------------------

function base64UrlEncode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintUserJwt(params: {
  sub: string;
  tenantId: string;
  clientId?: string;
  ttlSeconds?: number;
}): string {
  const { sub, tenantId, clientId, ttlSeconds = 300 } = params;
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    aud: 'authenticated',
    role: 'authenticated',
    sub,
    app_metadata: { tenant_id: tenantId },
    iat,
    exp: iat + ttlSeconds,
  };
  if (clientId) payload.client_id = clientId;

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', JWT_SECRET).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function clientFor(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

describe('connector-token PostgREST confinement (SEC-1)', () => {
  let owner: SameTenantUser;
  let tenantId: string;
  let testApp: { id: string; name: string };
  let normalJwt: string;
  let connectorJwt: string;

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    tenantId = owner.tenantId;
    const admin = createSupabaseAdminClient();
    testApp = await createTestApp(admin, tenantId);
    await createBillingRecord(admin, tenantId, 'hobby');
    const { error: apiKeyError } = await admin.from('api_key').insert({
      tenant_id: tenantId,
      app_id: testApp.id,
      name: `sec1-test-key-${Date.now()}`,
      api_key_id: `sec1_test_${Date.now()}`,
      allowed_env_kinds: ['development'],
    });
    if (apiKeyError) throw new Error(`api_key create: ${apiKeyError.message}`);

    normalJwt = mintUserJwt({ sub: owner.id, tenantId });
    connectorJwt = mintUserJwt({ sub: owner.id, tenantId, clientId: 'connector-client-under-test' });
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [owner]);
  });

  // ---------------------------------------------------------------------------
  // 1 + 2. Sensitive tables: connector denied, plain session unaffected
  // ---------------------------------------------------------------------------

  it.each(['tenant', 'billing', 'api_key'] as const)(
    'a connector-claim JWT gets zero rows on %s while the identical plain-session JWT does not',
    async (table) => {
      const connectorResult = await clientFor(connectorJwt).from(table).select('*').eq('tenant_id', tenantId);
      const normalResult = await clientFor(normalJwt).from(table).select('*').eq('tenant_id', tenantId);

      expect(connectorResult.error).toBeNull();
      expect(connectorResult.data).toEqual([]);

      expect(normalResult.error).toBeNull();
      expect(normalResult.data?.length ?? 0).toBeGreaterThan(0);
    },
  );

  // ---------------------------------------------------------------------------
  // 3. MCP bearer path still works end to end for a connector token
  // ---------------------------------------------------------------------------

  it('resolveBearerUser authenticates a connector token when the route opts in', async () => {
    const result = await resolveBearerUser({
      env,
      token: connectorJwt,
      appId: testApp.id,
      requestTenantId: tenantId,
      allowConnectorToken: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.tenantId).toBe(tenantId);
    expect(result.user.appId).toBe(testApp.id);
  });

  it('resolveBearerUser still rejects a connector token on a non-MCP route', async () => {
    const result = await resolveBearerUser({
      env,
      token: connectorJwt,
      appId: testApp.id,
      requestTenantId: tenantId,
      allowConnectorToken: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it('checkBearerPermission (the app_authorize RPC) still resolves for a connector token', async () => {
    const granted = await checkBearerPermission({
      env,
      userJwt: connectorJwt,
      permission: 'metrics.read',
      appId: testApp.id,
      requestTenantId: tenantId,
    });

    // The owner role holds every gateway permission; the RPC runs as a
    // SECURITY DEFINER private function that bypasses RLS entirely (it
    // never selects through the querying role), so the confinement policy
    // has no effect on it — see 01a-private-authz.sql.
    expect(granted).toBe(true);
  });

  it('the exemption list (membership, environment) still reads for a connector token', async () => {
    const membership = await clientFor(connectorJwt)
      .from('membership')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('user_id', owner.id)
      .single();
    expect(membership.error).toBeNull();
    expect(membership.data?.id).toBe(owner.membershipId);

    // A new app gets a default environment via trigger — asserting a real
    // row comes back (not just "no error") makes this indistinguishable
    // from the blocked case impossible.
    const environment = await clientFor(connectorJwt)
      .from('environment')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('app_id', testApp.id);
    expect(environment.error).toBeNull();
    expect(environment.data?.length ?? 0).toBeGreaterThan(0);
  });
});
