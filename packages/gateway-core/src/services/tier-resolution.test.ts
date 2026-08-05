/**
 * Tests for the cached tier + entitlement-override resolver.
 *
 * Bugs these catch:
 *   - Key drops the tenant → one tenant's tier serves another. A data leak,
 *     since callers pass RLS-scoped clients.
 *   - Key drops the entitlement key → storage cap reads the span cap's override.
 *   - A failed read gets cached → a paying tenant is capped for 5 minutes.
 *   - Malformed override JSONB coerces, e.g. `Number(true)` shrinking a quota.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveTierWithOverride, tierResolutionCacheKey } from './tier-resolution';
import { createTestGatewayCache } from '../test-helpers/test-gateway-cache';

type ReadResult = { data: unknown; error: { code: string; message: string } | null };

/**
 * Supabase double over the `maybeSingle()` chain the resolver drives. Lookups
 * happen per call so one client can answer for several tenants, which is what
 * makes the key-isolation tests mean anything.
 */
function createSupabase(opts: {
  billingByTenant: Record<string, ReadResult>;
  overrideByTenantKey?: Record<string, ReadResult>;
}) {
  const billingReads: string[] = [];
  const overrideReads: string[] = [];
  const missing: ReadResult = { data: null, error: null };

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'billing') {
      return {
        select: () => ({
          eq: (_col: string, tenantId: string) => ({
            maybeSingle: async () => {
              billingReads.push(tenantId);
              return opts.billingByTenant[tenantId] ?? missing;
            },
          }),
        }),
      };
    }
    if (table === 'tenant_entitlement_override') {
      return {
        select: () => ({
          eq: (_c1: string, tenantId: string) => ({
            eq: (_c2: string, entitlementKey: string) => ({
              maybeSingle: async () => {
                overrideReads.push(`${tenantId}:${entitlementKey}`);
                return opts.overrideByTenantKey?.[`${tenantId}:${entitlementKey}`] ?? missing;
              },
            }),
          }),
        }),
      };
    }
    return {};
  });

  return { client: { from } as any, billingReads, overrideReads };
}

const row = (data: unknown): ReadResult => ({ data, error: null });

describe('tierResolutionCacheKey', () => {
  it('varies with both the tenant and the entitlement key', () => {
    expect(tierResolutionCacheKey('tenant-a', 'max_spans_per_month')).toBe(
      'tier:tenant-a:max_spans_per_month',
    );
    expect(tierResolutionCacheKey('tenant-b', 'max_spans_per_month')).not.toBe(
      tierResolutionCacheKey('tenant-a', 'max_spans_per_month'),
    );
    expect(tierResolutionCacheKey('tenant-a', 'max_storage_gb_per_month')).not.toBe(
      tierResolutionCacheKey('tenant-a', 'max_spans_per_month'),
    );
  });
});

describe('resolveTierWithOverride', () => {
  it('serves the second call for the same tenant+key from cache', async () => {
    const cache = createTestGatewayCache();
    const { client, billingReads } = createSupabase({
      billingByTenant: { 'tenant-a': row({ tier_id: 'growth' }) },
    });

    const first = await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');
    const second = await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');

    expect(first).toEqual({ tierId: 'growth', overrideLimit: null });
    expect(second).toEqual({ tierId: 'growth', overrideLimit: null });
    expect(billingReads).toEqual(['tenant-a']);
  });

  it('does NOT serve one tenant the other tenant cached tier', async () => {
    const cache = createTestGatewayCache();
    const { client, billingReads } = createSupabase({
      billingByTenant: {
        'tenant-a': row({ tier_id: 'enterprise' }),
        'tenant-b': row({ tier_id: 'hobby' }),
      },
    });

    const a = await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');
    const b = await resolveTierWithOverride(cache, client, 'tenant-b', 'max_spans_per_month');

    expect(a.tierId).toBe('enterprise');
    expect(b.tierId).toBe('hobby');
    expect(billingReads).toEqual(['tenant-a', 'tenant-b']);
  });

  it('does NOT serve one entitlement key the other key cached override', async () => {
    const cache = createTestGatewayCache();
    const { client, overrideReads } = createSupabase({
      billingByTenant: { 'tenant-a': row({ tier_id: 'hobby' }) },
      overrideByTenantKey: {
        'tenant-a:max_spans_per_month': row({ value: { v: 50_000 } }),
        'tenant-a:max_storage_gb_per_month': row({ value: { v: 25 } }),
      },
    });

    const spans = await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');
    const storage = await resolveTierWithOverride(
      cache,
      client,
      'tenant-a',
      'max_storage_gb_per_month',
    );

    expect(spans.overrideLimit).toBe(50_000);
    expect(storage.overrideLimit).toBe(25);
    expect(overrideReads).toEqual([
      'tenant-a:max_spans_per_month',
      'tenant-a:max_storage_gb_per_month',
    ]);
  });

  it('re-reads after a failed billing read instead of caching the hobby fallback', async () => {
    const cache = createTestGatewayCache();
    const { client, billingReads } = createSupabase({
      billingByTenant: {
        'tenant-a': { data: null, error: { code: '57014', message: 'statement timeout' } },
      },
    });

    const first = await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');
    const second = await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');

    expect(first).toEqual({ tierId: 'hobby', overrideLimit: null });
    expect(second).toEqual({ tierId: 'hobby', overrideLimit: null });
    expect(billingReads).toEqual(['tenant-a', 'tenant-a']);
  });

  it('re-reads after a failed override read even when billing succeeded', async () => {
    const cache = createTestGatewayCache();
    const { client, overrideReads } = createSupabase({
      billingByTenant: { 'tenant-a': row({ tier_id: 'growth' }) },
      overrideByTenantKey: {
        'tenant-a:max_spans_per_month': {
          data: null,
          error: { code: '57014', message: 'statement timeout' },
        },
      },
    });

    await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');
    await resolveTierWithOverride(cache, client, 'tenant-a', 'max_spans_per_month');

    expect(overrideReads).toEqual([
      'tenant-a:max_spans_per_month',
      'tenant-a:max_spans_per_month',
    ]);
  });

  it('caches a legitimately absent billing row as hobby', async () => {
    const cache = createTestGatewayCache();
    const { client, billingReads } = createSupabase({ billingByTenant: {} });

    const first = await resolveTierWithOverride(cache, client, 'tenant-new', 'max_spans_per_month');
    const second = await resolveTierWithOverride(cache, client, 'tenant-new', 'max_spans_per_month');

    expect(first).toEqual({ tierId: 'hobby', overrideLimit: null });
    expect(second).toEqual({ tierId: 'hobby', overrideLimit: null });
    expect(billingReads).toEqual(['tenant-new']);
  });

  describe('override JSONB parsing', () => {
    const cases: Array<[string, unknown, number | null]> = [
      ['numeric v', { v: 50_000 }, 50_000],
      ['string-numeric v', { v: '75000' }, 75_000],
      ['unlimited sentinel', { v: -1 }, -1],
      ['zero', { v: 0 }, 0],
      ['null v', { v: null }, null],
      ['missing v', { amount: 100_000 }, null],
      ['unwrapped bare number', 50_000, null],
      ['boolean true must not coerce to 1', { v: true }, null],
      ['boolean false must not coerce to 0', { v: false }, null],
      ['non-numeric string', { v: 'unlimited' }, null],
      ['Infinity string', { v: 'Infinity' }, null],
    ];

    it.each(cases)('%s → %s', async (_label, rawValue, expected) => {
      const cache = createTestGatewayCache();
      const { client } = createSupabase({
        billingByTenant: { 'tenant-a': row({ tier_id: 'hobby' }) },
        overrideByTenantKey: { 'tenant-a:max_spans_per_month': row({ value: rawValue }) },
      });

      const result = await resolveTierWithOverride(
        cache,
        client,
        'tenant-a',
        'max_spans_per_month',
      );

      expect(result).toEqual({ tierId: 'hobby', overrideLimit: expected });
    });
  });
});
