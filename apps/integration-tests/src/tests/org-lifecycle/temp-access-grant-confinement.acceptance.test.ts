/**
 * `getActiveTempAccessGrant` (`tenant-dashboard/src/lib/system/temp-access-grant.ts`)
 * confinement — asserted as real-data behavior, not a mocked query chain.
 *
 * `temp_access_grant` carries no RLS policy that could backstop a caller-
 * supplied `tenantId`: the lookup runs on the service-role client, so the
 * ONLY thing preventing one platform admin from reading another's grant, or
 * probing a tenant they never granted themselves access to, is the
 * `created_by = userId AND tenant_id = tenantId` predicate inside the
 * function. This suite seeds two real grants for two real admins against two
 * real tenants and proves every cross-pairing comes back empty — including
 * the case where the queried tenantId names a tenant that DOES have an
 * active grant, just not one the caller created.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';
import { getActiveTempAccessGrant } from 'tenant-dashboard/src/lib/system/temp-access-grant';

describe('getActiveTempAccessGrant — cross-admin / cross-tenant confinement', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser; // owner acting as "platform admin A" for this suite
  let orgB: SameTenantUser; // owner acting as "platform admin B" for this suite
  let orgC: SameTenantUser; // a third tenant neither admin has ever granted access to

  let grantAId: string;
  let grantBId: string;

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    orgC = await createTenantWithOwner();

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { data: grantA, error: grantAError } = await admin
      .from('temp_access_grant')
      .insert({
        created_by: orgA.id,
        tenant_id: orgA.tenantId,
        expires_at: expiresAt,
        reason: 'confinement suite — admin A own grant',
      })
      .select('id')
      .single();
    if (grantAError) throw new Error(`seed grant A: ${grantAError.message}`);
    grantAId = grantA!.id;

    const { data: grantB, error: grantBError } = await admin
      .from('temp_access_grant')
      .insert({
        created_by: orgB.id,
        tenant_id: orgB.tenantId,
        expires_at: expiresAt,
        reason: 'confinement suite — admin B own grant',
      })
      .select('id')
      .single();
    if (grantBError) throw new Error(`seed grant B: ${grantBError.message}`);
    grantBId = grantB!.id;
  }, 90000);

  afterAll(async () => {
    await admin.from('temp_access_grant').delete().in('id', [grantAId, grantBId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, orgC.id]);
    for (const user of [orgA, orgB, orgC]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId, orgC.tenantId]);
  });

  it("resolves the caller's own active grant for the tenant they created it against", async () => {
    const grant = await getActiveTempAccessGrant({ tenantId: orgA.tenantId, userId: orgA.id });
    expect(grant?.id).toBe(grantAId);
  });

  it("admin A cannot read admin B's grant, even naming the tenant B's grant is for", async () => {
    const grant = await getActiveTempAccessGrant({ tenantId: orgB.tenantId, userId: orgA.id });
    expect(grant).toBeNull();
  });

  it("admin B cannot read admin A's grant, even naming the tenant A's grant is for", async () => {
    const grant = await getActiveTempAccessGrant({ tenantId: orgA.tenantId, userId: orgB.id });
    expect(grant).toBeNull();
  });

  it('a forged tenantId that names a tenant the caller never granted themselves access to resolves to nothing', async () => {
    const grant = await getActiveTempAccessGrant({ tenantId: orgC.tenantId, userId: orgA.id });
    expect(grant).toBeNull();
  });

  it('an unknown, entirely fabricated tenantId resolves to nothing rather than throwing', async () => {
    const grant = await getActiveTempAccessGrant({ tenantId: randomUUID(), userId: orgA.id });
    expect(grant).toBeNull();
  });
});
