/**
 * StorageCapService — Integration Tests
 *
 * Real Supabase (billing + tenant_entitlement_override), mocked Stripe meter.
 * Tests the full entitlement resolution chain: tier default → admin override → cap decision.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTestGatewayCache } from '@repo/gateway-core/test-helpers/test-gateway-cache';
import { StorageCapService } from '../../../../gateway/src/services/storage-cap-service';

vi.mock('../../../../gateway/src/services/logger', () => ({
  createLoggerFromContext: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_RUN_ID = Date.now().toString(36);

const hobbyTenantId = crypto.randomUUID();
const growthTenantId = crypto.randomUUID();
const teamTenantId = crypto.randomUUID();
const overrideTenantId = crypto.randomUUID();
const unlimitedOverrideTenantId = crypto.randomUUID();

const supabase = createSupabaseAdminClient();

// ---------------------------------------------------------------------------
// Stripe mock factory
// ---------------------------------------------------------------------------

function createMockStripe(aggregatedGb: number) {
  const listEventSummaries = vi.fn().mockResolvedValue({
    data: [{ aggregated_value: aggregatedGb }],
  });
  return { billing: { meters: { listEventSummaries } }, listEventSummaries } as any;
}

// ---------------------------------------------------------------------------
// Seed & cleanup
// ---------------------------------------------------------------------------

async function seedTenant(tenantId: string) {
  await supabase.from('tenant').upsert(
    { tenant_id: tenantId, organization_name: `test-${TEST_RUN_ID}-${tenantId.slice(0, 8)}`, company_name: `Test Co ${tenantId.slice(0, 8)}` },
    { onConflict: 'tenant_id' },
  );
}

async function seedBilling(tenantId: string, tierId: string) {
  await supabase.from('billing').upsert(
    { tenant_id: tenantId, tier_id: tierId, stripe_customer_id: `cus_test_${tenantId.slice(0, 8)}` },
    { onConflict: 'tenant_id' },
  );
}

async function seedOverride(tenantId: string, limitGb: number) {
  await supabase.from('tenant_entitlement_override').upsert(
    { tenant_id: tenantId, entitlement_key: 'max_storage_gb_per_month', value: { v: limitGb } },
    { onConflict: 'tenant_id,entitlement_key' },
  );
}

async function cleanupOverride(tenantId: string) {
  await supabase.from('tenant_entitlement_override')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('entitlement_key', 'max_storage_gb_per_month');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Seed tenants
  await Promise.all([
    seedTenant(hobbyTenantId),
    seedTenant(growthTenantId),
    seedTenant(teamTenantId),
    seedTenant(overrideTenantId),
    seedTenant(unlimitedOverrideTenantId),
  ]);

  // Seed billing rows
  await Promise.all([
    seedBilling(hobbyTenantId, 'hobby'),
    seedBilling(growthTenantId, 'growth'),
    seedBilling(teamTenantId, 'team'),
    seedBilling(overrideTenantId, 'hobby'),
    seedBilling(unlimitedOverrideTenantId, 'hobby'),
  ]);

  // Seed overrides
  await seedOverride(overrideTenantId, 5);        // 5 GB override
  await seedOverride(unlimitedOverrideTenantId, -1); // unlimited override
});

afterAll(async () => {
  await cleanupOverride(overrideTenantId);
  await cleanupOverride(unlimitedOverrideTenantId);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageCapService — Integration', () => {
  describe('Hobby tenant — tier default (1 GB)', () => {
    it('should allow when Stripe meter reports under 1 GB', async () => {
      const stripe = createMockStripe(0.5);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(hobbyTenantId, `cus_test_${hobbyTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(true);
      expect(result.capReached).toBe(false);
      expect(result.limitBytes).toBe(1_000_000_000);
      expect(result.currentBytes).toBe(500_000_000);
    });

    // proves AC-059-12
    it('should block when Stripe meter reports over 1 GB', async () => {
      const stripe = createMockStripe(1.5);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(hobbyTenantId, `cus_test_${hobbyTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(false);
      expect(result.capReached).toBe(true);
      expect(result.currentBytes).toBe(1_500_000_000);
    });
  });

  describe('Hobby tenant — admin override (5 GB)', () => {
    it('should allow at 3 GB (under 5 GB override, over 1 GB default)', async () => {
      const stripe = createMockStripe(3);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(overrideTenantId, `cus_test_${overrideTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(true);
      expect(result.limitBytes).toBe(5_000_000_000);
    });

    it('should block at 6 GB (over 5 GB override)', async () => {
      const stripe = createMockStripe(6);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(overrideTenantId, `cus_test_${overrideTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(false);
      expect(result.capReached).toBe(true);
    });
  });

  describe('Hobby tenant — unlimited override (-1)', () => {
    it('should allow at any usage level', async () => {
      const stripe = createMockStripe(999);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(unlimitedOverrideTenantId, `cus_test_${unlimitedOverrideTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(true);
      expect(result.limitBytes).toBe(-1);
      // Should not query Stripe — unlimited means skip the check
      expect(stripe.listEventSummaries).not.toHaveBeenCalled();
    });
  });

  describe('Growth tenant — always allowed', () => {
    it('should allow without querying Stripe', async () => {
      const stripe = createMockStripe(999);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(growthTenantId, `cus_test_${growthTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(true);
      expect(stripe.listEventSummaries).not.toHaveBeenCalled();
    });
  });

  describe('Team tenant — always allowed', () => {
    it('should allow without querying Stripe', async () => {
      const stripe = createMockStripe(999);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(teamTenantId, `cus_test_${teamTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(true);
      expect(stripe.listEventSummaries).not.toHaveBeenCalled();
    });
  });

  describe('No billing row', () => {
    it('should default to hobby tier and enforce cap', async () => {
      const unknownTenantId = crypto.randomUUID();
      // No billing row → defaults to hobby. With 0 GB usage, cap is not reached.
      const stripe = createMockStripe(0);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(unknownTenantId, 'cus_unknown');

      expect(result.allowed).toBe(true);
      expect(result.limitBytes).toBe(1_000_000_000); // hobby default
    });
  });

  describe('Stripe failure — fail open', () => {
    // proves AC-059-13
    it('should allow when Stripe meter query throws', async () => {
      const stripe = {
        billing: { meters: { listEventSummaries: vi.fn().mockRejectedValue(new Error('Stripe down')) } },
        listEventSummaries: vi.fn(),
      } as any;
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());

      const result = await service.checkStorageCap(hobbyTenantId, `cus_test_${hobbyTenantId.slice(0, 8)}`);

      expect(result.allowed).toBe(true);
    });
  });

  describe('Cache behavior', () => {
    it('should return cached result on second call without re-querying', async () => {
      const stripe = createMockStripe(0.5);
      const service = new StorageCapService(supabase as any, stripe, 'mtr_test', createTestGatewayCache());
      const cusId = `cus_test_${hobbyTenantId.slice(0, 8)}`;

      const result1 = await service.checkStorageCap(hobbyTenantId, cusId);
      // Clear Stripe mock to verify it's not called again
      stripe.listEventSummaries.mockClear();

      const result2 = await service.checkStorageCap(hobbyTenantId, cusId);

      expect(result2).toEqual(result1);
      expect(stripe.listEventSummaries).not.toHaveBeenCalled();
    });
  });
});
