/**
 * OrganizationService.delete() — the API-key audit count after the key-store
 * cutover.
 *
 * With Unkey gone there is no external key provider to sweep on org delete:
 * the api_key rows (and their private.api_key_secret digests) go with the
 * tenant-delete cascade, and the service's only key-related job is COUNTING
 * them for the audit report. These tests pin that count end-to-end:
 *
 *   - the count query's exact arguments (`{ count: 'exact', head: true }` —
 *     without them PostgREST returns no count and every audit reads 0), and
 *   - the `?? 0` null-count fallback vs a real count flowing into both the
 *     returned result and the audit-log details.
 *
 * The db is a thin chainable fake (this is a service-class DI seam, not a
 * Supabase transport mock — the transport is exercised by the integration
 * suites).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { OrganizationService } from '../organization-service';
import type { IAuditLogService, IStripeClient } from '../types';

type TableResult = { data?: unknown; error?: unknown; count?: number | null };

/**
 * Chainable thenable query builder. Each `from(table)` call consumes the next
 * configured result for that table (api_key is queried twice: once for
 * before_state, once for the audit count). `select` arguments are recorded
 * per table for exact-args assertions.
 */
function makeDb(
  results: Record<string, TableResult[]>,
  opts: { rpcError?: { message: string }; trace?: string[] } = {},
) {
  const selectCalls: Record<string, unknown[][]> = {};
  const hits: Record<string, number> = {};

  const from = vi.fn((table: string) => {
    const idx = hits[table] ?? 0;
    hits[table] = idx + 1;
    const conf = results[table]?.[Math.min(idx, (results[table]?.length ?? 1) - 1)] ?? {};
    const resolved = {
      data: conf.data ?? null,
      error: conf.error ?? null,
      count: conf.count ?? null,
    };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'in', 'order', 'limit']) {
      builder[m] = vi.fn((...args: unknown[]) => {
        if (m === 'select') (selectCalls[table] ??= []).push(args);
        return builder;
      });
    }
    builder.single = vi.fn(() => Promise.resolve(resolved));
    // Supabase query builders are thenables — awaiting one resolves the query.
    (builder as { then: unknown }).then = (
      onFulfilled: (v: typeof resolved) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(resolved).then(onFulfilled, onRejected);
    return builder;
  });

  const rpc = vi.fn(() => {
    opts.trace?.push('delete');
    return Promise.resolve({ data: null, error: opts.rpcError ?? null });
  });
  return { db: { from, rpc } as unknown as SupabaseClient, selectCalls, rpc };
}

/** Stripe stub that records when cancel ran relative to the delete RPC. */
function makeStripe(opts: { trace?: string[]; throws?: Error } = {}) {
  const cancel = vi.fn(async () => {
    opts.trace?.push('stripe.cancel');
    if (opts.throws) throw opts.throws;
    return {} as never;
  });
  return { stripe: { subscriptions: { cancel } } as IStripeClient, cancel };
}

const SUBSCRIBED_BILLING = {
  stripe_customer_id: 'cus_live',
  stripe_subscription_id: 'sub_live',
};

const TENANT = {
  tenant_id: 'tenant-1',
  company_name: 'Acme Co',
  organization_name: 'acme',
  created_at: '2026-01-01T00:00:00Z',
};

function makeResults(auditKeyCount: number | null): Record<string, TableResult[]> {
  return {
    tenant: [{ data: TENANT }],
    membership: [{ data: [{ user_id: 'u1' }, { user_id: 'u2' }] }],
    app: [{ count: 5 }],
    // First hit = before_state count, second hit = the audit count.
    api_key: [{ count: auditKeyCount }, { count: auditKeyCount }],
    billing: [{ data: { stripe_customer_id: null, stripe_subscription_id: null } }],
    git_connection: [{ data: [] }],
  };
}

function makeAuditLog(): IAuditLogService {
  return { create: vi.fn().mockResolvedValue(undefined) } as unknown as IAuditLogService;
}

describe('OrganizationService.delete() — api-key audit count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts keys with an exact head-count query and reports the real count in result + audit details', async () => {
    const { db, selectCalls, rpc } = makeDb(makeResults(3));
    const auditLog = makeAuditLog();
    const service = new OrganizationService({ db, auditLog });

    const result = await service.delete(
      { tenantId: 'tenant-1', confirmationName: 'acme', reason: 'test' },
      'admin-1',
    );

    // The audit count query must request a head-only exact count — without
    // `{ count: 'exact', head: true }` PostgREST returns rows (or nothing)
    // and the count is always null.
    expect(selectCalls['api_key']?.[1]).toEqual([
      'api_key_id',
      { count: 'exact', head: true },
    ]);

    expect(rpc).toHaveBeenCalledWith('platform_admin_delete_tenant', {
      p_tenant_id: 'tenant-1',
    });

    expect(result.data).toEqual({
      deleted: true,
      stripeSubscriptionCancelled: false,
      apiKeyCount: 3,
      userCount: 2,
    });
    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'org_delete',
        targetId: 'tenant-1',
        details: expect.objectContaining({ api_keys_revoked: 3 }),
      }),
    );
  });

  it('falls back to 0 when the count comes back null', async () => {
    const { db } = makeDb(makeResults(null));
    const auditLog = makeAuditLog();
    const service = new OrganizationService({ db, auditLog });

    const result = await service.delete(
      { tenantId: 'tenant-1', confirmationName: 'acme' },
      'admin-1',
    );

    expect(result.data?.apiKeyCount).toBe(0);
    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ api_keys_revoked: 0 }),
      }),
    );
  });
});

/**
 * Cancelling Stripe is the only step here that reaches outside the database and
 * cannot be undone. It has to run after the delete commits.
 *
 * Cancelling first meant a failed delete left the customer with no subscription
 * and all of their data — and the audit write sits after the delete, so nothing
 * recorded that it happened.
 */
describe('OrganizationService.delete() — Stripe cancel ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function subscribedResults(): Record<string, TableResult[]> {
    const results = makeResults(2);
    results.billing = [{ data: SUBSCRIBED_BILLING }];
    return results;
  }

  it('does not touch Stripe when the delete fails', async () => {
    const { db } = makeDb(subscribedResults(), {
      rpcError: { message: 'still referenced from table "app"' },
    });
    const { stripe, cancel } = makeStripe();
    const auditLog = makeAuditLog();
    const service = new OrganizationService({ db, stripe, auditLog });

    const result = await service.delete(
      { tenantId: 'tenant-1', confirmationName: 'acme' },
      'admin-1',
    );

    expect(cancel).not.toHaveBeenCalled();
    expect(result.error).toContain('still referenced from table');
    expect(result.data).toBeUndefined();
  });

  it('cancels the subscription only after the delete has committed', async () => {
    const trace: string[] = [];
    const { db } = makeDb(subscribedResults(), { trace });
    const { stripe, cancel } = makeStripe({ trace });
    const auditLog = makeAuditLog();
    const service = new OrganizationService({ db, stripe, auditLog });

    const result = await service.delete(
      { tenantId: 'tenant-1', confirmationName: 'acme' },
      'admin-1',
    );

    // Positional: reversing these two is the bug.
    expect(trace).toEqual(['delete', 'stripe.cancel']);
    expect(cancel).toHaveBeenCalledWith('sub_live');
    expect(result.data?.stripeSubscriptionCancelled).toBe(true);
  });

  it('reports a failed cancel and keeps the subscription id in the audit row', async () => {
    const { db } = makeDb(subscribedResults());
    const { stripe } = makeStripe({ throws: new Error('stripe unreachable') });
    const auditLog = makeAuditLog();
    const service = new OrganizationService({ db, stripe, auditLog });

    const result = await service.delete(
      { tenantId: 'tenant-1', confirmationName: 'acme' },
      'admin-1',
    );

    // The data is gone either way, so the delete still succeeded. What must
    // survive is enough to cancel the leftover subscription by hand: the tenant
    // row no longer exists, so beforeState is the only place the id remains.
    expect(result.data?.deleted).toBe(true);
    expect(result.data?.stripeSubscriptionCancelled).toBe(false);
    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          stripe_subscription_cancelled: false,
          stripe_cancel_error: 'stripe unreachable',
        }),
        beforeState: expect.objectContaining({
          stripe_subscription_id: 'sub_live',
        }),
      }),
    );
  });
});
