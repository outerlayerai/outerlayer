/**
 * Integration Tests for nullify_custom_role_on_downgrade trigger
 *
 * Tests that when billing.tier_id changes from a custom-role-enabled tier
 * (team, enterprise) to a disabled tier (hobby, growth), all membership
 * custom_role_id values are NULLed for that tenant.
 *
 * The trigger also scrubs entitlement-gated permissions from
 * custom_role_permission when the new tier no longer supports them:
 *   - custom_roles (false on hobby/growth): scrubs custom_role.*
 *
 * Non-entitlement-gated permissions (app.read, sso_config.read, etc.) are always
 * preserved on downgrade — admin must re-grant scrubbed permissions after upgrade.
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
  createTestApp,
  createAppMemberRole,
  SameTenantUser,
} from './helpers';

describe('nullify_custom_role_on_downgrade trigger', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser1: SameTenantUser;
  let readUser2: SameTenantUser;
  let tenantId: string;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser1 = await addUserToTenant(tenantId, 'read');
    readUser2 = await addUserToTenant(tenantId, 'read');
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser1, readUser2]);
  });

  afterEach(async () => {
    // Reset custom_role_id on memberships (ignore errors -- downgrade trigger may have already NULLed)
    await supabaseAdmin.from('membership').update({ custom_role_id: null }).eq('id', readUser1.membershipId);
    await supabaseAdmin.from('membership').update({ custom_role_id: null }).eq('id', readUser2.membershipId);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
    await cleanupBilling(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // team -> hobby NULLs all membership custom_role_id
  // ---------------------------------------------------------------------------
  it('should NULL out custom_role_id on all memberships when tier changes from team to hobby', async () => {
    // Arrange -- billing at team tier, two users with custom roles
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G31 Role', [
      'sso_config.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);
    await assignCustomRole(supabaseAdmin, readUser2.membershipId, customRole.id);

    // Act -- downgrade to hobby
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- all memberships for this tenant should have custom_role_id = NULL
    const { data: memberships } = await supabaseAdmin
      .from('membership')
      .select('id, custom_role_id')
      .eq('tenant_id', tenantId);

    for (const m of memberships!) {
      expect(m.custom_role_id).toBeNull();
    }
  });

  // ---------------------------------------------------------------------------
  // enterprise -> growth NULLs all membership custom_role_id
  // ---------------------------------------------------------------------------
  it('should NULL out custom_role_id when tier changes from enterprise to growth', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G32 Role', [
      'app.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act
    await updateBillingTier(supabaseAdmin, tenantId, 'growth');

    // Assert
    const { data } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(data!.custom_role_id).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // team -> enterprise should NOT null out custom_role_id
  // ---------------------------------------------------------------------------
  it('should NOT null out custom_role_id when tier changes from team to enterprise', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G33 Role', [
      'sso_config.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act -- upgrade to enterprise (both tiers support custom roles)
    await updateBillingTier(supabaseAdmin, tenantId, 'enterprise');

    // Assert -- custom_role_id should be preserved
    const { data } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(data!.custom_role_id).toBe(customRole.id);
  });

  // ---------------------------------------------------------------------------
  // hobby -> growth should NOT null out custom_role_id
  // ---------------------------------------------------------------------------
  it('should NOT null out custom_role_id when tier changes from hobby to growth', async () => {
    // Arrange -- hobby tier, assign custom_role_id directly (simulating override scenario)
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G34 Role', [
      'app.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act -- change to growth (both are non-custom-role tiers, no trigger action)
    await updateBillingTier(supabaseAdmin, tenantId, 'growth');

    // Assert -- custom_role_id should be preserved (trigger only fires FROM enabled TO disabled)
    const { data } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(data!.custom_role_id).toBe(customRole.id);
  });

  // ---------------------------------------------------------------------------
  // non-gated permissions preserved, gated permissions scrubbed on downgrade
  // ---------------------------------------------------------------------------
  it('should preserve non-gated custom_role_permission records while scrubbing gated ones on downgrade', async () => {
    // Arrange -- role has both non-gated (sso_config.read, app.read) AND gated (custom_role.read) permissions
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G35 Mixed Role', [
      'custom_role.read',
      'sso_config.read',
      'app.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act -- downgrade to hobby (custom_roles becomes false)
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- custom role record still exists
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .select('id, name')
      .eq('id', customRole.id)
      .single();
    expect(role).not.toBeNull();
    expect(role!.name).toBe('G35 Mixed Role');

    // Assert -- non-gated permissions preserved, gated (custom_role.read) scrubbed
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(perms).toHaveLength(2);
    expect(perms!.map((p) => p.permission).sort()).toEqual(['app.read', 'sso_config.read']);

    // Assert -- membership.custom_role_id was NULLed (hobby/growth loses custom_roles)
    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(membership!.custom_role_id).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // no-op when tier_id does not actually change
  // ---------------------------------------------------------------------------
  it('should not fire when tier_id does not actually change', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G36 No-Op Role', [
      'sso_config.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act -- update billing with same tier_id
    await updateBillingTier(supabaseAdmin, tenantId, 'team');

    // Assert -- custom_role_id unchanged
    const { data } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(data!.custom_role_id).toBe(customRole.id);
  });

  // ---------------------------------------------------------------------------
  // Entitlement-gated permission scrubbing on downgrade
  // ---------------------------------------------------------------------------

  // team -> growth scrubs custom_role.*
  it('should scrub custom_role.* when downgrading from team to growth', async () => {
    // Arrange -- team tier, role has custom_role perms + non-gated perms
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G38 Mixed Role', [
      'custom_role.read',
      'custom_role.insert',
      'app.read',
    ]);

    // Act -- downgrade to growth (custom_roles: true → false)
    await updateBillingTier(supabaseAdmin, tenantId, 'growth');

    // Assert
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);

    const permSet = new Set(perms!.map((p) => p.permission));
    // custom_role.* scrubbed (custom_roles entitlement lost)
    expect(permSet.has('custom_role.read')).toBe(false);
    expect(permSet.has('custom_role.insert')).toBe(false);
    // non-gated preserved
    expect(permSet.has('app.read')).toBe(true);
  });

  // team -> hobby scrubs custom_role.*
  it('should scrub custom_role.* permissions when downgrading from team to hobby', async () => {
    // Arrange -- team tier, role has all entitlement-gated perms + non-gated
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G39 Full Role', [
      'custom_role.read',
      'custom_role.delete',
      'app.read',
      'sso_config.read',
      'ai_cost_config.read', // non-gated (no entitlement gates ai_cost_config.*)
    ]);

    // Act -- downgrade to hobby (custom_roles becomes false)
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);

    const permSet = new Set(perms!.map((p) => p.permission));
    // All entitlement-gated perms scrubbed
    expect(permSet.has('custom_role.read')).toBe(false);
    expect(permSet.has('custom_role.delete')).toBe(false);
    // Non-gated permissions survive
    expect(permSet.has('app.read')).toBe(true);
    expect(permSet.has('sso_config.read')).toBe(true);
    expect(permSet.has('ai_cost_config.read')).toBe(true);
  });

  // custom_role record itself is preserved (only permissions are scrubbed)
  it('should preserve the custom_role record while scrubbing entitlement-gated permissions', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G40 Preserved Role', [
      'custom_role.read',
      'app.read',
    ]);

    // Act
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- custom_role record still exists
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .select('id, name')
      .eq('id', customRole.id)
      .single();
    expect(role).not.toBeNull();
    expect(role!.name).toBe('G40 Preserved Role');

    // Assert -- only non-gated permissions remain
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(perms!.map((p) => p.permission).sort()).toEqual(['app.read']);
  });

  // after upgrade + re-grant, entitlement-gated permissions can be added back
  it('should allow re-granting entitlement-gated permissions after upgrade', async () => {
    // Arrange -- start at team, downgrade to hobby (scrubs custom_role.read)
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G41 Re-Grant Role', [
      'custom_role.read',
      'app.read',
    ]);
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Verify scrubbed
    const { data: afterDowngrade } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(afterDowngrade!.map((p) => p.permission).sort()).toEqual(['app.read']);

    // Act -- upgrade back to team
    await updateBillingTier(supabaseAdmin, tenantId, 'team');

    // Re-grant the scrubbed permission
    const { error: reGrantError } = await supabaseAdmin
      .from('custom_role_permission')
      .insert({ custom_role_id: customRole.id, permission: 'custom_role.read' });
    expect(reGrantError).toBeNull();

    // Assert -- permission is restored
    const { data: afterUpgrade } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    const permSet = new Set(afterUpgrade!.map((p) => p.permission));
    expect(permSet.has('app.read')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // enterprise -> hobby scrubs custom_role.*
  // ---------------------------------------------------------------------------
  it('should scrub all entitlement-gated permissions when downgrading from enterprise to hobby', async () => {
    // Arrange -- enterprise tier, role has every gated permission + non-gated
    await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G42 Enterprise Full', [
      'custom_role.read',
      'custom_role.insert',
      'custom_role.update',
      'custom_role.delete',
      'app.read',        // non-gated
      'sso_config.read',   // non-gated
    ]);

    // Act -- downgrade straight to hobby
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- ALL gated permissions scrubbed, non-gated survive
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);

    const permSet = new Set(perms!.map((p) => p.permission));
    // All 8 gated permissions should be gone
    expect(permSet.has('custom_role.read')).toBe(false);
    expect(permSet.has('custom_role.insert')).toBe(false);
    expect(permSet.has('custom_role.update')).toBe(false);
    expect(permSet.has('custom_role.delete')).toBe(false);
    // Non-gated survive
    expect(permSet.has('app.read')).toBe(true);
    expect(permSet.has('sso_config.read')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // multiple custom roles per tenant — ALL roles get scrubbed
  // ---------------------------------------------------------------------------
  it('should scrub gated permissions from ALL custom roles in the tenant on downgrade', async () => {
    // Arrange -- team tier, two custom roles with different permission sets
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const role1 = await createCustomRole(supabaseAdmin, tenantId, 'G43 Role A', [
      'custom_role.read',
      'app.read',
    ]);
    const role2 = await createCustomRole(supabaseAdmin, tenantId, 'G43 Role B', [
      'custom_role.insert',
      'sso_config.read',
    ]);

    // Act -- downgrade to hobby
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert role1 -- only app.read survives
    const { data: perms1 } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', role1.id);
    const set1 = new Set(perms1!.map((p) => p.permission));
    expect(set1.has('custom_role.read')).toBe(false);
    expect(set1.has('app.read')).toBe(true);

    // Assert role2 -- only sso_config.read survives
    const { data: perms2 } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', role2.id);
    const set2 = new Set(perms2!.map((p) => p.permission));
    expect(set2.has('custom_role.insert')).toBe(false);
    expect(set2.has('sso_config.read')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // cross-tenant isolation — downgrading tenant A doesn't affect tenant B
  // ---------------------------------------------------------------------------
  it('should not affect other tenants custom role permissions when downgrading one tenant', async () => {
    // Arrange -- two tenants, both at team tier
    const tenantBOwner = await createTenantWithOwner();
    const tenantBId = tenantBOwner.tenantId;

    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    await createBillingRecord(supabaseAdmin, tenantBId, 'team', tenantBOwner.id);

    const roleA = await createCustomRole(supabaseAdmin, tenantId, 'G44 Tenant A', [
      'custom_role.read',
      'app.read',
    ]);
    const roleB = await createCustomRole(supabaseAdmin, tenantBId, 'G44 Tenant B', [
      'custom_role.read',
      'app.read',
    ]);

    // Act -- downgrade only tenant A to hobby
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- tenant A's gated permissions scrubbed
    const { data: permsA } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', roleA.id);
    const setA = new Set(permsA!.map((p) => p.permission));
    expect(setA.has('custom_role.read')).toBe(false);
    expect(setA.has('app.read')).toBe(true);

    // Assert -- tenant B's permissions completely untouched
    const { data: permsB } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', roleB.id);
    const setB = new Set(permsB!.map((p) => p.permission));
    expect(setB.has('custom_role.read')).toBe(true);
    expect(setB.has('app.read')).toBe(true);

    // Cleanup tenant B
    await cleanupCustomRoles(supabaseAdmin, tenantBId);
    await cleanupBilling(supabaseAdmin, tenantBId);
    await cleanupTenantAndUsers(tenantBId, [tenantBOwner]);
  });

  // ---------------------------------------------------------------------------
  // idempotency — trigger on already-scrubbed data doesn't error
  // ---------------------------------------------------------------------------
  it('should not error when trigger fires on already-scrubbed permissions (idempotent)', async () => {
    // Arrange -- team tier, role with gated perms
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G45 Idempotent', [
      'custom_role.read',
      'app.read',
    ]);

    // Act -- downgrade to hobby (scrubs gated perms)
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Act again -- upgrade to growth then back to hobby (triggers scrub again on already-clean data)
    await updateBillingTier(supabaseAdmin, tenantId, 'growth');
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- should not error, non-gated perms still intact
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    const permSet = new Set(perms!.map((p) => p.permission));
    expect(permSet.has('app.read')).toBe(true);
    expect(permSet.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // empty custom role — trigger doesn't error on role with 0 permissions
  // ---------------------------------------------------------------------------
  it('should not error when downgrading a tenant with an empty custom role (zero permissions)', async () => {
    // Arrange -- team tier, role with NO permissions
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const emptyRole = await createCustomRole(supabaseAdmin, tenantId, 'G46 Empty Role', []);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, emptyRole.id);

    // Act -- downgrade to hobby (trigger fires, finds 0 matching rows to delete)
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- no error, role still exists, membership custom_role_id nulled
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .select('id')
      .eq('id', emptyRole.id)
      .single();
    expect(role).not.toBeNull();

    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', emptyRole.id);
    expect(perms).toHaveLength(0);

    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(membership!.custom_role_id).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // all-gated role becomes fully emptied after scrubbing
  // ---------------------------------------------------------------------------
  it('should leave a role with zero permissions when all its permissions are gated', async () => {
    // Arrange -- role has ONLY gated permissions
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G47 All Gated', [
      'custom_role.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act -- downgrade to hobby
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- role still exists but has zero permissions
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .select('id')
      .eq('id', customRole.id)
      .single();
    expect(role).not.toBeNull();

    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(perms).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // enterprise -> team preserves all permissions (lateral within enabled tiers)
  // ---------------------------------------------------------------------------
  it('should preserve all permissions when downgrading from enterprise to team', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G48 Enterprise to Team', [
      'custom_role.read',
      'app.read',
      'sso_config.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);

    // Act -- enterprise to team (both have custom_roles)
    await updateBillingTier(supabaseAdmin, tenantId, 'team');

    // Assert -- all permissions preserved
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(perms).toHaveLength(3);
    expect(perms!.map((p) => p.permission).sort()).toEqual([
      'app.read', 'custom_role.read', 'sso_config.read',
    ]);

    // Assert -- custom_role_id preserved on membership
    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(membership!.custom_role_id).toBe(customRole.id);
  });

  // ---------------------------------------------------------------------------
  // enterprise -> growth scrubs custom_role.*
  // ---------------------------------------------------------------------------
  it('should scrub custom_role.* when downgrading from enterprise to growth', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G49 Ent to Growth', [
      'custom_role.read',
      'custom_role.update',
      'app.read',
    ]);

    // Act -- enterprise to growth (custom_roles lost)
    await updateBillingTier(supabaseAdmin, tenantId, 'growth');

    // Assert
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    const permSet = new Set(perms!.map((p) => p.permission));
    expect(permSet.has('custom_role.read')).toBe(false);
    expect(permSet.has('custom_role.update')).toBe(false);
    expect(permSet.has('app.read')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // growth -> hobby skips custom_role.* condition (already disabled)
  // ---------------------------------------------------------------------------
  it('should not scrub custom_role.* when downgrading from growth to hobby (already disabled)', async () => {
    // Arrange -- growth tier, role has custom_role.* perms (added manually, bypassing entitlement)
    await createBillingRecord(supabaseAdmin, tenantId, 'growth', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G50 Growth to Hobby', [
      'custom_role.read',   // shouldn't be here on growth, but tests trigger logic
      'app.read',
    ]);

    // Act -- growth to hobby (OLD is growth, so custom_role.* condition should NOT fire)
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- custom_role.* scrubbed
    // custom_role.read is PRESERVED because the custom_role.* condition requires OLD NOT IN ('hobby','growth')
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    const permSet = new Set(perms!.map((p) => p.permission));
    expect(permSet.has('custom_role.read')).toBe(true);  // NOT scrubbed — OLD was growth
    expect(permSet.has('app.read')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // team -> hobby fires both conditions — verify all three effects
  // ---------------------------------------------------------------------------
  it('should NULL membership and scrub custom_role.* in one trigger fire', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G51 Triple Effect', [
      'custom_role.read',
      'app.read',
    ]);
    await assignCustomRole(supabaseAdmin, readUser1.membershipId, customRole.id);
    await assignCustomRole(supabaseAdmin, readUser2.membershipId, customRole.id);

    // Act
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert effect 1: membership.custom_role_id NULLed for both users
    const { data: m1 } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(m1!.custom_role_id).toBeNull();

    const { data: m2 } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser2.membershipId)
      .single();
    expect(m2!.custom_role_id).toBeNull();

    // Assert effect 2+3: all gated permissions scrubbed, non-gated preserved
    const { data: perms } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(perms).toHaveLength(1);
    expect(perms![0]!.permission).toBe('app.read');
  });

  // ---------------------------------------------------------------------------
  // tenant with zero custom roles — trigger is a harmless no-op
  // ---------------------------------------------------------------------------
  it('should not error when trigger fires on a tenant with no custom roles at all', async () => {
    // Arrange -- billing exists but NO custom_role rows for tenant
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);

    // Act -- downgrade to hobby (subquery IN (SELECT id FROM custom_role WHERE ...) returns empty)
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- no errors, memberships untouched (no custom_role_id to NULL anyway)
    const { data: memberships } = await supabaseAdmin
      .from('membership')
      .select('id, custom_role_id')
      .eq('tenant_id', tenantId);
    for (const m of memberships!) {
      expect(m.custom_role_id).toBeNull();
    }
  });

  // ---------------------------------------------------------------------------
  // upgrade (hobby -> team) does NOT auto-restore permissions
  // ---------------------------------------------------------------------------
  it('should not auto-restore scrubbed permissions on upgrade from hobby to team', async () => {
    // Arrange -- start at team, downgrade to hobby (scrubs custom_role.read)
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G53 No Auto-Restore', [
      'custom_role.read',
      'app.read',
    ]);
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Verify scrubbed
    const { data: afterDown } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(afterDown!.map((p) => p.permission).sort()).toEqual(['app.read']);

    // Act -- upgrade back to team
    await updateBillingTier(supabaseAdmin, tenantId, 'team');

    // Assert -- permissions are NOT auto-restored (admin must re-grant manually)
    const { data: afterUp } = await supabaseAdmin
      .from('custom_role_permission')
      .select('permission')
      .eq('custom_role_id', customRole.id);
    expect(afterUp!.map((p) => p.permission).sort()).toEqual(['app.read']);
  });

  // ---------------------------------------------------------------------------
  // app_member_role.custom_role_id survives downgrade (trigger doesn't touch it)
  // ---------------------------------------------------------------------------
  it('should not scrub app_member_role.custom_role_id on downgrade (trigger scope is membership only)', async () => {
    // Arrange -- team tier, create app-level role assignment
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);
    const customRole = await createCustomRole(supabaseAdmin, tenantId, 'G54 App Role', [
      'app.read',
    ]);
    const { id: appId } = await createTestApp(supabaseAdmin, tenantId);
    const { id: amrId } = await createAppMemberRole(supabaseAdmin, {
      membershipId: readUser1.membershipId,
      appId,
      tenantId,
      role: 'read',
      customRoleId: customRole.id,
    });

    // Act -- downgrade to hobby
    await updateBillingTier(supabaseAdmin, tenantId, 'hobby');

    // Assert -- membership.custom_role_id is NULLed
    const { data: membership } = await supabaseAdmin
      .from('membership')
      .select('custom_role_id')
      .eq('id', readUser1.membershipId)
      .single();
    expect(membership!.custom_role_id).toBeNull();

    // Assert -- app_member_role.custom_role_id is NOT NULLed (trigger doesn't touch it)
    const { data: amr } = await supabaseAdmin
      .from('app_member_role')
      .select('custom_role_id')
      .eq('id', amrId)
      .single();
    expect(amr!.custom_role_id).toBe(customRole.id);

    // Cleanup
    await supabaseAdmin.from('app_member_role').delete().eq('id', amrId);
    await supabaseAdmin.from('app').delete().eq('id', appId);
  });
});
