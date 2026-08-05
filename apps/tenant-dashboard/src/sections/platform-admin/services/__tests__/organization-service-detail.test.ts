/**
 * OrganizationService.getDetail() — managed-deployments row shape.
 *
 * There is no `deployment` table, so nothing can populate `latest_code_status`
 * and a second `.from('deployment')` query keyed on the managed apps' ids
 * would 500 against a missing relation. Pinned here:
 *   - `deployment` is never queried (the negative pin);
 *   - every managed-app row still renders, with `latest_code_status: null`
 *     (the dashboard falls back to a "No deployments" label for null).
 *
 * The db is a thin chainable fake (service-class DI seam), matching the
 * pattern in organization-service-delete.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { OrganizationService } from '../organization-service';

type TableResult = { data?: unknown; error?: unknown; count?: number | null };

function makeDb(results: Record<string, TableResult[]>) {
  const hits: Record<string, number> = {};
  const fromCalls: string[] = [];

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    const idx = hits[table] ?? 0;
    hits[table] = idx + 1;
    const conf = results[table]?.[Math.min(idx, (results[table]?.length ?? 1) - 1)] ?? {};
    const resolved = {
      data: conf.data ?? null,
      error: conf.error ?? null,
      count: conf.count ?? null,
    };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'in', 'order', 'limit', 'gt', 'is']) {
      builder[m] = vi.fn(() => builder);
    }
    builder.single = vi.fn(() => Promise.resolve(resolved));
    (builder as { then: unknown }).then = (
      onFulfilled: (v: typeof resolved) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(resolved).then(onFulfilled, onRejected);
    return builder;
  });

  return { db: { from } as unknown as SupabaseClient, fromCalls };
}

const TENANT = {
  tenant_id: 'tenant-1',
  company_name: 'Acme Co',
  organization_name: 'acme',
  created_at: '2026-01-01T00:00:00Z',
  created_by: null,
};

function makeResults(): Record<string, TableResult[]> {
  return {
    tenant: [{ data: TENANT }],
    membership: [{ data: [] }],
    // First hit = the `app` count query (appsCount); second hit = the
    // app+environment join (appsRaw) — getDetail queries `app` in that order.
    app: [
      { count: 2 },
      {
        data: [
          {
            id: 'app-1',
            name: 'agent-one',
            runtime: 'nodejs',
            environments: [{ is_default: true, fly_app_name: 'fly-agent-one', fly_machine_id: 'machine-1' }],
          },
          {
            id: 'app-2',
            name: 'agent-two',
            runtime: 'python',
            environments: [{ is_default: true, fly_app_name: null, fly_machine_id: null }],
          },
        ],
      },
    ],
    api_key: [{ count: 0 }],
    template: [{ count: 0 }],
    billing: [{ data: { stripe_customer_id: null, stripe_subscription_id: null, tier_id: 'hobby' } }],
    temp_access_grant: [{ data: [] }],
  };
}

describe('OrganizationService.getDetail() — managed deployments post deployment-table drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never queries `deployment` and reports latest_code_status: null for every managed app', async () => {
    const { db, fromCalls } = makeDb(makeResults());
    const service = new OrganizationService({ db, auditLog: { create: vi.fn() } as never });

    const result = await service.getDetail('tenant-1');

    expect(fromCalls).not.toContain('deployment');

    // Only app-1 has a default-env fly_app_name — matches the legacy
    // "managed deployment" filter (app-2 is excluded, no fly app provisioned).
    expect(result.data?.managed_deployments).toEqual([
      {
        app_id: 'app-1',
        app_name: 'agent-one',
        runtime: 'nodejs',
        fly_app_name: 'fly-agent-one',
        fly_machine_id: 'machine-1',
        latest_code_status: null,
      },
    ]);
  });
});
