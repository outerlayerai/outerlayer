/**
 * Unit tests for SpanLimitService
 *
 * Tests span limit enforcement logic with mocked ClickHouse and Supabase clients.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SpanLimitService, type ISpanLimitService } from './span-limit-service';
import type { IClickHouseService } from './clickhouse-service';
import { createTestGatewayCache } from '../test-helpers/test-gateway-cache';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockClickHouse(countResult = 0): IClickHouseService {
  return {
    insertTraces: vi.fn(),
    query: vi.fn().mockResolvedValue([{ count: String(countResult) }]),
  };
}

/**
 * Creates a ClickHouse mock that records the query string passed to .query(),
 * enabling tests to assert on the exact SQL used by getMonthlyCount.
 */
function createQueryCapturingClickHouse(countResult = 0): IClickHouseService & { capturedQuery: string | null } {
  const mock: IClickHouseService & { capturedQuery: string | null } = {
    capturedQuery: null,
    insertTraces: vi.fn(),
    query: vi.fn().mockImplementation((sql: string) => {
      mock.capturedQuery = sql;
      return Promise.resolve([{ count: String(countResult) }]);
    }),
  };
  return mock;
}

/** Sentinel distinguishing "no override row" from "a row holding `undefined`". */
const NO_OVERRIDE_ROW = Symbol('no-override-row');

/**
 * Build a mock Supabase client over the `maybeSingle()` chain the resolver uses.
 *
 * `rawOverrideValue` is the raw `value` column (before `.v` extraction), so
 * tests can drive malformed JSONB. `maybeSingle()` reports a missing row as
 * `{ data: null, error: null }` — an ERROR there means a failed read, which the
 * resolver treats as degraded and refuses to cache.
 */
function createMockSupabaseWithRawOverride(
  tierId: string,
  rawOverrideValue: unknown = NO_OVERRIDE_ROW,
) {
  const maybeSingleBilling = vi.fn().mockResolvedValue({
    data: { tier_id: tierId },
    error: null,
  });
  const eqBilling = vi.fn().mockReturnValue({ maybeSingle: maybeSingleBilling });
  const selectBilling = vi.fn().mockReturnValue({ eq: eqBilling });

  const maybeSingleOverride = vi.fn().mockResolvedValue(
    rawOverrideValue !== NO_OVERRIDE_ROW
      ? { data: { value: rawOverrideValue }, error: null }
      : { data: null, error: null }
  );
  const eqOverrideKey = vi.fn().mockReturnValue({ maybeSingle: maybeSingleOverride });
  const eqOverrideTenant = vi.fn().mockReturnValue({ eq: eqOverrideKey });
  const selectOverride = vi.fn().mockReturnValue({ eq: eqOverrideTenant });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'billing') {
      return { select: selectBilling };
    }
    if (table === 'tenant_entitlement_override') {
      return { select: selectOverride };
    }
    return {};
  });

  return { from } as any;
}

function createMockSupabase(tierId = 'hobby', override: number | null = null) {
  return createMockSupabaseWithRawOverride(
    tierId,
    override !== null ? { v: override } : NO_OVERRIDE_ROW,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpanLimitService', () => {
  let service: ISpanLimitService;
  let mockClickHouse: IClickHouseService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Hobby tenant under limit', () => {
    it('returns allowed=true when count is below limit', async () => {
      mockClickHouse = createMockClickHouse(15000);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-hobby');

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(15000);
      expect(result.limit).toBe(20000);
      expect(result.remaining).toBe(5000);
    });
  });

  describe('Hobby tenant at limit', () => {
    it('returns allowed=false when count equals limit', async () => {
      mockClickHouse = createMockClickHouse(20000);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-hobby');

      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(20000);
      expect(result.limit).toBe(20000);
      expect(result.remaining).toBe(0);
    });

    it('returns allowed=false when count exceeds limit', async () => {
      mockClickHouse = createMockClickHouse(20001);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-hobby');

      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(20001);
      expect(result.limit).toBe(20000);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Paid metered tenants — ingest is never blocked (usage is billed, not capped)', () => {
    it('growth: allowed with unlimited limit, count query skipped', async () => {
      mockClickHouse = createMockClickHouse(5000);
      const mockSupabase = createMockSupabase('growth');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-growth');

      expect(result).toEqual({ allowed: true, currentCount: 0, limit: -1, remaining: -1 });
      expect(mockClickHouse.query).not.toHaveBeenCalled();
    });

    it('team: allowed with unlimited limit even at 10M spans, count query skipped', async () => {
      mockClickHouse = createMockClickHouse(10_000_000);
      const mockSupabase = createMockSupabase('team');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-team');

      expect(result).toEqual({ allowed: true, currentCount: 0, limit: -1, remaining: -1 });
      expect(mockClickHouse.query).not.toHaveBeenCalled();
    });
  });

  describe('Enterprise tenant — always allowed', () => {
    it('returns allowed=true with unlimited limit', async () => {
      mockClickHouse = createMockClickHouse(0);
      const mockSupabase = createMockSupabase('enterprise');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-enterprise');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
      expect(result.remaining).toBe(-1);
      expect(mockClickHouse.query).not.toHaveBeenCalled();
    });
  });

  describe('Hobby tenant with override of 50000', () => {
    it('uses override limit instead of tier default', async () => {
      mockClickHouse = createMockClickHouse(25000);
      const mockSupabase = createMockSupabase('hobby', 50000);
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-override');

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(25000);
      expect(result.limit).toBe(50000);
      expect(result.remaining).toBe(25000);
    });

    it('rejects when count exceeds override limit', async () => {
      mockClickHouse = createMockClickHouse(50000);
      const mockSupabase = createMockSupabase('hobby', 50000);
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-override');

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(50000);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Hobby tenant with unlimited override (-1)', () => {
    it('should skip ClickHouse query when override is unlimited', async () => {
      mockClickHouse = createMockClickHouse(0);
      const mockSupabase = createMockSupabase('hobby', -1);
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-unlimited-override');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
      expect(result.remaining).toBe(-1);
      expect(mockClickHouse.query).not.toHaveBeenCalled();
    });
  });

  describe('Tier cache behavior', () => {
    it('returns cached tier within 5 min without re-querying Supabase', async () => {
      const mockSupabase = createMockSupabase('hobby');
      mockClickHouse = createMockClickHouse(100);
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      // First call populates cache
      await service.checkSpanLimit('tenant-cache');
      expect(mockSupabase.from).toHaveBeenCalledWith('billing');

      // Reset call tracking
      mockSupabase.from.mockClear();

      // Advance 3 minutes (within 5 min TTL)
      vi.advanceTimersByTime(3 * 60 * 1000);

      // Second call should use cache, not query Supabase again
      await service.checkSpanLimit('tenant-cache');
      expect(mockSupabase.from).not.toHaveBeenCalledWith('billing');
    });

    it('re-fetches tier after 5 min cache expires', async () => {
      const mockSupabase = createMockSupabase('hobby');
      mockClickHouse = createMockClickHouse(100);
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      await service.checkSpanLimit('tenant-cache');
      mockSupabase.from.mockClear();

      // Advance past 5 min TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await service.checkSpanLimit('tenant-cache');
      expect(mockSupabase.from).toHaveBeenCalledWith('billing');
    });
  });

  describe('Count cache behavior', () => {
    it('returns cached count within 60s without re-querying ClickHouse', async () => {
      mockClickHouse = createMockClickHouse(100);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      // First call populates count cache
      await service.checkSpanLimit('tenant-count');
      expect(mockClickHouse.query).toHaveBeenCalledTimes(1);

      // Advance 30 seconds (within 60s TTL)
      vi.advanceTimersByTime(30 * 1000);

      // Second call should use cached count
      await service.checkSpanLimit('tenant-count');
      expect(mockClickHouse.query).toHaveBeenCalledTimes(1); // no additional call
    });

    it('re-fetches count after 60s cache expires', async () => {
      mockClickHouse = createMockClickHouse(100);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      await service.checkSpanLimit('tenant-count');
      expect(mockClickHouse.query).toHaveBeenCalledTimes(1);

      // Advance past 60s TTL
      vi.advanceTimersByTime(60 * 1000 + 1);

      await service.checkSpanLimit('tenant-count');
      expect(mockClickHouse.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('Edge cases', () => {
    it('defaults to hobby tier when the tenant has no billing row', async () => {
      mockClickHouse = createMockClickHouse(20000);
      const mockSupabase = createMockSupabase('hobby');
      // `maybeSingle()` reports "no row" as data:null with NO error.
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'billing') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }
        if (table === 'tenant_entitlement_override') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        return {};
      });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-missing');

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(20000);
    });

    it('falls back to hobby on a FAILED billing read but does not cache that fallback', async () => {
      // A failed read tells us nothing. Caching its hobby fallback would cap a
      // paying tenant for 5 minutes, so the next request has to re-read.
      mockClickHouse = createMockClickHouse(20000);
      const mockSupabase = createMockSupabase('hobby');
      const failingBillingRead = vi
        .fn()
        .mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'billing') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ maybeSingle: failingBillingRead }),
            }),
          };
        }
        if (table === 'tenant_entitlement_override') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        return {};
      });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const first = await service.checkSpanLimit('tenant-degraded');
      expect(first.limit).toBe(20000);
      expect(failingBillingRead).toHaveBeenCalledTimes(1);

      // Well inside the 5-min TTL a cached value would have been served.
      vi.advanceTimersByTime(60 * 1000);
      await service.checkSpanLimit('tenant-degraded');

      expect(failingBillingRead).toHaveBeenCalledTimes(2);
    });

    it('handles zero count correctly', async () => {
      mockClickHouse = createMockClickHouse(0);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-new');

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.remaining).toBe(20000);
    });
  });

  // -------------------------------------------------------------------------
  // JSONB override parsing — Supabase returns JSONB columns as { v: <value> }
  // -------------------------------------------------------------------------

  describe('JSONB override parsing', () => {
    it('parses numeric value inside { v: number }', async () => {
      mockClickHouse = createMockClickHouse(30000);
      const mockSupabase = createMockSupabaseWithRawOverride('hobby', { v: 50000 });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-jsonb-num');

      expect(result.limit).toBe(50000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(20000);
    });

    it('parses string-numeric value inside { v: "75000" }', async () => {
      mockClickHouse = createMockClickHouse(10000);
      const mockSupabase = createMockSupabaseWithRawOverride('hobby', { v: '75000' });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-jsonb-str');

      expect(result.limit).toBe(75000);
      expect(result.allowed).toBe(true);
    });

    it('treats { v: -1 } as unlimited and skips ClickHouse query', async () => {
      mockClickHouse = createMockClickHouse(0);
      const mockSupabase = createMockSupabaseWithRawOverride('hobby', { v: -1 });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-jsonb-unlimited');

      expect(result.limit).toBe(-1);
      expect(result.allowed).toBe(true);
      expect(mockClickHouse.query).not.toHaveBeenCalled();
    });

    it('falls back to tier default when { v: null }', async () => {
      mockClickHouse = createMockClickHouse(15000);
      const mockSupabase = createMockSupabaseWithRawOverride('hobby', { v: null });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-jsonb-null-v');

      // null .v is ignored — falls back to hobby tier default
      expect(result.limit).toBe(20000);
      expect(result.allowed).toBe(true);
    });

    it('falls back to tier default when JSONB has no .v property', async () => {
      mockClickHouse = createMockClickHouse(19000);
      // Simulate a malformed JSONB value with no `.v` key
      const mockSupabase = createMockSupabaseWithRawOverride('hobby', { amount: 100000 });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-jsonb-no-v');

      // Should fall back to hobby default (20000), not use 100000
      expect(result.limit).toBe(20000);
      expect(result.allowed).toBe(true);
    });

    it('falls back to tier default when JSONB value is a bare number (no wrapper)', async () => {
      mockClickHouse = createMockClickHouse(19999);
      // Supabase shouldn't return this, but guard against it
      const mockSupabase = createMockSupabaseWithRawOverride('hobby', 50000);
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-jsonb-bare-num');

      // Number(undefined) → NaN, so override is ignored, falls back to 20000
      expect(result.limit).toBe(20000);
      expect(result.allowed).toBe(true);
    });

    it('override on growth tier reduces limit from unlimited', async () => {
      mockClickHouse = createMockClickHouse(90000);
      const mockSupabase = createMockSupabaseWithRawOverride('growth', { v: 100000 });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-growth-override');

      // Override replaces the growth unlimited (-1) with a concrete limit
      expect(result.limit).toBe(100000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10000);
    });

    it('override on growth tier blocks when count exceeds override', async () => {
      mockClickHouse = createMockClickHouse(100001);
      const mockSupabase = createMockSupabaseWithRawOverride('growth', { v: 100000 });
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-growth-capped');

      expect(result.limit).toBe(100000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Billing query correctness — guards against CreatedAt/Timestamp regression
  // -------------------------------------------------------------------------

  describe('Billing query uses CreatedAt column', () => {
    it('should include CreatedAt in the ClickHouse query string when counting monthly spans', async () => {
      const capturingClickHouse = createQueryCapturingClickHouse(5000);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(capturingClickHouse, mockSupabase, createTestGatewayCache());

      await service.checkSpanLimit('tenant-query-check');

      expect(capturingClickHouse.capturedQuery).not.toBeNull();
      expect(capturingClickHouse.capturedQuery).toContain('CreatedAt');
    });

    it('should use toYYYYMM(CreatedAt) not toYYYYMM(Timestamp) in the billing query', async () => {
      const capturingClickHouse = createQueryCapturingClickHouse(0);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(capturingClickHouse, mockSupabase, createTestGatewayCache());

      await service.checkSpanLimit('tenant-query-column');

      expect(capturingClickHouse.capturedQuery).toContain('toYYYYMM(CreatedAt)');
      expect(capturingClickHouse.capturedQuery).not.toContain('toYYYYMM(Timestamp)');
    });

    it('should return 0 count when ClickHouse returns zero rows', async () => {
      mockClickHouse = createMockClickHouse(0);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-zero-count');

      expect(result.currentCount).toBe(0);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(20000);
    });

    it('should return the exact non-zero count from ClickHouse when rows are returned', async () => {
      mockClickHouse = createMockClickHouse(12345);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache());

      const result = await service.checkSpanLimit('tenant-nonzero-count');

      expect(result.currentCount).toBe(12345);
    });

    it('should include TenantId filter in the ClickHouse query when counting monthly spans', async () => {
      const capturingClickHouse = createQueryCapturingClickHouse(0);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(capturingClickHouse, mockSupabase, createTestGatewayCache());

      await service.checkSpanLimit('tenant-filter-check');

      expect(capturingClickHouse.capturedQuery).toContain('TenantId');
    });
  });

  // Self-host mode: ingest is uncapped and the check performs no I/O
  // at all — a billing read would resolve the tenant as hobby (20k cap), and
  // a ClickHouse count is pure overhead against an infinite limit.
  describe('Self-host mode', () => {
    it('returns unlimited without touching Supabase or ClickHouse', async () => {
      mockClickHouse = createMockClickHouse(999_999_999);
      const mockSupabase = createMockSupabase('hobby'); // would cap at 20k if read
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache(), { selfHost: true });

      const result = await service.checkSpanLimit('tenant-selfhost');

      expect(result).toEqual({ allowed: true, currentCount: 0, limit: -1, remaining: -1 });
      expect(mockClickHouse.query).not.toHaveBeenCalled();
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('selfHost=false keeps the Cloud billing path byte-for-byte (hobby caps apply)', async () => {
      mockClickHouse = createMockClickHouse(25000);
      const mockSupabase = createMockSupabase('hobby');
      service = new SpanLimitService(mockClickHouse, mockSupabase, createTestGatewayCache(), { selfHost: false });

      const result = await service.checkSpanLimit('tenant-cloud');

      expect(result).toEqual({ allowed: false, currentCount: 25000, limit: 20000, remaining: 0 });
      expect(mockSupabase.from).toHaveBeenCalledWith('billing');
    });
  });
});
