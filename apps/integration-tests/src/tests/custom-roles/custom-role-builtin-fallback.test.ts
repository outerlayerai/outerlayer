/**
 * Integration tests for the custom-role ⇔ built-in-role contract on membership.
 *
 * The role column always holds a REAL built-in role; a custom role is active
 * exactly when custom_role_id IS NOT NULL, resolved at read time. There is no
 * 'custom' sentinel value and no sync trigger rewriting role. These tests pin:
 * - Assigning/clearing/switching custom_role_id never touches the role column
 *   (the stored built-in is the fallback that resurfaces when custom is cleared)
 * - change_member_role_transaction pins role to the 'read' fallback when it
 *   assigns a custom role, and applies the explicit built-in (clearing custom)
 *   otherwise
 * - Deleting a custom role (ON DELETE SET NULL) and a billing downgrade both
 *   just clear custom_role_id — the built-in fallback takes over
 * - The JWT carries the built-in role in user_role plus the custom_role_id
 *   claim; authorization is driven by custom_role_id, not a role value
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  cleanupBilling,
  createCustomRole,
  createBillingRecord,
  updateBillingTier,
  assignCustomRole,
  SameTenantUser,
} from './helpers';

/**
 * Decode a JWT access_token and return the payload (claims).
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  return JSON.parse(payload);
}

describe('membership custom_role_id ⇔ built-in role fallback', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let writeUser: SameTenantUser;
  let tenantId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');
    writeUser = await addUserToTenant(tenantId, 'write');
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser, writeUser]);
  });

  afterEach(async () => {
    // Reset to the seeded built-in roles with no custom role.
    await supabaseAdmin
      .from('membership')
      .update({ custom_role_id: null, role: 'read' })
      .eq('id', readUser.membershipId);
    await supabaseAdmin
      .from('membership')
      .update({ custom_role_id: null, role: 'write' })
      .eq('id', writeUser.membershipId);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
    await cleanupBilling(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // Direct custom_role_id writes never touch the role column
  // ---------------------------------------------------------------------------
  describe('custom_role_id writes leave the built-in role column untouched', () => {
    it('keeps role=read when custom_role_id is assigned to a read user', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Read', [
        'sso_config.read',
      ]);

      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBe(customRole.id);
    });

    it('keeps role=write when custom_role_id is assigned to a write user (fallback preserved, not rewritten)', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Write', [
        'app.read',
      ]);

      await assignCustomRole(supabaseAdmin, writeUser.membershipId, customRole.id);

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', writeUser.membershipId)
        .single();
      expect(data!.role).toBe('write');
      expect(data!.custom_role_id).toBe(customRole.id);
    });

    it('keeps the stored fallback when switching from one custom role to another', async () => {
      const roleA = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Role A', [
        'sso_config.read',
      ]);
      const roleB = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Role B', [
        'app.read',
      ]);

      await assignCustomRole(supabaseAdmin, readUser.membershipId, roleA.id);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, roleB.id);

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBe(roleB.id);
    });

    it('exposes the stored fallback when custom_role_id is cleared (write user stays write)', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Clear', [
        'app.read',
      ]);
      await assignCustomRole(supabaseAdmin, writeUser.membershipId, customRole.id);

      await assignCustomRole(supabaseAdmin, writeUser.membershipId, null);

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', writeUser.membershipId)
        .single();
      expect(data!.role).toBe('write');
      expect(data!.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // change_member_role_transaction pins the 'read' fallback on custom assignment
  // ---------------------------------------------------------------------------
  describe('change_member_role_transaction', () => {
    it('pins role to the read fallback when assigning a custom role', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Txn Custom', [
        'sso_config.read',
      ]);

      const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
        p_tenant_id: tenantId,
        p_target_user_id: writeUser.id,
        p_actor_id: ownerUser.id,
        p_custom_role_id: customRole.id,
      });
      expect(error).toBeNull();

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', writeUser.membershipId)
        .single();
      // The write user's fallback is pinned DOWN to 'read' — assigning a custom
      // role must not leave a higher built-in behind it.
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBe(customRole.id);
    });

    it('applies the explicit built-in and clears the custom role when changing to a built-in', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Txn Builtin', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      const { error } = await supabaseAdmin.rpc('change_member_role_transaction', {
        p_tenant_id: tenantId,
        p_target_user_id: readUser.id,
        p_actor_id: ownerUser.id,
        p_new_role: 'write',
      });
      expect(error).toBeNull();

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.role).toBe('write');
      expect(data!.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // ON DELETE SET NULL → custom_role_id cleared, fallback takes over
  // ---------------------------------------------------------------------------
  describe('Custom role deletion clears custom_role_id via ON DELETE SET NULL', () => {
    // proves AC-075-04
    it('leaves the built-in fallback governing after the assigned custom role is deleted', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Delete', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      await supabaseAdmin.from('custom_role').delete().eq('id', customRole.id);

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBeNull();
    });

    it('clears custom_role_id on all memberships when a shared custom role is deleted, each keeping its own fallback', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Delete Multi', [
        'app.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await assignCustomRole(supabaseAdmin, writeUser.membershipId, customRole.id);

      await supabaseAdmin.from('custom_role').delete().eq('id', customRole.id);

      const { data } = await supabaseAdmin
        .from('membership')
        .select('id, role, custom_role_id')
        .in('id', [readUser.membershipId, writeUser.membershipId]);
      expect(data).toHaveLength(2);
      const byId = new Map(data!.map((m) => [m.id, m]));
      expect(byId.get(readUser.membershipId)!.role).toBe('read');
      expect(byId.get(writeUser.membershipId)!.role).toBe('write');
      for (const m of data!) expect(m.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Billing downgrade → custom_role_id NULLed, fallback takes over
  // ---------------------------------------------------------------------------
  describe('Billing downgrade clears custom_role_id via nullify_custom_role_on_downgrade', () => {
    it('clears custom_role_id and leaves the built-in fallback when downgrading', async () => {
      await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Downgrade', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

      const { data } = await supabaseAdmin
        .from('membership')
        .select('role, custom_role_id')
        .eq('id', readUser.membershipId)
        .single();
      expect(data!.role).toBe('read');
      expect(data!.custom_role_id).toBeNull();
    });

    it('clears custom_role_id on all memberships on downgrade, each keeping its own fallback', async () => {
      await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'Fallback Downgrade Multi', [
        'app.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await assignCustomRole(supabaseAdmin, writeUser.membershipId, customRole.id);

      await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

      const { data } = await supabaseAdmin
        .from('membership')
        .select('id, role, custom_role_id')
        .in('id', [readUser.membershipId, writeUser.membershipId]);
      expect(data).toHaveLength(2);
      const byId = new Map(data!.map((m) => [m.id, m]));
      expect(byId.get(readUser.membershipId)!.role).toBe('read');
      expect(byId.get(writeUser.membershipId)!.role).toBe('write');
      for (const m of data!) expect(m.custom_role_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // JWT: built-in role in user_role, custom role active via custom_role_id claim
  // ---------------------------------------------------------------------------
  describe('JWT claims carry the built-in role plus custom_role_id', () => {
    it('mints user_role=<built-in fallback> and the custom_role_id claim when a custom role is set', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'JWT Fallback Role', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      const { data: session } = await readUser.client.auth.refreshSession();
      expect(session.session).not.toBeNull();

      const claims = decodeJwtPayload(session.session!.access_token);
      expect(claims.user_role).toBe('read');
      expect(claims.custom_role_id).toBe(customRole.id);
    });

    it('drops the custom_role_id claim and keeps user_role after the custom role is cleared', async () => {
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'JWT Fallback Clear', [
        'sso_config.read',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);

      const { data: session1 } = await readUser.client.auth.refreshSession();
      const claims1 = decodeJwtPayload(session1.session!.access_token);
      expect(claims1.custom_role_id).toBe(customRole.id);

      await assignCustomRole(supabaseAdmin, readUser.membershipId, null);

      const { data: session2 } = await readUser.client.auth.refreshSession();
      const claims2 = decodeJwtPayload(session2.session!.access_token);
      expect(claims2.user_role).toBe('read');
      expect(claims2.custom_role_id).toBeNull();
    });

    it('authorization follows the custom_role_id claim, not the built-in fallback', async () => {
      // sso_config.insert: NOT granted by the built-in 'read' role, granted by the
      // custom role — so a resolver keying on user_role instead of
      // custom_role_id would deny it.
      const customRole = await createCustomRole(supabaseAdmin, tenantId, 'JWT Authz Role', [
        'sso_config.read',
        'sso_config.insert',
      ]);
      await assignCustomRole(supabaseAdmin, readUser.membershipId, customRole.id);
      await readUser.client.auth.refreshSession();

      const { data: granted, error: e1 } = await readUser.client.rpc('authorize', {
        requested_permission: 'sso_config.insert',
      });
      expect(e1).toBeNull();
      expect(granted).toBe(true);

      // A permission neither the custom role nor 'read' grants stays denied.
      const { data: denied, error: e2 } = await readUser.client.rpc('authorize', {
        requested_permission: 'sso_config.delete',
      });
      expect(e2).toBeNull();
      expect(denied).toBe(false);
    });
  });
});
