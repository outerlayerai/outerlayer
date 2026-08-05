/**
 * `GET /api/cli/apps` against a real Postgres RLS boundary.
 *
 * `createAuthenticatedUser` mints a claim that happens to equal the user's
 * real (and only) tenant, which would let "the resolver ran" pass for "the
 * resolver's answer actually reached the query." The fixture defeats that
 * coincidence: the claim is overwritten to point at a tenant the user has
 * never joined before the route is called, so only a response scoped by the
 * resolved tenant returns the seeded app.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createAuthenticatedUser, cleanupTestUsers } from '../../lib/test-utils';
import { GET } from 'tenant-dashboard/src/app/api/cli/apps/route';

const admin = createSupabaseAdminClient();

async function accessTokenFor(user: Awaited<ReturnType<typeof createAuthenticatedUser>>) {
  const { data } = await user.client.auth.getSession();
  if (!data.session) throw new Error('test user has no session');
  return data.session.access_token;
}

/** Decode a JWT's payload without verifying it — test-only, to confirm what claim actually shipped. */
function decodeJwtTenantId(token: string): string | undefined {
  const payload = token.split('.')[1]!;
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return (JSON.parse(json) as { app_metadata?: { tenant_id?: string } }).app_metadata?.tenant_id;
}

function cliRequest(token: string, headers?: Record<string, string>): Request {
  return new Request('http://localhost/api/cli/apps', {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
}

describe('GET /api/cli/apps — real Postgres RLS, not the mocked unit suite', () => {
  let user: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  let decoyTenantId: string;
  let ownAppId: string;

  beforeAll(async () => {
    user = await createAuthenticatedUser('owner');

    decoyTenantId = randomUUID();
    const { error: tenantError } = await admin.from('tenant').insert({
      tenant_id: decoyTenantId,
      company_name: 'decoy-co',
      organization_name: `decoy-org-${decoyTenantId.slice(0, 8)}`,
      created_by: user.id,
    });
    if (tenantError) throw new Error(`seed decoy tenant failed: ${tenantError.message}`);

    // Point the JWT claim at a tenant the user is not a member of; the
    // resolver never reads it (no header, sole real membership wins).
    const { data: current, error: getError } = await admin.auth.admin.getUserById(user.id);
    if (getError || !current.user) throw new Error(`fetch user failed: ${getError?.message}`);
    const { error: claimError } = await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...current.user.app_metadata, tenant_id: decoyTenantId },
    });
    if (claimError) throw new Error(`overwrite claim failed: ${claimError.message}`);
    const { error: refreshError } = await user.client.auth.refreshSession();
    if (refreshError) throw new Error(`refresh session failed: ${refreshError.message}`);

    // Confirm the decoy actually reached the token before trusting anything
    // downstream — a silently-failed refresh would leave the claim equal to
    // the real tenant, restoring the exact coincidence this test exists to
    // defeat, with both assertions below passing for the wrong reason.
    const refreshedToken = await accessTokenFor(user);
    if (decodeJwtTenantId(refreshedToken) !== decoyTenantId) {
      throw new Error(
        `claim overwrite did not propagate to the token: expected ${decoyTenantId}, got ${decodeJwtTenantId(refreshedToken)}`,
      );
    }

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ tenant_id: user.tenantId, name: `cli-route-app-${randomUUID().slice(0, 8)}`, created_by: user.id })
      .select('id')
      .single();
    if (appError || !app) throw new Error(`seed app failed: ${appError?.message}`);
    ownAppId = app.id;
  });

  afterAll(async () => {
    await admin.from('app').delete().eq('id', ownAppId);
    await admin.from('tenant').delete().eq('tenant_id', decoyTenantId);
    await cleanupTestUsers();
  });

  it('serves the caller\'s real (sole-membership) tenant, not the stale claim tenant', async () => {
    const token = await accessTokenFor(user);

    const res = await GET(cliRequest(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: Array<{ id: string; tenant_id: string }> };

    expect(body.apps.map((a) => a.id)).toEqual([ownAppId]);
    expect(body.apps.every((a) => a.tenant_id === user.tenantId)).toBe(true);
  });

  // This denial comes from resolveCliTenant's own membership check.
  it('denies a header naming a tenant the caller never joined, even though the stale claim names it', async () => {
    const token = await accessTokenFor(user);

    const res = await GET(cliRequest(token, { 'X-Tenant-Id': decoyTenantId }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Not an active member of the requested tenant');
  });
});

describe('GET /api/cli/apps — multi-org caller resolved by last-active preference', () => {
  let user: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  let secondTenantId: string;
  let preferredAppId: string;
  let secondAppId: string;

  beforeAll(async () => {
    user = await createAuthenticatedUser('owner');

    secondTenantId = randomUUID();
    const { error: tenantError } = await admin.from('tenant').insert({
      tenant_id: secondTenantId,
      company_name: 'second-co',
      organization_name: `second-org-${secondTenantId.slice(0, 8)}`,
      created_by: user.id,
    });
    if (tenantError) throw new Error(`seed second tenant failed: ${tenantError.message}`);

    const { error: membershipError } = await admin.from('membership').insert({
      id: randomUUID(),
      user_id: user.id,
      tenant_id: secondTenantId,
      role: 'read',
      status: 'active',
      is_app_scoped: false,
    });
    if (membershipError) {
      throw new Error(`seed second membership failed: ${membershipError.message}`);
    }

    const seedApp = async (tenantId: string) => {
      const { data, error } = await admin
        .from('app')
        .insert({
          tenant_id: tenantId,
          name: `cli-pref-app-${randomUUID().slice(0, 8)}`,
          created_by: user.id,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`seed app failed: ${error?.message}`);
      return data.id;
    };
    preferredAppId = await seedApp(user.tenantId);
    secondAppId = await seedApp(secondTenantId);

    const { error: prefError } = await admin
      .from('profile')
      .update({ last_active_tenant_id: user.tenantId })
      .eq('id', user.id);
    if (prefError) throw new Error(`seed preference failed: ${prefError.message}`);
  });

  afterAll(async () => {
    await admin.from('app').delete().eq('id', preferredAppId);
    await admin.from('app').delete().eq('id', secondAppId);
    await admin.from('tenant').delete().eq('tenant_id', secondTenantId);
    await cleanupTestUsers();
  });

  // The preference read runs through the caller's own bearer-scoped client
  // against real RLS — the mocked unit suite cannot prove that read works.
  it('serves the preference tenant headerlessly, never the other membership', async () => {
    const token = await accessTokenFor(user);

    const res = await GET(cliRequest(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: Array<{ id: string; tenant_id: string }> };

    expect(body.apps.map((a) => a.id)).toEqual([preferredAppId]);
  });

  it('asks the caller to pick an org when the preference is cleared', async () => {
    const { error } = await admin
      .from('profile')
      .update({ last_active_tenant_id: null })
      .eq('id', user.id);
    if (error) throw new Error(`clear preference failed: ${error.message}`);
    const token = await accessTokenFor(user);

    const res = await GET(cliRequest(token));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Multiple organizations found — switch to the one you want in the dashboard, then retry',
    });
  });
});
