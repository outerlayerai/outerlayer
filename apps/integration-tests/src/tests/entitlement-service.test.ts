/**
 * Integration Tests for EntitlementService
 *
 * Tests the EntitlementService query patterns against a real local Supabase
 * database. These tests target 29 surviving Stryker mutations in query strings
 * that mocked unit tests cannot catch.
 *
 * No mocks -- every test exercises real DB reads/writes via the service-role client.
 *
 * Covered query patterns:
 *   - getTenantTier: SELECT billing.tier_id WHERE id = tenantId
 *   - getOverrideValue (private, tested via canAccess/getLimit)
 *   - getOverrides: SELECT * FROM tenant_entitlement_override WHERE tenant_id
 *   - setTenantTier: UPDATE billing SET tier_id WHERE id = tenantId
 *   - setOverride: UPSERT tenant_entitlement_override ON CONFLICT (tenant_id, entitlement_key)
 *   - removeOverride: DELETE FROM tenant_entitlement_override WHERE tenant_id AND entitlement_key
 *   - getEffectiveEntitlements: getTenantTier() + getOverrides() merged
 *   - canAccess: override first, then tier default (boolean)
 *   - getLimit: override first, then tier default (numeric)
 *   - checkLimit: getLimit() then compare against count
 */

import { createSupabaseAdminClient } from '../lib/supabase-admin';
import { createAuthenticatedUser, cleanupTestUsers } from '../lib/test-utils';
import { EntitlementService } from 'tenant-dashboard/src/lib/system/entitlement-service';
import {
  ENTITLEMENTS,
  TIERS,
  UNLIMITED,
  type TierId,
} from 'tenant-dashboard/src/config/entitlements';

describe('EntitlementService integration', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let testUser: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  let service: EntitlementService;

  beforeAll(async () => {
    testUser = await createAuthenticatedUser('owner');

    // Billing row is needed -- seed it via admin client
    const { error: billingError } = await supabaseAdmin.from('billing').insert({
      tenant_id: testUser.tenantId,
      stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
      created_by: testUser.id,
    });
    if (billingError) {
      throw new Error(`Failed to create billing record: ${billingError.message}`);
    }

    // Create service with admin client (override table has platform admin RLS)
    service = new EntitlementService({ db: supabaseAdmin });
  });

  afterAll(async () => {
    // Clean up in dependency order
    await supabaseAdmin
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', testUser.tenantId);
    await supabaseAdmin.from('billing').delete().eq('tenant_id', testUser.tenantId);
    await cleanupTestUsers();
  });

  // Clean up overrides after each test to avoid cross-test contamination
  afterEach(async () => {
    await supabaseAdmin
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', testUser.tenantId);
  });

  // --------------------------------------------------------------------------
  // Tier queries
  // --------------------------------------------------------------------------

  describe('Tier queries', () => {
    afterEach(async () => {
      // Reset tier to hobby after each tier test
      await supabaseAdmin
        .from('billing')
        .update({ tier_id: 'hobby' })
        .eq('tenant_id', testUser.tenantId);
    });

    it('should return hobby as default tier for new tenant', async () => {
      const tier = await service.getTenantTier(testUser.tenantId);
      expect(tier).toBe('hobby');
    });

    it('should return updated tier after setTenantTier', async () => {
      await service.setTenantTier(testUser.tenantId, 'growth');
      const tier = await service.getTenantTier(testUser.tenantId);
      expect(tier).toBe('growth');
    });

    it('should return enterprise tier after setTenantTier to enterprise', async () => {
      await service.setTenantTier(testUser.tenantId, 'enterprise');
      const tier = await service.getTenantTier(testUser.tenantId);
      expect(tier).toBe('enterprise');
    });

    it('should fall back to hobby when billing row is missing', async () => {
      const nonExistentTenantId = crypto.randomUUID();
      const tier = await service.getTenantTier(nonExistentTenantId);
      expect(tier).toBe('hobby');
    });
  });

  // --------------------------------------------------------------------------
  // Override CRUD
  // --------------------------------------------------------------------------

  describe('Override CRUD', () => {
    it('should return empty array when no overrides exist', async () => {
      const overrides = await service.getOverrides(testUser.tenantId);
      expect(overrides).toEqual([]);
    });

    it('should store and retrieve boolean override via canAccess', async () => {
      // workers_enabled is false for hobby tier -- override to true
      const hobbyDefault = ENTITLEMENTS.workers_enabled.hobby;
      expect(hobbyDefault).toBe(false);

      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'workers_enabled',
        value: true,
        reason: 'Integration test override',
        createdBy: testUser.id,
      });

      const result = await service.canAccess(testUser.tenantId, 'workers_enabled');
      expect(result).toBe(true);
    });

    it('should store and retrieve numeric override via getLimit', async () => {
      // max_apps is 1 for hobby tier -- override to 50
      const hobbyDefault = ENTITLEMENTS.max_apps.hobby;
      expect(hobbyDefault).toBe(1);

      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_apps',
        value: 50,
        reason: 'Integration test override',
        createdBy: testUser.id,
      });

      const limit = await service.getLimit(testUser.tenantId, 'max_apps');
      expect(limit).toBe(50);
    });

    it('should update existing override on upsert with same key', async () => {
      // Set initial override
      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_users',
        value: 10,
        reason: 'First value',
        createdBy: testUser.id,
      });

      let limit = await service.getLimit(testUser.tenantId, 'max_users');
      expect(limit).toBe(10);

      // Upsert with new value for same key
      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_users',
        value: 100,
        reason: 'Updated value',
        createdBy: testUser.id,
      });

      limit = await service.getLimit(testUser.tenantId, 'max_users');
      expect(limit).toBe(100);

      // Should still be exactly one override row for this key
      const overrides = await service.getOverrides(testUser.tenantId);
      const maxUsersOverrides = overrides.filter((o) => o.entitlementKey === 'max_users');
      expect(maxUsersOverrides).toHaveLength(1);
    });

    it('should remove override and return to tier default', async () => {
      const hobbyMaxApps = ENTITLEMENTS.max_apps.hobby; // 1

      // Set override
      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_apps',
        value: 999,
        reason: 'Temporary override',
        createdBy: testUser.id,
      });

      let limit = await service.getLimit(testUser.tenantId, 'max_apps');
      expect(limit).toBe(999);

      // Remove override
      await service.removeOverride(testUser.tenantId, 'max_apps');

      // Should fall back to tier default
      limit = await service.getLimit(testUser.tenantId, 'max_apps');
      expect(limit).toBe(hobbyMaxApps);
    });

    it('should return undefined for non-existent override key via canAccess falling through to tier', async () => {
      // git_integration is true for all tiers, so canAccess should return the tier default
      // This verifies the getOverrideValue path returns undefined when no override exists
      const result = await service.canAccess(testUser.tenantId, 'git_integration');
      expect(result).toBe(ENTITLEMENTS.git_integration.hobby);
    });

    it('should store override with reason and createdBy metadata', async () => {
      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_api_keys',
        value: 100,
        reason: 'Sales approved',
        createdBy: testUser.id,
      });

      const overrides = await service.getOverrides(testUser.tenantId);
      const apiKeyOverride = overrides.find((o) => o.entitlementKey === 'max_api_keys');

      expect(apiKeyOverride).toBeDefined();
      expect(apiKeyOverride!.value).toBe(100);
      expect(apiKeyOverride!.overrideReason).toBe('Sales approved');
      expect(apiKeyOverride!.createdBy).toBe(testUser.id);
      expect(apiKeyOverride!.tenantId).toBe(testUser.tenantId);
      // id is a server-generated UUID; createdAt a server timestamp.
      expect(apiKeyOverride!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(typeof apiKeyOverride!.createdAt).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // Effective entitlements
  // --------------------------------------------------------------------------

  describe('Effective entitlements', () => {
    it('should return all tier defaults when no overrides exist', async () => {
      // Ensure tier is hobby
      await service.setTenantTier(testUser.tenantId, 'hobby');

      const effective = await service.getEffectiveEntitlements(testUser.tenantId);

      expect(effective.tierId).toBe('hobby');
      expect(effective.max_apps).toBe(ENTITLEMENTS.max_apps.hobby);
      expect(effective.max_users).toBe(ENTITLEMENTS.max_users.hobby);
      expect(effective.workers_enabled).toBe(ENTITLEMENTS.workers_enabled.hobby);
      expect(effective.git_integration).toBe(ENTITLEMENTS.git_integration.hobby);
      expect(effective.support_level).toBe(ENTITLEMENTS.support_level.hobby);
    });

    it('should merge override with tier defaults', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      // Override max_apps only
      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_apps',
        value: 42,
        reason: 'Integration test',
      });

      const effective = await service.getEffectiveEntitlements(testUser.tenantId);

      // Overridden value
      expect(effective.max_apps).toBe(42);

      // Non-overridden values should still be tier defaults
      expect(effective.tierId).toBe('hobby');
      expect(effective.max_users).toBe(ENTITLEMENTS.max_users.hobby);
      expect(effective.workers_enabled).toBe(ENTITLEMENTS.workers_enabled.hobby);
    });

    it('should reflect tier change in effective entitlements', async () => {
      await service.setTenantTier(testUser.tenantId, 'growth');

      const effective = await service.getEffectiveEntitlements(testUser.tenantId);

      expect(effective.tierId).toBe('growth');
      expect(effective.max_apps).toBe(ENTITLEMENTS.max_apps.growth);
      expect(effective.max_users).toBe(ENTITLEMENTS.max_users.growth);
      expect(effective.workers_enabled).toBe(ENTITLEMENTS.workers_enabled.growth);
      expect(effective.support_level).toBe(ENTITLEMENTS.support_level.growth);

      // Reset tier
      await service.setTenantTier(testUser.tenantId, 'hobby');
    });

    it('should combine tier change and override in effective entitlements', async () => {
      await service.setTenantTier(testUser.tenantId, 'growth');

      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_apps',
        value: 500,
        reason: 'Integration test',
      });

      const effective = await service.getEffectiveEntitlements(testUser.tenantId);

      expect(effective.tierId).toBe('growth');
      // Override should beat growth default (10)
      expect(effective.max_apps).toBe(500);
      // Non-overridden should be growth defaults
      expect(effective.max_users).toBe(ENTITLEMENTS.max_users.growth);

      // Reset tier
      await service.setTenantTier(testUser.tenantId, 'hobby');
    });
  });

  // --------------------------------------------------------------------------
  // checkLimit integration
  // --------------------------------------------------------------------------

  describe('checkLimit integration', () => {
    it('should allow when count is under limit', async () => {
      // hobby tier max_apps = 1, so count 0 should be allowed
      await service.setTenantTier(testUser.tenantId, 'hobby');

      const result = await service.checkLimit(testUser.tenantId, 'max_apps', 0);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(ENTITLEMENTS.max_apps.hobby);
      expect(result.currentCount).toBe(0);
    });

    it('should deny when count equals the limit', async () => {
      // hobby tier max_apps = 1, so count 1 (at limit) should be denied
      await service.setTenantTier(testUser.tenantId, 'hobby');

      const result = await service.checkLimit(testUser.tenantId, 'max_apps', 1);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(ENTITLEMENTS.max_apps.hobby);
      expect(result.currentCount).toBe(1);
      // Denied at the limit must surface a real upgrade target.
      expect(TIERS[result.requiredTier as TierId]).toBeDefined();
      expect(
        result.upgradeUrl === '/settings/billing' || result.upgradeUrl === '/contact',
      ).toBe(true);
    });

    it('should deny when count exceeds limit and return upgrade info', async () => {
      // hobby tier max_apps = 1, so count 5 should be denied
      await service.setTenantTier(testUser.tenantId, 'hobby');

      const result = await service.checkLimit(testUser.tenantId, 'max_apps', 5);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(1);
      expect(result.currentCount).toBe(5);

      // Upgrade info should point to the next tier that offers more.
      const requiredTierConfig = TIERS[result.requiredTier as TierId];
      expect(requiredTierConfig).toBeDefined();
      // The upgrade target must rank above hobby (sortOrder 0), i.e. a tier
      // that actually grants a higher max_apps.
      expect(requiredTierConfig!.sortOrder).toBeGreaterThan(TIERS.hobby.sortOrder);

      // upgradeUrl should be /settings/billing for self-serve tiers or /contact
      expect(
        result.upgradeUrl === '/settings/billing' || result.upgradeUrl === '/contact',
      ).toBe(true);
    });

    it('should allow unlimited when tier grants UNLIMITED for the key', async () => {
      // enterprise tier max_apps = -1 (UNLIMITED)
      await service.setTenantTier(testUser.tenantId, 'enterprise');

      const result = await service.checkLimit(testUser.tenantId, 'max_apps', 9999);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(UNLIMITED);
      expect(result.currentCount).toBe(9999);

      // Reset tier
      await service.setTenantTier(testUser.tenantId, 'hobby');
    });

    it('should allow when override raises limit above count', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      // Override max_apps to 10 (hobby default is 1)
      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_apps',
        value: 10,
        reason: 'Integration test',
      });

      const result = await service.checkLimit(testUser.tenantId, 'max_apps', 5);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
    });

    it('should deny when count equals override limit', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_apps',
        value: 10,
        reason: 'Integration test',
      });

      const result = await service.checkLimit(testUser.tenantId, 'max_apps', 10);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // canAccess and getLimit query correctness
  // --------------------------------------------------------------------------

  describe('canAccess query correctness', () => {
    it('should return tier default when no override exists for boolean key', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      // custom_sso is false for hobby
      const result = await service.canAccess(testUser.tenantId, 'custom_sso');
      expect(result).toBe(false);
    });

    it('should return override value over tier default for boolean key', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'custom_sso',
        value: true,
        reason: 'Early access',
      });

      const result = await service.canAccess(testUser.tenantId, 'custom_sso');
      expect(result).toBe(true);
    });

    it('should return correct value after tier upgrade for boolean key', async () => {
      // workers_enabled: hobby=false, growth=true
      await service.setTenantTier(testUser.tenantId, 'hobby');
      expect(await service.canAccess(testUser.tenantId, 'workers_enabled')).toBe(false);

      await service.setTenantTier(testUser.tenantId, 'growth');
      expect(await service.canAccess(testUser.tenantId, 'workers_enabled')).toBe(true);

      // Reset tier
      await service.setTenantTier(testUser.tenantId, 'hobby');
    });
  });

  describe('getLimit query correctness', () => {
    it('should return tier default when no override exists for numeric key', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      const limit = await service.getLimit(testUser.tenantId, 'max_users');
      expect(limit).toBe(ENTITLEMENTS.max_users.hobby);
    });

    it('should return override value over tier default for numeric key', async () => {
      await service.setTenantTier(testUser.tenantId, 'hobby');

      await service.setOverride({
        tenantId: testUser.tenantId,
        key: 'max_users',
        value: 200,
        reason: 'Custom deal',
      });

      const limit = await service.getLimit(testUser.tenantId, 'max_users');
      expect(limit).toBe(200);
    });

    it('should return UNLIMITED for enterprise numeric keys', async () => {
      await service.setTenantTier(testUser.tenantId, 'enterprise');

      const limit = await service.getLimit(testUser.tenantId, 'max_users');
      expect(limit).toBe(UNLIMITED);

      // Reset tier
      await service.setTenantTier(testUser.tenantId, 'hobby');
    });
  });
});
