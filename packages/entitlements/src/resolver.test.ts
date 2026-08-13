/**
 * Tests for the shared resolver. This is the ONE place the override →
 * tier → hobby-default resolution semantics are pinned. Gateway and
 * dashboard wrap this resolver but don't re-test its internals — they
 * test their consumer-specific behavior (middleware envelopes,
 * EntitlementService rich result shapes).
 *
 * Tests use MSW + a real `createClient<Database>()` so we exercise the
 * actual postgrest-js chain rather than a hand-rolled fake that could
 * drift from supabase-js's behaviour. This matches how the consumer
 * apps test the same boundary (gateway: `gatewaySupabaseHandlers`,
 * dashboard: `supabaseHandlers`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@repo/db-types';
import {
  resolveBoolean,
  resolveNumeric,
  resolveBooleanEntitlement,
  resolveNumericLimit,
  resolveNumericLimitForAllTenants,
  readAllOverrides,
  quotaCheck,
  type TierMatrix,
} from './resolver';

// ---------------------------------------------------------------------------
// MSW setup — minimal postgrest stubs for the two tables the resolver
// touches.
// ---------------------------------------------------------------------------

const SUPABASE_URL = 'http://localhost:54321';

type OverrideRow = {
  tenant_id: string;
  entitlement_key: string;
  value: { v: unknown };
};

type BillingRow = {
  tenant_id: string;
  tier_id: string;
};

interface State {
  overrides: OverrideRow[];
  billing: BillingRow[];
  overrideError: { message: string } | null;
  billingError: { message: string } | null;
}

const state: State = {
  overrides: [],
  billing: [],
  overrideError: null,
  billingError: null,
};

function reset() {
  state.overrides = [];
  state.billing = [];
  state.overrideError = null;
  state.billingError = null;
  capturedPageRequests.length = 0;
}

function eqParam(url: URL, col: string): string | null {
  const raw = url.searchParams.get(col);
  if (!raw) return null;
  return raw.startsWith('eq.') ? raw.slice(3) : raw;
}

function wantsSingle(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('vnd.pgrst.object');
}

/**
 * Apply PostgREST's `offset`/`limit` params (what postgrest-js `.range()`
 * encodes) so the batch resolver's pagination exercises real slicing.
 */
function sliceRange<T>(url: URL, rows: T[]): T[] {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? rows.length : Number(limitRaw);
  return rows.slice(offset, offset + limit);
}

/**
 * Wire-level capture for the batch resolver's pagination params. Stable
 * keyset pagination REQUIRES `order=id.asc` + exact 1000-row windows —
 * without the order, PostgREST page composition is unspecified and
 * concurrent writes make the scan drop/duplicate tenants. That property
 * can't be exercised with static fixtures, so the requests themselves are
 * the observable contract.
 */
interface CapturedPageRequest {
  table: string;
  order: string | null;
  offset: string | null;
  limit: string | null;
}
const capturedPageRequests: CapturedPageRequest[] = [];

function capturePageRequest(table: string, url: URL) {
  capturedPageRequests.push({
    table,
    order: url.searchParams.get('order'),
    offset: url.searchParams.get('offset'),
    limit: url.searchParams.get('limit'),
  });
}

const handlers = [
  http.get(`${SUPABASE_URL}/rest/v1/tenant_entitlement_override`, ({ request }) => {
    if (state.overrideError) {
      return HttpResponse.json(
        { message: state.overrideError.message },
        { status: 500 },
      );
    }
    const url = new URL(request.url);
    capturePageRequest('tenant_entitlement_override', url);
    const tenantId = eqParam(url, 'tenant_id');
    const key = eqParam(url, 'entitlement_key');
    const rows = state.overrides.filter(
      (r) =>
        (tenantId ? r.tenant_id === tenantId : true) &&
        (key ? r.entitlement_key === key : true),
    );
    if (wantsSingle(request)) {
      return HttpResponse.json(rows[0] ?? null);
    }
    return HttpResponse.json(sliceRange(url, rows));
  }),

  http.get(`${SUPABASE_URL}/rest/v1/billing`, ({ request }) => {
    if (state.billingError) {
      return HttpResponse.json(
        { message: state.billingError.message },
        { status: 500 },
      );
    }
    const url = new URL(request.url);
    capturePageRequest('billing', url);
    const tenantId = eqParam(url, 'tenant_id');
    const rows = state.billing.filter((r) => (tenantId ? r.tenant_id === tenantId : true));
    if (wantsSingle(request)) {
      return HttpResponse.json(rows[0] ?? null);
    }
    return HttpResponse.json(sliceRange(url, rows));
  }),
];

const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  reset();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  reset();
});

// ---------------------------------------------------------------------------
// Real supabase-js client pointed at the MSW server.
// ---------------------------------------------------------------------------

function makeClient() {
  return createClient<Database>(SUPABASE_URL, 'test-service-role-key', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const TENANT = '11111111-1111-4111-8111-111111111111';

const BOOL_MATRIX: TierMatrix<boolean> = {
  hobby: false,
  growth: true,
  team: true,
  enterprise: true,
};

const NUM_MATRIX: TierMatrix<number> = {
  hobby: 1,
  growth: 5,
  team: 25,
  enterprise: -1,
};

// ===========================================================================
// resolveBoolean (matrix-agnostic — dashboard's primary entry point)
// ===========================================================================

describe('resolveBoolean', () => {
  it('returns the boolean override when present', async () => {
    state.overrides.push({ tenant_id: TENANT, entitlement_key: 'k', value: { v: true } });
    state.billing.push({ tenant_id: TENANT, tier_id: 'hobby' });
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(true);
  });

  it('returns the false override even on a tier whose matrix value is true', async () => {
    // Negative overrides revoke access mid-trial. Must win over the
    // tier matrix or the revocation has no effect.
    state.overrides.push({ tenant_id: TENANT, entitlement_key: 'k', value: { v: false } });
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(false);
  });

  it('falls through to the tier matrix when no override exists', async () => {
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(true);
  });

  it('uses the hobby matrix value when no billing row exists', async () => {
    // New tenants pre-checkout — matches the cron's behaviour.
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(false);
  });

  it('ignores non-boolean override values', async () => {
    // Numeric override on a boolean key would coerce to truthy and grant
    // access on tiers where the matrix says no. Must be ignored.
    state.overrides.push({ tenant_id: TENANT, entitlement_key: 'k', value: { v: 100 } });
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(true);
  });

  it('falls through to tier when the override read errors', async () => {
    state.overrideError = { message: 'transient pg error' };
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(true);
  });

  it('falls closed to hobby when both reads error', async () => {
    state.overrideError = { message: 'pg error' };
    state.billingError = { message: 'pg error' };
    expect(await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX)).toBe(false);
  });

  it('propagates throws from the supabase client itself', async () => {
    // supabase-js v2 catches fetch errors and surfaces them via `.error`
    // on the response — it does NOT throw on network failures. The
    // resolver's try/catch in consumers is for the rarer path where
    // `.from()` itself throws (malformed URL, client misconfiguration,
    // etc.). Synthesise that here with a stub that throws on `.from()`.
    const broken = {
      from() {
        throw new Error('synthetic supabase outage');
      },
    } as unknown as ReturnType<typeof makeClient>;
    await expect(
      resolveBoolean(broken, TENANT, 'k', BOOL_MATRIX),
    ).rejects.toThrow('synthetic supabase outage');
  });

  it('routes failure-log messages to the supplied logger', async () => {
    const warn = vi.fn();
    state.overrideError = { message: 'transient pg error' };
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    await resolveBoolean(makeClient(), TENANT, 'k', BOOL_MATRIX, { warn });
    expect(warn).toHaveBeenCalledWith(
      'entitlements override lookup failed',
      expect.objectContaining({ tenantId: TENANT, key: 'k' }),
    );
  });
});

// ===========================================================================
// resolveNumeric (matrix-agnostic)
// ===========================================================================

describe('resolveNumeric', () => {
  it('returns the numeric override when present', async () => {
    state.overrides.push({ tenant_id: TENANT, entitlement_key: 'k', value: { v: 50 } });
    state.billing.push({ tenant_id: TENANT, tier_id: 'hobby' });
    expect(await resolveNumeric(makeClient(), TENANT, 'k', NUM_MATRIX)).toBe(50);
  });

  it('returns the tier-matrix value when no override exists', async () => {
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(await resolveNumeric(makeClient(), TENANT, 'k', NUM_MATRIX)).toBe(25);
  });

  it('uses the hobby matrix value when no billing row exists', async () => {
    expect(await resolveNumeric(makeClient(), TENANT, 'k', NUM_MATRIX)).toBe(1);
  });

  it('ignores boolean override values', async () => {
    // `true` coerces to 1 — would silently shrink the quota from 25
    // to 1 on hobby. Must be ignored so the tier matrix is honoured.
    state.overrides.push({ tenant_id: TENANT, entitlement_key: 'k', value: { v: true } });
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(await resolveNumeric(makeClient(), TENANT, 'k', NUM_MATRIX)).toBe(25);
  });

  it('honors a negative numeric override (UNLIMITED for one tenant)', async () => {
    // A specific tenant being granted unlimited on hobby — common
    // friends-and-family / migration scenario.
    state.overrides.push({ tenant_id: TENANT, entitlement_key: 'k', value: { v: -1 } });
    state.billing.push({ tenant_id: TENANT, tier_id: 'hobby' });
    expect(await resolveNumeric(makeClient(), TENANT, 'k', NUM_MATRIX)).toBe(-1);
  });
});

// ===========================================================================
// readAllOverrides (bulk read for the dashboard's entitlement panel)
// ===========================================================================

describe('readAllOverrides', () => {
  it('unwraps every well-typed override row', async () => {
    state.overrides.push(
      { tenant_id: TENANT, entitlement_key: 'max_apps', value: { v: 50 } },
      { tenant_id: TENANT, entitlement_key: 'workers_enabled', value: { v: true } },
      { tenant_id: TENANT, entitlement_key: 'support_level', value: { v: 'dedicated' } },
    );
    expect(await readAllOverrides(makeClient(), TENANT)).toEqual([
      { entitlementKey: 'max_apps', value: 50 },
      { entitlementKey: 'workers_enabled', value: true },
      { entitlementKey: 'support_level', value: 'dedicated' },
    ]);
  });

  it('scopes to the requested tenant (does not leak other tenants)', async () => {
    // The MSW handler enforces the `?tenant_id=eq.X` filter that the
    // postgrest builder appends. Without this assertion the resolver
    // could be silently returning every tenant's rows.
    const OTHER = '22222222-2222-4222-8222-222222222222';
    state.overrides.push(
      { tenant_id: TENANT, entitlement_key: 'mine', value: { v: true } },
      { tenant_id: OTHER, entitlement_key: 'theirs', value: { v: false } },
    );
    const rows = await readAllOverrides(makeClient(), TENANT);
    expect(rows).toEqual([{ entitlementKey: 'mine', value: true }]);
  });

  it('skips rows where value.v is not boolean/number/string and logs the skip', async () => {
    // Defensive — the override schema doesn't enforce primitives at the
    // DB level. A malformed row must not crash the resolver, AND it
    // must surface a log so operators see the bad data.
    const warn = vi.fn();
    state.overrides.push(
      { tenant_id: TENANT, entitlement_key: 'good', value: { v: 'ok' } },
      { tenant_id: TENANT, entitlement_key: 'malformed_object', value: { v: { nested: true } } },
      { tenant_id: TENANT, entitlement_key: 'malformed_null', value: { v: null } },
    );
    expect(await readAllOverrides(makeClient(), TENANT, { warn })).toEqual([
      { entitlementKey: 'good', value: 'ok' },
    ]);
    // Two malformed rows, two warnings.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'skipping malformed override row',
      expect.objectContaining({
        tenantId: TENANT,
        entitlementKey: 'malformed_object',
      }),
    );
  });

  it('returns [] on read errors and logs the failure', async () => {
    const warn = vi.fn();
    state.overrideError = { message: 'pg error' };
    expect(await readAllOverrides(makeClient(), TENANT, { warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'entitlements bulk override lookup failed',
      expect.objectContaining({ tenantId: TENANT, message: 'pg error' }),
    );
  });

  it('returns [] when no rows exist', async () => {
    expect(await readAllOverrides(makeClient(), TENANT)).toEqual([]);
  });
});

// ===========================================================================
// quotaCheck (pure — no HTTP boundary, no MSW)
// ===========================================================================

describe('quotaCheck', () => {
  it('allows when count is below the limit', () => {
    expect(quotaCheck(24, 25)).toEqual({ allowed: true, remaining: 1 });
  });

  it('denies when count equals the limit', () => {
    // count < limit semantics — a write that would push to count+1 is
    // blocked when count is already at the limit.
    expect(quotaCheck(25, 25)).toEqual({ allowed: false, remaining: 0 });
  });

  it('denies when count exceeds the limit', () => {
    // Tenant was granted a higher override that was later removed —
    // they still exist above the matrix limit. Block further writes.
    expect(quotaCheck(30, 25)).toEqual({ allowed: false, remaining: 0 });
  });

  it('always allows when limit is UNLIMITED (-1)', () => {
    // The sentinel that doomed `count >= -1` naive comparisons. The
    // helper is the one place we encode this so future quota consumers
    // can't reinvent the bug.
    expect(quotaCheck(0, -1)).toEqual({ allowed: true, remaining: Infinity });
    expect(quotaCheck(999_999, -1)).toEqual({ allowed: true, remaining: Infinity });
  });

  it('denies at limit = 0 (zero capacity = explicit deny)', () => {
    // Edge case worth pinning: limit 0 is a valid "denied entirely"
    // configuration. count >= 0 means even the first write fails.
    expect(quotaCheck(0, 0)).toEqual({ allowed: false, remaining: 0 });
  });
});

// ===========================================================================
// Tier-config-narrow convenience wrappers — verify they plug into the
// real tier-config matrix (catches drift between this package and
// `@repo/tier-config/tiers.json`).
// ===========================================================================

describe('resolveBooleanEntitlement (narrow wrapper)', () => {
  it('returns the tier-config value for workers_enabled on hobby', async () => {
    state.billing.push({ tenant_id: TENANT, tier_id: 'hobby' });
    expect(
      await resolveBooleanEntitlement(makeClient(), TENANT, 'workers_enabled'),
    ).toBe(false);
  });

  it('returns the tier-config value for workers_enabled on team', async () => {
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(
      await resolveBooleanEntitlement(makeClient(), TENANT, 'workers_enabled'),
    ).toBe(true);
  });
});

describe('resolveNumericLimit (narrow wrapper)', () => {
  it('returns 25 (hobby max_api_keys) from the real tier-config matrix', async () => {
    state.billing.push({ tenant_id: TENANT, tier_id: 'hobby' });
    expect(
      await resolveNumericLimit(makeClient(), TENANT, 'max_api_keys'),
    ).toBe(25);
  });

  it('returns -1 (UNLIMITED for team max_api_keys)', async () => {
    state.billing.push({ tenant_id: TENANT, tier_id: 'team' });
    expect(
      await resolveNumericLimit(makeClient(), TENANT, 'max_api_keys'),
    ).toBe(-1);
  });
});

// ===========================================================================
// resolveNumericLimitForAllTenants (batch — cross-tenant cron paths)
// ===========================================================================

describe('resolveNumericLimitForAllTenants', () => {
  const T = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

  it('maps every billing row through the real data_retention_days matrix', async () => {
    state.billing.push(
      { tenant_id: T(1), tier_id: 'hobby' },
      { tenant_id: T(2), tier_id: 'growth' },
      { tenant_id: T(3), tier_id: 'team' },
      { tenant_id: T(4), tier_id: 'enterprise' },
    );

    const result = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
    );

    // Positional pin against @repo/tier-config's shipped values — a matrix
    // edit (or a tier→value mixup in the batch path) fails here.
    expect([...result.byTenant.entries()].sort()).toEqual([
      [T(1), 7],
      [T(2), 90],
      [T(3), 90],
      [T(4), -1],
    ]);
    expect(result.fallback).toBe(7);
  });

  it('lets a typed numeric override win over the tier value, including for tenants with no billing row', async () => {
    state.billing.push({ tenant_id: T(1), tier_id: 'growth' });
    state.overrides.push(
      { tenant_id: T(1), entitlement_key: 'data_retention_days', value: { v: 365 } },
      // No billing row for T(2) — override alone must still surface it.
      { tenant_id: T(2), entitlement_key: 'data_retention_days', value: { v: 30 } },
      // Override for a DIFFERENT key must not leak into this resolution.
      { tenant_id: T(1), entitlement_key: 'max_api_keys', value: { v: 3 } },
    );

    const result = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
    );

    expect([...result.byTenant.entries()].sort()).toEqual([
      [T(1), 365],
      [T(2), 30],
    ]);
  });

  // proves AC-059-14
  it('ignores malformed override values and keeps the tier value, logging each with its value type', async () => {
    const warn = vi.fn();
    state.billing.push(
      { tenant_id: T(1), tier_id: 'team' },
      { tenant_id: T(2), tier_id: 'team' },
      { tenant_id: T(3), tier_id: 'team' },
    );
    state.overrides.push(
      { tenant_id: T(1), entitlement_key: 'data_retention_days', value: { v: true } },
      // A row whose whole jsonb value is null (not `{ v: null }`) — the
      // resolver must survive the missing `.v` without crashing.
      {
        tenant_id: T(2),
        entitlement_key: 'data_retention_days',
        value: null as unknown as { v: unknown },
      },
      { tenant_id: T(3), entitlement_key: 'data_retention_days', value: { v: null } },
    );

    const result = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
      { warn },
    );

    // `true` must NOT coerce to a 1-day retention; null-shaped rows must
    // not crash the scan. All three keep the tier value, and each warn
    // names the offending value's type exactly.
    expect(result.byTenant.get(T(1))).toBe(90);
    expect(result.byTenant.get(T(2))).toBe(90);
    expect(result.byTenant.get(T(3))).toBe(90);
    expect(warn.mock.calls).toEqual([
      [
        'skipping malformed numeric override in batch resolve',
        { tenantId: T(1), key: 'data_retention_days', valueType: 'boolean' },
      ],
      [
        'skipping malformed numeric override in batch resolve',
        { tenantId: T(2), key: 'data_retention_days', valueType: 'undefined' },
      ],
      [
        'skipping malformed numeric override in batch resolve',
        { tenantId: T(3), key: 'data_retention_days', valueType: 'null' },
      ],
    ]);
  });

  it('tolerates a missing logger — and a logger without warn — on the malformed path', async () => {
    state.billing.push({ tenant_id: T(1), tier_id: 'team' });
    state.overrides.push({
      tenant_id: T(1),
      entitlement_key: 'data_retention_days',
      value: { v: true },
    });

    // No logger at all, then a logger whose optional warn is absent: both
    // must resolve (the warn is best-effort observability; nothing reads it).
    const withoutLogger = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
    );
    const withEmptyLogger = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
      {},
    );

    expect(withoutLogger.byTenant.get(T(1))).toBe(90);
    expect(withEmptyLogger.byTenant.get(T(1))).toBe(90);
  });

  it('resolves an unknown tier_id to the hobby value', async () => {
    state.billing.push({ tenant_id: T(1), tier_id: 'legacy-plan-name' });

    const result = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
    );

    expect(result.byTenant.get(T(1))).toBe(7);
  });

  it('paginates past the 1000-row PostgREST cap on both scans', async () => {
    for (let i = 1; i <= 1201; i++) {
      state.billing.push({ tenant_id: T(i), tier_id: 'growth' });
      state.overrides.push({
        tenant_id: T(i),
        entitlement_key: 'data_retention_days',
        value: { v: 100000 + i },
      });
    }

    const result = await resolveNumericLimitForAllTenants(
      makeClient(),
      'data_retention_days',
    );

    // Every tenant present, and each carries its OVERRIDE value — proving
    // rows 1001+ of both the billing and the override scan were read
    // (a single-page read would leave tenant 1201 at the growth 90).
    expect(result.byTenant.size).toBe(1201);
    expect(result.byTenant.get(T(1))).toBe(100001);
    expect(result.byTenant.get(T(1201))).toBe(101201);

    // The wire contract that makes multi-page scans SAFE, not just complete:
    // a stable `order=id.asc` plus exact 1000-row windows. Without the
    // order, PostgREST page composition is unspecified and a concurrent
    // write makes the scan drop or duplicate tenants — invisible with
    // static fixtures, so the requests themselves are asserted.
    expect(
      capturedPageRequests.filter((r) => r.table === 'billing'),
    ).toEqual([
      { table: 'billing', order: 'tenant_id.asc', offset: '0', limit: '1000' },
      { table: 'billing', order: 'tenant_id.asc', offset: '1000', limit: '1000' },
    ]);
    expect(
      capturedPageRequests.filter((r) => r.table === 'tenant_entitlement_override'),
    ).toEqual([
      {
        table: 'tenant_entitlement_override',
        order: 'id.asc',
        offset: '0',
        limit: '1000',
      },
      {
        table: 'tenant_entitlement_override',
        order: 'id.asc',
        offset: '1000',
        limit: '1000',
      },
    ]);
  });

  it('throws on a billing read error instead of degrading to defaults', async () => {
    // The whole point of the strict batch contract: a billing outage must
    // abort the caller (retention sweep), never resolve every tenant to
    // the 7-day hobby default.
    state.billingError = { message: 'billing unavailable' };

    await expect(
      resolveNumericLimitForAllTenants(makeClient(), 'data_retention_days'),
    ).rejects.toThrow(/billing.*failed.*billing unavailable/);
  });

  it('throws on an override read error instead of ignoring overrides', async () => {
    // Ignoring overrides on an outage would delete data of tenants whose
    // retention was RAISED by override.
    state.billing.push({ tenant_id: T(1), tier_id: 'growth' });
    state.overrideError = { message: 'overrides unavailable' };

    await expect(
      resolveNumericLimitForAllTenants(makeClient(), 'data_retention_days'),
    ).rejects.toThrow(/tenant_entitlement_override.*failed.*overrides unavailable/);
  });
});
