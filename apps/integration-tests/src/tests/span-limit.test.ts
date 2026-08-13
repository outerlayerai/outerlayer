/**
 * Integration Tests for SpanLimitService
 *
 * Tests the full span limit enforcement flow:
 * - Tier resolution from real Supabase billing table
 * - Override lookup from real tenant_entitlement_override table
 * - Monthly count from mock ClickHouse (deterministic control)
 * - Limit enforcement logic (allowed/rejected)
 *
 * Uses real Supabase (local dev) and mock ClickHouse to control count values.
 */

import { createSupabaseAdminClient } from '../lib/supabase-admin';
import { createAuthenticatedUser, cleanupTestUsers } from '../lib/test-utils';
import { SpanLimitService } from '@repo/gateway-core/services/span-limit-service';
import type { IClickHouseService } from '@repo/gateway-core/services/clickhouse-service';
import { createTestGatewayCache } from '@repo/gateway-core/test-helpers/test-gateway-cache';

// ---------------------------------------------------------------------------
// Mock ClickHouse factory
// ---------------------------------------------------------------------------

function createMockClickHouse(monthlyCount: number): IClickHouseService {
  return {
    insertTraces: vi.fn(),
    query: vi.fn().mockResolvedValue([{ count: String(monthlyCount) }]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpanLimitService integration', () => {
  const supabaseAdmin = createSupabaseAdminClient();
  let hobbyUser: Awaited<ReturnType<typeof createAuthenticatedUser>>;
  let growthUser: Awaited<ReturnType<typeof createAuthenticatedUser>>;

  beforeAll(async () => {
    // Create two test users: one hobby, one growth
    hobbyUser = await createAuthenticatedUser('owner');
    growthUser = await createAuthenticatedUser('owner');

    // Seed billing rows (hobby is the default tier_id)
    const { error: hobbyBillingError } = await supabaseAdmin.from('billing').insert({
      tenant_id: hobbyUser.tenantId,
      stripe_customer_id: `cus_test_hobby_${crypto.randomUUID()}`,
      created_by: hobbyUser.id,
      // tier_id defaults to 'hobby'
    });
    if (hobbyBillingError) {
      throw new Error(`Failed to create hobby billing: ${hobbyBillingError.message}`);
    }

    // Growth tenant billing
    const { error: growthBillingError } = await supabaseAdmin.from('billing').insert({
      tenant_id: growthUser.tenantId,
      stripe_customer_id: `cus_test_growth_${crypto.randomUUID()}`,
      created_by: growthUser.id,
      tier_id: 'growth',
    });
    if (growthBillingError) {
      throw new Error(`Failed to create growth billing: ${growthBillingError.message}`);
    }
  });

  afterAll(async () => {
    // Clean up in dependency order
    await supabaseAdmin
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', hobbyUser.tenantId);
    await supabaseAdmin
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', growthUser.tenantId);
    await supabaseAdmin.from('billing').delete().eq('tenant_id', hobbyUser.tenantId);
    await supabaseAdmin.from('billing').delete().eq('tenant_id', growthUser.tenantId);
    await cleanupTestUsers();
  });

  afterEach(async () => {
    // Clean overrides between tests
    await supabaseAdmin
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', hobbyUser.tenantId);
  });

  // --------------------------------------------------------------------------
  // Hobby tier enforcement
  // --------------------------------------------------------------------------

  describe('Hobby tier span limit', () => {
    it('allows spans when count is under 20,000', async () => {
      const mockCh = createMockClickHouse(15000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(15000);
      expect(result.limit).toBe(20000);
      expect(result.remaining).toBe(5000);
    });

    it('rejects spans when count equals 20,000', async () => {
      const mockCh = createMockClickHouse(20000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(20000);
      expect(result.limit).toBe(20000);
      expect(result.remaining).toBe(0);
    });

    it('rejects spans when count exceeds 20,000', async () => {
      const mockCh = createMockClickHouse(20001);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Growth tier — unlimited
  // --------------------------------------------------------------------------

  describe('Growth tier — unlimited ingest (paid metered plan)', () => {
    it('allows with unlimited limit and skips the count query', async () => {
      const mockCh = createMockClickHouse(15000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(growthUser.tenantId);

      expect(result).toEqual({ allowed: true, currentCount: 0, limit: -1, remaining: -1 });
      expect(mockCh.query).not.toHaveBeenCalled();
    });

    // proves AC-076-07
    it('never rejects, even at a count far past the old cap', async () => {
      const mockCh = createMockClickHouse(10_000_000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(growthUser.tenantId);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
    });
  });

  // --------------------------------------------------------------------------
  // Override support
  // --------------------------------------------------------------------------

  describe('Override support', () => {
    it('uses override limit instead of tier default', async () => {
      // Insert an override of 50,000 for the hobby tenant
      const { error: overrideError } = await supabaseAdmin
        .from('tenant_entitlement_override')
        .insert({
          tenant_id: hobbyUser.tenantId,
          entitlement_key: 'max_spans_per_month',
          value: { v: 50000 },
          override_reason: 'test override',
          created_by: hobbyUser.id,
        });
      if (overrideError) {
        throw new Error(`Failed to insert override: ${overrideError.message}`);
      }

      const mockCh = createMockClickHouse(25000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(50000);
      expect(result.currentCount).toBe(25000);
      expect(result.remaining).toBe(25000);
    });

    it('rejects when count exceeds override limit', async () => {
      await supabaseAdmin
        .from('tenant_entitlement_override')
        .insert({
          tenant_id: hobbyUser.tenantId,
          entitlement_key: 'max_spans_per_month',
          value: { v: 50000 },
          override_reason: 'test override',
          created_by: hobbyUser.id,
        });

      const mockCh = createMockClickHouse(50000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(50000);
      expect(result.remaining).toBe(0);
    });

    it('should grant unlimited spans when override is -1', async () => {
      await supabaseAdmin
        .from('tenant_entitlement_override')
        .insert({
          tenant_id: hobbyUser.tenantId,
          entitlement_key: 'max_spans_per_month',
          value: { v: -1 },
          override_reason: 'unlimited override test',
          created_by: hobbyUser.id,
        });

      const mockCh = createMockClickHouse(0);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
      expect(result.remaining).toBe(-1);
      expect(mockCh.query).not.toHaveBeenCalled();
    });

    it('should revert to tier default when override is removed', async () => {
      // Set override
      await supabaseAdmin
        .from('tenant_entitlement_override')
        .insert({
          tenant_id: hobbyUser.tenantId,
          entitlement_key: 'max_spans_per_month',
          value: { v: 50000 },
          override_reason: 'temporary override',
          created_by: hobbyUser.id,
        });

      // Verify override is in effect
      const mockCh1 = createMockClickHouse(25000);
      const service1 = new SpanLimitService(mockCh1, supabaseAdmin, createTestGatewayCache());
      const withOverride = await service1.checkSpanLimit(hobbyUser.tenantId);
      expect(withOverride.allowed).toBe(true);
      expect(withOverride.limit).toBe(50000);

      // Remove override
      await supabaseAdmin
        .from('tenant_entitlement_override')
        .delete()
        .eq('tenant_id', hobbyUser.tenantId)
        .eq('entitlement_key', 'max_spans_per_month');

      // New service instance (no stale cache)
      const mockCh2 = createMockClickHouse(25000);
      const service2 = new SpanLimitService(mockCh2, supabaseAdmin, createTestGatewayCache());
      const withoutOverride = await service2.checkSpanLimit(hobbyUser.tenantId);

      // Should revert to hobby default of 20,000
      expect(withoutOverride.allowed).toBe(false);
      expect(withoutOverride.limit).toBe(20000);
    });
  });

  // --------------------------------------------------------------------------
  // 429 response shape (contract validation)
  // --------------------------------------------------------------------------

  describe('Response contract', () => {
    it('returns all required fields for allowed response', async () => {
      const mockCh = createMockClickHouse(10000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result).toEqual({
        allowed: true,
        currentCount: 10000,
        limit: 20000,
        remaining: 10000,
      });
    });

    it('returns all required fields for rejected response', async () => {
      const mockCh = createMockClickHouse(20000);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(hobbyUser.tenantId);

      expect(result).toEqual({
        allowed: false,
        currentCount: 20000,
        limit: 20000,
        remaining: 0,
      });
    });

    it('returns unlimited limit for Growth tier', async () => {
      const mockCh = createMockClickHouse(0);
      const service = new SpanLimitService(mockCh, supabaseAdmin, createTestGatewayCache());

      const result = await service.checkSpanLimit(growthUser.tenantId);

      expect(result).toEqual({
        allowed: true,
        currentCount: 0,
        limit: -1,
        remaining: -1,
      });
    });
  });
});
