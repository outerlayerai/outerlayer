/**
 * Regression: gateway role's UPDATE on `environment` must be column-restricted.
 *
 * The pre-fix migration granted full `UPDATE` on `public.environment` to the
 * gateway role. That let a buggy / compromised gateway code path mutate the
 * live pointers (`current_version`, `current_commit_sha`, `epoch`) and the
 * machine-state column (`fly_machine_id`)
 * directly, bypassing the admin-client-only write paths that legitimately own
 * those columns.
 *
 * Post-fix, the gateway has column-level UPDATE only on `fly_app_name` and
 * `updated_by` — the two columns `EnvironmentService.createEnvironment`
 * legitimately writes back during env provisioning. Every other column is
 * off-limits to the gateway role.
 *
 * This test exercises the contract end-to-end against real Postgres: it mints
 * a gateway JWT (`role: 'gateway'`), seeds a tenant + app + env, then tries
 * to UPDATE both the allowed and the forbidden column sets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { ensureDefaultEnvironment } from '../../lib/environment-test-utils';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ||
  'super-secret-jwt-token-with-at-least-32-characters-long';

function base64UrlEncode(data: Buffer): string {
  return data
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintGatewayJwt(tenantId: string, systemUserId: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    role: 'gateway',
    iss: 'gateway',
    sub: systemUserId,
    app_metadata: { tenant_id: tenantId },
    gateway_permissions: [],
    iat,
    exp: iat + 60,
  };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', JWT_SECRET).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function gatewayClient(tenantId: string, systemUserId: string): SupabaseClient {
  const jwt = mintGatewayJwt(tenantId, systemUserId);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

describe('Gateway env column grants', () => {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  let tenantId: string;
  let systemUserId: string;
  let appId: string;
  let envId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    tenantId = randomUUID();
    const ownerEmail = `gw-col-${Date.now()}-${randomUUID().slice(0, 6)}@test.com`;
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: 'TestPassword123!',
      email_confirm: true,
    });
    if (authErr || !authData?.user) throw new Error(`owner user: ${authErr?.message}`);
    ownerUserId = authData.user.id;
    await admin.from('profile').insert({ id: ownerUserId, name: 'gw col owner', email: ownerEmail });

    const { error: tErr } = await admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `gw-col-co-${randomUUID().slice(0, 6)}`,
      organization_name: `gw-col-org-${randomUUID().slice(0, 6)}`,
      created_by: ownerUserId,
    });
    if (tErr) throw new Error(`tenant: ${tErr.message}`);

    // The gateway mints sub = tenant_id (the fake-user machinery is gone).
    // RLS keys on the tenant claim, not sub.
    systemUserId = tenantId;

    const { data: app, error: appErr } = await admin
      .from('app')
      .insert({ name: `gw-col-app-${randomUUID().slice(0, 6)}`, tenant_id: tenantId, created_by: ownerUserId })
      .select('id')
      .single();
    if (appErr || !app) throw new Error(`app: ${appErr?.message}`);
    appId = (app as { id: string }).id;

    // The default `dev` env is auto-seeded by the `on_create_seed_default_env`
    // trigger on app insert; resolve its id via the fetch-or-create helper
    // rather than inserting a colliding duplicate.
    envId = await ensureDefaultEnvironment(appId, tenantId);
  });

  afterAll(async () => {
    await admin.from('environment').delete().eq('id', envId);
    await admin.from('app').delete().eq('id', appId);
    await admin.from('tenant').delete().eq('tenant_id', tenantId);
    if (ownerUserId) {
      await admin.auth.admin.deleteUser(ownerUserId).catch(() => undefined);
    }
  });

  it('allows the gateway role to UPDATE `fly_app_name`', async () => {
    const client = gatewayClient(tenantId, systemUserId);
    const flyAppName = `fly-app-${randomUUID().slice(0, 6)}`;
    const { error } = await client
      .from('environment')
      .update({ fly_app_name: flyAppName })
      .eq('id', envId);
    expect(error).toBeNull();
    // Confirm the write landed via admin re-read.
    const { data: reread } = await admin
      .from('environment')
      .select('fly_app_name')
      .eq('id', envId)
      .single();
    expect((reread as { fly_app_name: string }).fly_app_name).toBe(flyAppName);
  });

  // The saga pointer columns are the highest-stakes denials — corrupting any
  // one of these breaks env-version invariants the orchestrator relies on.
  it.each([
    ['current_version', 99],
    ['current_commit_sha', 'forged-commit-sha'],
    ['epoch', 1],
  ])(
    'denies the gateway role direct UPDATE of saga-managed `%s`',
    async (column, value) => {
      const client = gatewayClient(tenantId, systemUserId);
      const { error } = await client
        .from('environment')
        .update({ [column]: value })
        .eq('id', envId);
      // 42501 = insufficient_privilege from Postgres column-level GRANT.
      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');
    },
  );

  it.each([['fly_machine_id', 'forged-machine-id']])(
    'denies the gateway role direct UPDATE of machine-state column `%s`',
    async (column, value) => {
      const client = gatewayClient(tenantId, systemUserId);
      const { error } = await client
        .from('environment')
        .update({ [column]: value })
        .eq('id', envId);
      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');
    },
  );

  it.each([
    ['name', 'renamed-by-gateway'],
    ['is_default', false],
  ])(
    'denies the gateway role direct UPDATE of identity column `%s`',
    async (column, value) => {
      const client = gatewayClient(tenantId, systemUserId);
      const { error } = await client
        .from('environment')
        .update({ [column]: value })
        .eq('id', envId);
      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');
    },
  );
});
