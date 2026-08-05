/**
 * Integration Tests for CustomRoleService Entitlement Enforcement
 *
 * Tests that CustomRoleService properly gates operations behind the
 * custom_roles boolean entitlement.
 *
 * Uses real Supabase database with the service instantiated using
 * admin client (service role) for both db and adminDb, since the
 * entitlement checks need to read billing and override tables.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { CustomRoleService } from '@ee/features/custom-roles/custom-role-service';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  cleanupCustomRoles,
  cleanupBilling,
  createBillingRecord,
  assignCustomRole,
  SameTenantUser,
} from './helpers';

describe('CustomRoleService entitlement enforcement', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let ownerUser: SameTenantUser;
  let readUser: SameTenantUser;
  let tenantId: string;
  let service: CustomRoleService;

  beforeAll(async () => {
    ownerUser = await createTenantWithOwner();
    tenantId = ownerUser.tenantId;
    readUser = await addUserToTenant(tenantId, 'read');

    // Service uses admin client for both db and adminDb
    // (integration tests bypass RLS to focus on service logic)
    service = new CustomRoleService({ db: supabaseAdmin, adminDb: supabaseAdmin });
  });

  afterAll(async () => {
    await cleanupTenantAndUsers(tenantId, [ownerUser, readUser]);
  });

  afterEach(async () => {
    await assignCustomRole(supabaseAdmin, readUser.membershipId, null);
    await cleanupCustomRoles(supabaseAdmin, tenantId);
    await supabaseAdmin
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', tenantId);
    await cleanupBilling(supabaseAdmin, tenantId);
  });

  // ---------------------------------------------------------------------------
  // block creation on hobby tier
  // ---------------------------------------------------------------------------
  it('should block custom role creation when tenant is on hobby tier', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);

    // Act
    const result = await service.create(tenantId, {
      name: 'J52-Role',
      permissions: ['sso_config.read'],
    });

    // Assert
    expect(result.success).toBe(false);
    const failed = result as Extract<typeof result, { success: false }>;
    expect(failed.error).toBe('entitlement_denied');
    expect(failed.entitlement!.featureKey).toBe('custom_roles');
  });

  // ---------------------------------------------------------------------------
  // block creation on growth tier
  // ---------------------------------------------------------------------------
  it('should block custom role creation when tenant is on growth tier', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'growth', ownerUser.id);

    // Act
    const result = await service.create(tenantId, {
      name: 'J53-Role',
      permissions: ['sso_config.read'],
    });

    // Assert
    expect(result.success).toBe(false);
    const failed = result as Extract<typeof result, { success: false }>;
    expect(failed.error).toBe('entitlement_denied');
  });

  // ---------------------------------------------------------------------------
  // allow creation on team tier
  // ---------------------------------------------------------------------------
  it('should allow custom role creation when tenant is on team tier', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'team', ownerUser.id);

    // Act
    const result = await service.create(tenantId, {
      name: 'J54-Role',
      permissions: ['sso_config.read'],
    });

    // Assert
    expect(result.success).toBe(true);
    const ok = result as Extract<typeof result, { success: true }>;
    expect(ok.data.name).toBe('J54-Role');
    expect(ok.data.permissions).toEqual(['sso_config.read']);
  });

  // ---------------------------------------------------------------------------
  // allow creation on enterprise tier
  // ---------------------------------------------------------------------------
  it('should allow custom role creation when tenant is on enterprise tier', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'enterprise', ownerUser.id);

    // Act
    const result = await service.create(tenantId, {
      name: 'J55-Role',
      permissions: ['app.read'],
    });

    // Assert
    expect(result.success).toBe(true);
    const ok = result as Extract<typeof result, { success: true }>;
    expect(ok.data.name).toBe('J55-Role');
  });

  // ---------------------------------------------------------------------------
  // allow creation on hobby tier with entitlement override
  // ---------------------------------------------------------------------------
  it('should allow custom role creation on hobby tier when entitlement override is set', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);
    await supabaseAdmin.from('tenant_entitlement_override').insert({
      tenant_id: tenantId,
      entitlement_key: 'custom_roles',
      value: { v: true },
      override_reason: 'J56 test override',
    });

    // Act
    const result = await service.create(tenantId, {
      name: 'J56-Override-Role',
      permissions: ['sso_config.read'],
    });

    // Assert
    expect(result.success).toBe(true);
    const ok = result as Extract<typeof result, { success: true }>;
    expect(ok.data.name).toBe('J56-Override-Role');
  });

  // ---------------------------------------------------------------------------
  // read and delete operations regardless of tier
  // Note: update() IS gated by entitlement in the service code, so only
  //       getAll/getById and delete are truly tier-independent.
  // ---------------------------------------------------------------------------
  it('should allow custom role read operations regardless of tier', async () => {
    // Arrange -- create billing at hobby tier, seed a custom role via admin
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);
    await supabaseAdmin.from('custom_role').insert({
      tenant_id: tenantId,
      name: 'J59-Readable-Role',
    });

    // Act
    const result = await service.getAll(tenantId);

    // Assert -- reading works even on hobby tier
    expect(result.success).toBe(true);
    const ok = result as Extract<typeof result, { success: true }>;
    expect(ok.data.length).toBeGreaterThanOrEqual(1);
    expect(ok.data.some((r) => r.name === 'J59-Readable-Role')).toBe(true);
  });

  it('should allow custom role delete operations regardless of tier', async () => {
    // Arrange -- create billing at hobby tier, seed a custom role via admin
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .insert({ tenant_id: tenantId, name: 'J59-Deletable-Role' })
      .select('id')
      .single();

    // Act
    const result = await service.delete(tenantId, role!.id);

    // Assert -- deleting works even on hobby tier
    expect(result.success).toBe(true);
  });

  it('should block custom role update when tenant lacks custom_roles entitlement', async () => {
    // Arrange -- hobby tier, seed a custom role via admin
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .insert({ tenant_id: tenantId, name: 'J59-Updatable-Role' })
      .select('id')
      .single();

    // Act -- update() has entitlement gate
    const result = await service.update(tenantId, role!.id, {
      name: 'J59-Updated-Name',
    });

    // Assert -- update is gated
    expect(result.success).toBe(false);
    const failed = result as Extract<typeof result, { success: false }>;
    expect(failed.error).toBe('entitlement_denied');
  });

  // ---------------------------------------------------------------------------
  // block custom role assignment when entitlement is denied
  // ---------------------------------------------------------------------------
  it('should block custom role assignment when tenant lacks custom_roles entitlement', async () => {
    // Arrange -- hobby tier (no custom_roles), seed a custom role via admin
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);
    const { data: role } = await supabaseAdmin
      .from('custom_role')
      .insert({ tenant_id: tenantId, name: 'J60-Role' })
      .select('id')
      .single();

    // Act
    const result = await service.assign(tenantId, readUser.membershipId, role!.id);

    // Assert
    expect(result.success).toBe(false);
    const failed = result as Extract<typeof result, { success: false }>;
    expect(failed.error).toBe('entitlement_denied');
    expect(failed.entitlement!.featureKey).toBe('custom_roles');
  });

  // ---------------------------------------------------------------------------
  // proper error structure with upgrade CTA when denied
  // ---------------------------------------------------------------------------
  it('should return proper error structure with upgrade CTA when entitlement is denied', async () => {
    // Arrange
    await createBillingRecord(supabaseAdmin, tenantId, 'hobby', ownerUser.id);

    // Act
    const result = await service.create(tenantId, {
      name: 'J61-Role',
      permissions: ['sso_config.read'],
    });

    // Assert
    expect(result.success).toBe(false);
    const failed = result as Extract<typeof result, { success: false }>;
    expect(failed.error).toBe('entitlement_denied');
    expect(failed.entitlement).toBeDefined();
    const ent = failed.entitlement!;
    expect(ent.featureKey).toBe('custom_roles');
    expect(ent.featureDisplayName).toBe('Custom Roles');
    expect(ent.requiredTier).toBe('team');
    expect(ent.requiredTierDisplayName).toBe('Team');
    expect(ent.isSelfServe).toBe(true);
    expect(ent.upgradeUrl).toBe('/settings/billing');
  });
});
