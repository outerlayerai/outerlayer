/**
 * Unit tests for StorageCapService.
 *
 * The bug classes covered here:
 *   - Tier dispatch: only Hobby is cap-enforced. A refactor that
 *     reversed this (e.g. `===` instead of `!==`) would silently
 *     start blocking paid customers at the ingestion gateway.
 *   - Cap-reached boundary: `currentBytes >= limitBytes`. Flipping
 *     to `>` would let a customer ingest exactly one byte over.
 *   - Override precedence: an admin override beats the tier default.
 *     Inverting the null check would ignore overrides entirely.
 *   - UNLIMITED short-circuit: an override of `-1` skips Stripe.
 *     Removing this would issue a Stripe call for every unlimited
 *     tenant on every check.
 *   - Bytes/GB conversion: must multiply by 1_000_000_000. A wrong
 *     factor turns a 1 GB cap into 1 byte (block everything) or
 *     1 EB (block nothing).
 *   - Fail-soft contract: any error returns `allowed: true` so a
 *     transient Stripe/Supabase outage does NOT block ingestion.
 *     A refactor that propagated the error or returned `allowed:
 *     false` would shut the gateway off on its dependencies.
 *   - 5-minute verdict TTL: keeps Stripe off the per-request path.
 *   - The fail-open verdict must not be cached, or one Stripe blip
 *     leaves caps unenforced for 5 minutes.
 *
 * Mocking mirrors `span-limit-service.test.ts` — same Supabase chain
 * shape (`from().select().eq()[…].maybeSingle()`).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { createTestGatewayCache } from '@repo/gateway-core/test-helpers/test-gateway-cache';
import { StorageCapService } from './storage-cap-service';

const STORAGE_METER_ID = 'mtr_test_storage';

// --------------------------------------------------------------------------
// Mock factories
// --------------------------------------------------------------------------

function makeSupabaseMock(
  tierId: string,
  override: number | null = null,
  stripeCustomerId: string | null = 'cus_billing_row',
): SupabaseClient<any> {
  // One response object serves both billing reads: tier resolution picks
  // tier_id, the empty-caller customer lookup picks stripe_customer_id.
  const maybeSingleBilling = vi.fn().mockResolvedValue({
    data: { tier_id: tierId, stripe_customer_id: stripeCustomerId },
    error: null,
  });
  const eqBilling = vi.fn().mockReturnValue({ maybeSingle: maybeSingleBilling });
  const selectBilling = vi.fn().mockReturnValue({ eq: eqBilling });

  // `maybeSingle()` reports a missing override row as data:null with NO error;
  // an error there means a FAILED read, which the resolver refuses to cache.
  const maybeSingleOverride = vi.fn().mockResolvedValue(
    override !== null
      ? { data: { value: { v: override } }, error: null }
      : { data: null, error: null },
  );
  const eqOverrideKey = vi.fn().mockReturnValue({ maybeSingle: maybeSingleOverride });
  const eqOverrideTenant = vi.fn().mockReturnValue({ eq: eqOverrideKey });
  const selectOverride = vi.fn().mockReturnValue({ eq: eqOverrideTenant });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'billing') return { select: selectBilling };
    if (table === 'tenant_entitlement_override') return { select: selectOverride };
    return {};
  });

  return { from } as unknown as SupabaseClient<any>;
}

interface StripeMock {
  client: Stripe;
  listEventSummaries: ReturnType<typeof vi.fn>;
}

function makeStripeMock(aggregatedValueGb: number): StripeMock {
  const listEventSummaries = vi.fn().mockResolvedValue({
    data: [{ aggregated_value: aggregatedValueGb }],
  });
  const client = {
    billing: { meters: { listEventSummaries } },
  } as unknown as Stripe;
  return { client, listEventSummaries };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('StorageCapService.checkStorageCap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mid-month so the period-start computation has clear semantics
    // (2026-03-15 UTC → period starts 2026-03-01).
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hobby tier under cap: allowed=true, exact byte math, Stripe called with correct period and customer', async () => {
    // hobby tier default: 1 GB = 1_000_000_000 bytes.
    // 0.4 GB consumed → 400_000_000 bytes.
    const supabase = makeSupabaseMock('hobby');
    const stripe = makeStripeMock(0.4);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-1', 'cus_abc');

    // Exact toEqual on the result protects every field at once: a
    // refactor that returns `currentBytes` and `limitBytes` swapped
    // would pass a `.allowed` check alone but fail this assertion.
    expect(result).toEqual({
      allowed: true,
      currentBytes: 400_000_000,
      limitBytes: 1_000_000_000,
      capReached: false,
    });

    // 2026-03-01T00:00:00Z and 2026-03-15T12:00:00Z in unix seconds.
    expect(stripe.listEventSummaries).toHaveBeenCalledWith(STORAGE_METER_ID, {
      customer: 'cus_abc',
      start_time: Math.floor(Date.UTC(2026, 2, 1) / 1000),
      end_time: Math.floor(Date.UTC(2026, 2, 15, 12) / 1000),
    });
  });

  it('hobby tier exactly at cap: capReached=true (the >= boundary)', async () => {
    // 1.0 GB consumed against a 1 GB limit. The boundary is `>=` —
    // a mutation to `>` would still allow this exact-at-limit case.
    const supabase = makeSupabaseMock('hobby');
    const stripe = makeStripeMock(1.0);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-2', 'cus_at');

    expect(result.capReached).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.currentBytes).toBe(1_000_000_000);
    expect(result.limitBytes).toBe(1_000_000_000);
  });

  it('non-hobby tier: allowed=true with no Stripe call (growth/team billed via overage, enterprise unlimited)', async () => {
    // Growth tier is NOT cap-enforced at the gateway — Stripe handles
    // overage billing. A refactor that flipped `tierId !== 'hobby'`
    // to `===` would silently start blocking paying customers.
    const supabase = makeSupabaseMock('growth');
    const stripe = makeStripeMock(999); // would exceed any sane cap
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-growth', 'cus_growth');

    expect(result).toEqual({
      allowed: true,
      currentBytes: 0,
      limitBytes: 0,
      capReached: false,
    });
    // Negative assertion: Stripe must NOT be hit for non-hobby tiers.
    expect(stripe.listEventSummaries).not.toHaveBeenCalled();
  });

  it('admin override takes precedence over tier default when set above default', async () => {
    // Override of 10 GB on a hobby tier whose default is 1 GB. With
    // 5 GB consumed, the tenant should be allowed (under the override),
    // even though they would have been blocked under the default.
    // A refactor that inverted the override precedence check would
    // produce `allowed: false` here.
    const supabase = makeSupabaseMock('hobby', 10);
    const stripe = makeStripeMock(5);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-override', 'cus_over');

    expect(result).toEqual({
      allowed: true,
      currentBytes: 5_000_000_000,
      limitBytes: 10_000_000_000,
      capReached: false,
    });
  });

  it('override of UNLIMITED (-1) on hobby: allowed=true with no Stripe call', async () => {
    // An override of -1 means "lift the cap entirely". Stripe must
    // NOT be called — the service should short-circuit. A regression
    // removing this branch would issue a Stripe call on every check.
    const supabase = makeSupabaseMock('hobby', -1);
    const stripe = makeStripeMock(999);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-unlimited', 'cus_unl');

    expect(result.allowed).toBe(true);
    expect(result.limitBytes).toBe(-1);
    expect(result.capReached).toBe(false);
    expect(stripe.listEventSummaries).not.toHaveBeenCalled();
  });

  it('fail-soft: any error returns allowed=true so the gateway does NOT block ingestion on outages', async () => {
    // Make Stripe throw. The contract is fail-open: ingestion must
    // continue. A refactor that propagated the error or returned
    // `allowed: false` would shut the gateway off whenever Stripe
    // is degraded.
    const supabase = makeSupabaseMock('hobby');
    const listEventSummaries = vi
      .fn()
      .mockRejectedValue(new Error('Stripe API timeout'));
    const stripe = {
      billing: { meters: { listEventSummaries } },
    } as unknown as Stripe;

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const service = new StorageCapService(supabase, stripe, STORAGE_METER_ID, createTestGatewayCache());
    const result = await service.checkStorageCap('tenant-err', 'cus_err');

    expect(result.allowed).toBe(true);
    expect(result.capReached).toBe(false);
    expect(result.limitBytes).toBe(-1);
    // Side-effect: error was logged (preserves the operator signal
    // without breaking ingestion).
    expect(consoleError).toHaveBeenCalledWith(
      '[storage-cap] Failed to check cap for tenant tenant-err:',
      expect.any(Error),
    );
  });

  it('5-minute capCache TTL: second check within window reuses the cached result; expired cache re-queries', async () => {
    const supabase = makeSupabaseMock('hobby');
    const stripe = makeStripeMock(0.2);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    // First call populates the cache.
    await service.checkStorageCap('tenant-cache', 'cus_cache');
    expect(stripe.listEventSummaries).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('billing');

    // Within the 5-minute TTL: cache hit, no fresh calls to Stripe
    // or Supabase.
    vi.advanceTimersByTime(3 * 60 * 1000);
    stripe.listEventSummaries.mockClear();
    (supabase.from as ReturnType<typeof vi.fn>).mockClear();

    await service.checkStorageCap('tenant-cache', 'cus_cache');
    expect(stripe.listEventSummaries).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();

    // Past the 5-minute TTL: cache misses and a fresh Stripe call fires.
    vi.advanceTimersByTime(3 * 60 * 1000); // total 6 minutes since first call
    await service.checkStorageCap('tenant-cache', 'cus_cache');
    expect(stripe.listEventSummaries).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache the fail-open verdict when Stripe errors', async () => {
    // Failing open keeps ingest flowing during a Stripe outage. Caching that
    // `allowed: true` would leave caps unenforced for 5 minutes after Stripe
    // recovers, so the next check has to ask again.
    const supabase = makeSupabaseMock('hobby');
    const listEventSummaries = vi
      .fn()
      .mockRejectedValueOnce(new Error('Stripe API timeout'))
      .mockResolvedValue({ data: [{ aggregated_value: 1.0 }] });
    const stripe = { billing: { meters: { listEventSummaries } } } as unknown as Stripe;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const service = new StorageCapService(
      supabase,
      stripe,
      STORAGE_METER_ID,
      createTestGatewayCache(),
    );

    const degraded = await service.checkStorageCap('tenant-flap', 'cus_flap');
    expect(degraded).toEqual({
      allowed: true,
      currentBytes: 0,
      limitBytes: -1,
      capReached: false,
    });

    // Well inside the 5-minute TTL — a cached fail-open would win here.
    vi.advanceTimersByTime(30 * 1000);
    const recovered = await service.checkStorageCap('tenant-flap', 'cus_flap');

    expect(listEventSummaries).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual({
      allowed: false,
      currentBytes: 1_000_000_000,
      limitBytes: 1_000_000_000,
      capReached: true,
    });
  });

  it('cache isolation: separate tenants must not share cached results (key by tenantId, not stripeCustomerId)', async () => {
    // The service caches per-tenant. A refactor that keyed by
    // `stripeCustomerId` (or any other non-tenant field) would leak
    // results across tenants. This catches that bug class explicitly:
    // tenant-A's hobby+at-cap result must not be returned for tenant-B.
    const supabase = makeSupabaseMock('hobby');
    const stripe = makeStripeMock(0); // tenant-A starts at 0 GB

    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const resultA = await service.checkStorageCap('tenant-A', 'cus_shared');
    expect(resultA.capReached).toBe(false);

    // Same Stripe customer, different tenant — must not return
    // tenant-A's cached value. Push a different Stripe response so
    // tenant-B's fresh lookup produces a distinguishable result.
    stripe.listEventSummaries.mockResolvedValueOnce({
      data: [{ aggregated_value: 1.0 }],
    });

    const resultB = await service.checkStorageCap('tenant-B', 'cus_shared');
    expect(resultB.capReached).toBe(true);
    expect(resultB.currentBytes).toBe(1_000_000_000);
  });

  it('resolves the customer id from the billing row when the caller carries none (bearer sessions)', async () => {
    const supabase = makeSupabaseMock('hobby', null, 'cus_from_billing');
    const stripe = makeStripeMock(1.5);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-1', '');

    // The gate would otherwise be bypassed by any auth path that mints an
    // empty customer id — the meter must still be consulted for the tenant.
    expect(stripe.listEventSummaries).toHaveBeenCalledWith(
      STORAGE_METER_ID,
      expect.objectContaining({ customer: 'cus_from_billing' }),
    );
    expect(result).toEqual({
      allowed: false,
      currentBytes: 1_500_000_000,
      limitBytes: 1_000_000_000,
      capReached: true,
    });
  });

  it('a tenant with no billing customer at all is allowed without touching Stripe, and the verdict caches', async () => {
    const supabase = makeSupabaseMock('hobby', null, null);
    const stripe = makeStripeMock(99);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const first = await service.checkStorageCap('tenant-1', '');
    const second = await service.checkStorageCap('tenant-1', '');

    expect(first).toEqual({ allowed: true, currentBytes: 0, limitBytes: 0, capReached: false });
    expect(second).toEqual(first);
    expect(stripe.listEventSummaries).not.toHaveBeenCalled();
    // Cached: the second check must not re-read billing.
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.filter(([t]) => t === 'billing')).toHaveLength(2);
  });

  it('sends minute-aligned window bounds to the Stripe meter API', async () => {
    // Stripe rejects arbitrary-second bounds; an unaligned end_time turns
    // the cap into a guaranteed 400 → permanent fail-open.
    vi.setSystemTime(new Date('2026-03-15T12:07:23.456Z'));
    const supabase = makeSupabaseMock('hobby');
    const stripe = makeStripeMock(0.1);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    await service.checkStorageCap('tenant-1', 'cus_abc');

    const [, args] = stripe.listEventSummaries.mock.calls[0]!;
    expect(args.start_time % 60).toBe(0);
    expect(args.end_time % 60).toBe(0);
    expect(args.end_time).toBe(Math.floor(Date.UTC(2026, 2, 15, 12, 7) / 1000));
  });

  it('the first minute of a billing month allows without a Stripe call (empty window)', async () => {
    vi.setSystemTime(new Date('2026-03-01T00:00:30.000Z'));
    const supabase = makeSupabaseMock('hobby');
    const stripe = makeStripeMock(99);
    const service = new StorageCapService(supabase, stripe.client, STORAGE_METER_ID, createTestGatewayCache());

    const result = await service.checkStorageCap('tenant-1', 'cus_abc');

    expect(result).toEqual({ allowed: true, currentBytes: 0, limitBytes: 1_000_000_000, capReached: false });
    expect(stripe.listEventSummaries).not.toHaveBeenCalled();
  });
});
