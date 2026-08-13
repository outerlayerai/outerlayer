/**
 * Store-resident behavior of the management API key credential: RLS on
 * public.management_api_key, and the SECURITY DEFINER RPCs in
 * private.management_api_key_secret (24a-management-api-key-secret.sql) that verify
 * and mint the key digest.
 *
 * Unit suites (management-api-key-service.test.ts, management-api-keys/service.test.ts)
 * prove the same contracts against MSW-mocked Supabase responses, which can
 * only assert the shape the app code assumes the store returns. These tests
 * drive the real Postgres policies and DEFINER functions instead, so a
 * regression in the RLS predicate or the RPC's revoked/expired gating fails
 * here even if the mock still agrees with the app code.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  type SameTenantUser,
} from '../custom-roles/helpers';

const admin = createSupabaseAdminClient();

function digest(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Removes a tenant seeded by createTenantWithOwner/addUserToTenant, plus its
 * users. Every seeded tenant here has exactly one owner, so a plain
 * `tenant` row delete trips `protect_last_owner` on the cascaded membership
 * delete; `platform_admin_delete_tenant` sets the compensating flag that
 * trigger checks for, the same path platform-admin org deletion uses.
 */
async function cleanupTenant(tenantId: string, users: SameTenantUser[]): Promise<void> {
  const { error } = await admin.rpc('platform_admin_delete_tenant', { p_tenant_id: tenantId });
  if (error) throw new Error(`tenant cleanup: ${error.message}`);
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.id);
  }
}

async function seedKey(
  tenantId: string,
  createdBy: string,
  overrides: Partial<{
    name: string;
    permissions: string[];
    revokedAt: string | null;
    expiresAt: string | null;
  }> = {},
): Promise<string> {
  const rid = randomBytes(4).toString('hex');
  const { data, error } = await admin
    .from('management_api_key')
    .insert({
      tenant_id: tenantId,
      name: overrides.name ?? `store-test-${rid}`,
      management_api_key_id: `admin_key_${rid}`,
      key_prefix: 'olk_test',
      permissions: (overrides.permissions ?? ['management_api_key.read']) as never,
      created_by: createdBy,
      revoked_at: overrides.revokedAt ?? null,
      expires_at: overrides.expiresAt ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`management_api_key seed: ${error.message}`);
  return data!.id;
}

describe('management_api_key RLS', () => {
  let ownerA: SameTenantUser;
  let ownerB: SameTenantUser;
  let readMember: SameTenantUser;
  let keyIdA: string;

  beforeAll(async () => {
    ownerA = await createTenantWithOwner();
    ownerB = await createTenantWithOwner();
    readMember = await addUserToTenant(ownerA.tenantId, 'read');
    keyIdA = await seedKey(ownerA.tenantId, ownerA.id);
  }, 60000);

  afterAll(async () => {
    await cleanupTenant(ownerA.tenantId, [ownerA, readMember]);
    await cleanupTenant(ownerB.tenantId, [ownerB]);
  });

  it('a member holding only the read org role (no management_api_key.read grant) sees zero rows', async () => {
    const { data, error } = await readMember.client.from('management_api_key').select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('the owner sees exactly their tenant’s keys', async () => {
    const { data, error } = await ownerA.client.from('management_api_key').select('id, tenant_id');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: keyIdA, tenant_id: ownerA.tenantId }]);
  });

  // proves AC-059-17 (data half: an management API key's row is invisible outside
  // its own tenant, the invariant loadBearerServiceContext's cross-org check
  // relies on)
  it('an owner of a different tenant sees zero rows of another tenant’s keys', async () => {
    const { data, error } = await ownerB.client.from('management_api_key').select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('a role without management_api_key.insert cannot create a key', async () => {
    const { data, error } = await readMember.client
      .from('management_api_key')
      .insert({
        tenant_id: ownerA.tenantId,
        name: 'should-not-exist',
        management_api_key_id: `admin_key_${randomBytes(4).toString('hex')}`,
        permissions: [] as never,
        created_by: readMember.id,
      })
      .select('id');

    expect(data).toBeNull();
    expect(error).not.toBeNull();

    const { data: rows } = await admin
      .from('management_api_key')
      .select('id')
      .eq('name', 'should-not-exist');
    expect(rows).toEqual([]);
  });
});

describe('management_api_key secret RPCs (private.management_api_key_secret)', () => {
  let owner: SameTenantUser;

  beforeAll(async () => {
    owner = await createTenantWithOwner();
  }, 60000);

  afterAll(async () => {
    await cleanupTenant(owner.tenantId, [owner]);
  });

  it('verifies a live key by digest, returning its tenant, permissions and creator', async () => {
    const keyId = await seedKey(owner.tenantId, owner.id, {
      permissions: ['membership.read', 'membership.insert'],
    });
    const keyDigest = digest();
    const { error: setError } = await admin.rpc('set_management_api_key_secret', {
      p_management_api_key_id: keyId,
      p_key_digest: keyDigest,
      p_pepper_version: 1,
    });
    expect(setError).toBeNull();

    const { data, error } = await admin.rpc('verify_management_api_key', { p_key_digest: keyDigest });
    expect(error).toBeNull();
    expect(data).toEqual({
      managementApiKeyId: keyId,
      tenantId: owner.tenantId,
      permissions: ['membership.read', 'membership.insert'],
      createdBy: owner.id,
    });
  });

  it('returns nothing for a digest with no matching secret row', async () => {
    const { data, error } = await admin.rpc('verify_management_api_key', { p_key_digest: digest() });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  // proves AC-059-18 (data half: a revoked key's digest stops resolving at
  // the RPC the bearer-auth hot path calls)
  it('returns nothing for a revoked key even with the correct digest', async () => {
    const keyId = await seedKey(owner.tenantId, owner.id, {
      revokedAt: new Date().toISOString(),
    });
    const keyDigest = digest();
    await admin.rpc('set_management_api_key_secret', {
      p_management_api_key_id: keyId,
      p_key_digest: keyDigest,
      p_pepper_version: 1,
    });

    const { data, error } = await admin.rpc('verify_management_api_key', { p_key_digest: keyDigest });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  // proves AC-059-18 (data half: an expired key's digest stops resolving at
  // the RPC the bearer-auth hot path calls)
  it('returns nothing for an expired key even with the correct digest', async () => {
    const keyId = await seedKey(owner.tenantId, owner.id, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const keyDigest = digest();
    await admin.rpc('set_management_api_key_secret', {
      p_management_api_key_id: keyId,
      p_key_digest: keyDigest,
      p_pepper_version: 1,
    });

    const { data, error } = await admin.rpc('verify_management_api_key', { p_key_digest: keyDigest });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('touch_management_api_key_last_used advances last_used_at from null', async () => {
    const keyId = await seedKey(owner.tenantId, owner.id);
    const before = await admin.from('management_api_key').select('last_used_at').eq('id', keyId).single();
    expect(before.data?.last_used_at).toBeNull();

    const touchedAt = Date.now();
    const { error } = await admin.rpc('touch_management_api_key_last_used', { p_management_api_key_id: keyId });
    expect(error).toBeNull();

    const after = await admin.from('management_api_key').select('last_used_at').eq('id', keyId).single();
    expect(after.data?.last_used_at).not.toBeNull();
    expect(new Date(after.data!.last_used_at as string).getTime()).toBeGreaterThanOrEqual(touchedAt - 1000);
  });
});
