/**
 * Membership INSERT is not an authenticated privilege-escalation vector.
 *
 * Every legitimate membership row is created by a SECURITY DEFINER RPC
 * (create_organization_transaction, invite_new_user_transaction,
 * invite_existing_user_transaction, grant_temp_access_transaction), all of which
 * bypass RLS. No authenticated code path inserts into membership directly. So a
 * direct PostgREST INSERT by an ordinary member must be denied — otherwise a
 * read/write member could POST a row granting owner to any user in their tenant.
 *
 * The positive case pins the other edge: removing the INSERT policy must not be
 * over-broad. The SECURITY DEFINER invite RPC still writes the membership row, so
 * a blanket insert block (e.g. a raising trigger) would fail this test.
 */
import { cleanupTestUsers, getSupabaseAdmin } from '../../lib/test-utils';
import { createTestUser } from '../../lib/rbac-test-utils';

describe('membership INSERT escalation', () => {
  afterAll(async () => {
    await cleanupTestUsers();
  });

  for (const attackerRole of ['read', 'write'] as const) {
    // proves AC-075-11
    it(`a ${attackerRole}-role member cannot POST a membership granting owner`, async () => {
      const attacker = await createTestUser(attackerRole);
      const accomplice = await createTestUser('read');

      // set_tenant_id pins tenant_id to the attacker's tenant, so this targets
      // the attacker's own org: grant the accomplice owner there.
      const { data, error } = await attacker.client
        .from('membership')
        .insert({
          user_id: accomplice.id,
          tenant_id: attacker.tenantId,
          role: 'owner',
          status: 'active',
        })
        .select('id');

      expect(error).not.toBeNull();
      expect(error?.message).toContain('row-level security policy');
      expect(data ?? []).toHaveLength(0);
    });
  }

  it('the SECURITY DEFINER invite RPC still creates the membership row', async () => {
    const admin = getSupabaseAdmin();
    const owner = await createTestUser('owner');
    const invitee = await createTestUser('read'); // separate tenant; invited into owner's

    const invitedAt = new Date();
    const expiresAt = new Date(invitedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    const { data: membershipId, error } = await admin.rpc('invite_existing_user_transaction', {
      p_user_id: invitee.id,
      p_tenant_id: owner.tenantId,
      p_invited_by: owner.id,
      p_role: 'read',
      p_invited_at: invitedAt.toISOString(),
      p_expires_at: expiresAt.toISOString(),
    });

    expect(error).toBeNull();
    expect(typeof membershipId).toBe('string');

    const { data: rows } = await admin
      .from('membership')
      .select('user_id, tenant_id, role, status')
      .eq('id', membershipId as string);
    expect(rows).toEqual([
      {
        user_id: invitee.id,
        tenant_id: owner.tenantId,
        role: 'read',
        status: 'pending',
      },
    ]);
  });
});
