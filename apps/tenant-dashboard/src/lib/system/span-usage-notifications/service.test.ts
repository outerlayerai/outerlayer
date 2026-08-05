import type { Mock } from 'vitest';
import { SpanUsageNotificationService } from './service';
import type { SpanUsageNotificationDeps } from './service';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, Mock> = {};
  const methods = ['select', 'eq', 'in', 'gte', 'like', 'insert', 'single'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  // Make the chain thenable so `await supabase.from(...).select(...)` resolves
  chain['then'] = vi.fn((resolve: (v: typeof result) => void) => {
    resolve(result);
    return Promise.resolve(result);
  });
  return chain;
}

function createMockClickHouse(rows: { TenantId: string; count: string }[] = []) {
  return {
    query: vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as SpanUsageNotificationDeps['clickhouse'];
}

function createFailingClickHouse(errorMessage: string) {
  return {
    query: vi.fn().mockRejectedValue(new Error(errorMessage)),
  } as unknown as SpanUsageNotificationDeps['clickhouse'];
}

// ---------------------------------------------------------------------------
// Stateful mock: tracks per-table results and insert calls
// ---------------------------------------------------------------------------

interface TableResults {
  billing: { data: unknown; error: unknown };
  tenant_entitlement_override: { data: unknown; error: unknown };
  notification_select: { data: unknown; error: unknown };
  notification_insert: { data: unknown; error: unknown };
}

function createStatefulSupabase(results: Partial<TableResults>) {
  const insertCalls: unknown[] = [];
  const chainCalls: { table: string; method: string; args: unknown[] }[] = [];

  const from = vi.fn((table: string) => {
    if (table === 'billing') {
      const chain = createChain(results.billing ?? { data: [], error: null });
      trackChainCalls(chain, table, chainCalls);
      return chain;
    }
    if (table === 'tenant_entitlement_override') {
      const chain = createChain(results.tenant_entitlement_override ?? { data: [], error: null });
      trackChainCalls(chain, table, chainCalls);
      return chain;
    }
    if (table === 'notification') {
      // Distinguish select vs insert by intercepting the chain
      const selectResult = results.notification_select ?? { data: [], error: null };
      const insertResult = results.notification_insert ?? { data: null, error: null };
      const chain = createChain(selectResult);
      trackChainCalls(chain, table, chainCalls);

      // Override insert to track calls and return insert-specific result
      chain['insert'] = vi.fn().mockImplementation((args: unknown) => {
        insertCalls.push(args);
        const insertChain = createChain(insertResult);
        return insertChain;
      });

      return chain;
    }
    return createChain({ data: null, error: null });
  });

  return {
    supabase: { from } as unknown as SpanUsageNotificationDeps['supabase'],
    insertCalls,
    chainCalls,
  };
}

function trackChainCalls(
  chain: Record<string, Mock>,
  table: string,
  tracker: { table: string; method: string; args: unknown[] }[],
) {
  for (const method of ['eq', 'like', 'in', 'gte']) {
    const original = chain[method]!;
    chain[method] = vi.fn((...args: unknown[]) => {
      tracker.push({ table, method, args });
      return original(...args);
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpanUsageNotificationService', () => {
  // ── Happy path ──────────────────────────────────────────────────────

  it('inserts 80% notification for hobby tenant at 85%', async () => {
    // 85% of 20,000 = 17,000
    const { supabase, insertCalls, chainCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '17000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([{ tenantId: 'tenant-1', threshold: 80 }]);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toEqual({
      tenant_id: 'tenant-1',
      message: 'You have used 80% of your free units.',
      type: 'warning',
    });
    // verify query arguments via chain calls
    expect(chainCalls).toContainEqual({ table: 'billing', method: 'eq', args: ['tier_id', 'hobby'] });
    // verify ClickHouse query_params
    expect((clickhouse!.query as Mock).mock.calls[0]![0].query_params).toEqual({ tenantIds: ['tenant-1'] });
  });

  it('inserts 100% notification (not 80%) for hobby tenant at exactly 100%', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '20000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([{ tenantId: 'tenant-1', threshold: 100 }]);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ message: 'You have used 100% of your free units.' });
  });

  it('inserts only 100% notification for hobby tenant at 120% (over limit)', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '24000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([{ tenantId: 'tenant-1', threshold: 100 }]);
    expect(insertCalls).toHaveLength(1);
  });

  it('handles multiple hobby tenants at different thresholds', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: {
        data: [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }, { tenant_id: 'tenant-c' }],
        error: null,
      },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([
      { TenantId: 'tenant-a', count: '16500' }, // 82.5%
      { TenantId: 'tenant-b', count: '21000' }, // 105%
      { TenantId: 'tenant-c', count: '5000' },  // 25%
    ]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.processed).toBe(3);
    expect(result.notified).toEqual([
      { tenantId: 'tenant-a', threshold: 80 },
      { tenantId: 'tenant-b', threshold: 100 },
    ]);
    expect(result.skipped).toBe(1); // tenant-c below threshold
    expect(insertCalls).toHaveLength(2);
  });

  it('no notification for hobby tenant at 50%', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '10000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('no notification at exactly 79.995%', async () => {
    // 79.995% of 20,000 = 15,999
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '15999' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(insertCalls).toHaveLength(0);
  });

  it('inserts 80% notification at exactly 80%', async () => {
    // 80% of 20,000 = 16,000
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '16000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([{ tenantId: 'tenant-1', threshold: 80 }]);
    expect(insertCalls).toHaveLength(1);
  });

  // ── Deduplication ───────────────────────────────────────────────────

  it('skips duplicate 80% notification', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: {
        data: [{ tenant_id: 'tenant-1', message: 'You have used 80% of your free units.' }],
        error: null,
      },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '17000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('skips duplicate 100% notification', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: {
        data: [{ tenant_id: 'tenant-1', message: 'You have used 100% of your free units.' }],
        error: null,
      },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '25000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('inserts 100% when 80% already exists and tenant is now at 100%', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: {
        data: [{ tenant_id: 'tenant-1', message: 'You have used 80% of your free units.' }],
        error: null,
      },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '20000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([{ tenantId: 'tenant-1', threshold: 100 }]);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({ message: 'You have used 100% of your free units.' });
  });

  // ── Tier filtering ─────────────────────────────────────────────────

  it('only processes hobby tenants (growth/enterprise excluded by query)', async () => {
    // The billing query filters tier_id = 'hobby', so only hobby tenants appear
    const { supabase, insertCalls, chainCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'hobby-tenant' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'hobby-tenant', count: '17000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.processed).toBe(1);
    expect(result.notified).toHaveLength(1);
    expect(insertCalls).toHaveLength(1);
    // verify billing query filters by hobby tier
    expect(chainCalls).toContainEqual({ table: 'billing', method: 'eq', args: ['tier_id', 'hobby'] });
    // verify ClickHouse query_params
    expect((clickhouse!.query as Mock).mock.calls[0]![0].query_params).toEqual({ tenantIds: ['hobby-tenant'] });
  });

  it('returns empty result when no hobby tenants exist', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse();

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.processed).toBe(0);
    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(insertCalls).toHaveLength(0);
  });

  // ── Entitlement overrides ──────────────────────────────────────────

  it('uses custom 50k override as limit', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      tenant_entitlement_override: {
        data: [{ tenant_id: 'tenant-1', value: { v: 50000 } }],
        error: null,
      },
      notification_select: { data: [], error: null },
    });
    // 17,000 / 50,000 = 34% — below threshold
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '17000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('skips tenant with unlimited override (-1)', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      tenant_entitlement_override: {
        data: [{ tenant_id: 'tenant-1', value: { v: -1 } }],
        error: null,
      },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '999999' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  // ── Error handling ─────────────────────────────────────────────────

  it('returns error when ClickHouse client is null', async () => {
    const { supabase } = createStatefulSupabase({});

    const service = new SpanUsageNotificationService({ supabase, clickhouse: null });
    const result = await service.checkAndNotify();

    expect(result.errors).toEqual([{ tenantId: '*', error: 'ClickHouse client not available' }]);
    expect(result.notified).toEqual([]);
  });

  it('returns error when ClickHouse query throws', async () => {
    const { supabase } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
    });
    const clickhouse = createFailingClickHouse('Connection refused');

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.errors).toEqual([
      { tenantId: '*', error: 'ClickHouse query failed: Connection refused' },
    ]);
  });

  it('returns error when billing query fails', async () => {
    const { supabase } = createStatefulSupabase({
      billing: { data: null, error: { message: 'connection error' } },
    });
    const clickhouse = createMockClickHouse();

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.errors).toEqual([
      { tenantId: '*', error: 'Billing query failed: connection error' },
    ]);
  });

  it('continues processing when individual notification insert fails', async () => {
    let insertCallCount = 0;
    const insertCalls: unknown[] = [];

    const from = vi.fn((table: string) => {
      if (table === 'billing') {
        return createChain({
          data: [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }],
          error: null,
        });
      }
      if (table === 'tenant_entitlement_override') {
        return createChain({ data: [], error: null });
      }
      if (table === 'notification') {
        const chain = createChain({ data: [], error: null });
        chain['insert'] = vi.fn().mockImplementation((args: unknown) => {
          insertCalls.push(args);
          insertCallCount++;
          // First insert fails, second succeeds
          const error = insertCallCount === 1 ? { message: 'duplicate key' } : null;
          return createChain({ data: null, error });
        });
        return chain;
      }
      return createChain({ data: null, error: null });
    });
    const supabase = { from } as unknown as SpanUsageNotificationDeps['supabase'];

    const clickhouse = createMockClickHouse([
      { TenantId: 'tenant-a', count: '17000' }, // 85%
      { TenantId: 'tenant-b', count: '21000' }, // 105%
    ]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ tenantId: 'tenant-a' });
    expect(result.notified).toEqual([{ tenantId: 'tenant-b', threshold: 100 }]);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('treats tenant with 0 spans as below threshold', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '0' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  it('treats tenant absent from ClickHouse results as 0 spans', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: { data: [], error: null },
    });
    // Empty ClickHouse results — tenant has no traces at all
    const clickhouse = createMockClickHouse([]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  // both notifications already exist → skipped
  it('skips when both 80% and 100% notifications already exist', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      notification_select: {
        data: [
          { tenant_id: 'tenant-1', message: 'You have used 80% of your free units.' },
          { tenant_id: 'tenant-1', message: 'You have used 100% of your free units.' },
        ],
        error: null,
      },
    });
    // 120% usage — both thresholds already notified
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '24000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  // zero limit override → skipped (percentUsed is 0 when limit is 0)
  it('skips tenant with zero limit override', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      tenant_entitlement_override: {
        data: [{ tenant_id: 'tenant-1', value: { v: 0 } }],
        error: null,
      },
      notification_select: { data: [], error: null },
    });
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '5000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(insertCalls).toHaveLength(0);
  });

  // override query returns error → falls back to default limit
  it('uses default limit when override query returns an error', async () => {
    const { supabase, insertCalls } = createStatefulSupabase({
      billing: { data: [{ tenant_id: 'tenant-1' }], error: null },
      tenant_entitlement_override: {
        data: null,
        error: { message: 'relation does not exist' },
      },
      notification_select: { data: [], error: null },
    });
    // 85% of 20,000 default = 17,000 → triggers 80% notification
    const clickhouse = createMockClickHouse([{ TenantId: 'tenant-1', count: '17000' }]);

    const service = new SpanUsageNotificationService({ supabase, clickhouse });
    const result = await service.checkAndNotify();

    expect(result.notified).toEqual([{ tenantId: 'tenant-1', threshold: 80 }]);
    expect(insertCalls).toHaveLength(1);
  });
});
