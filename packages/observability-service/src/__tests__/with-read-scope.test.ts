/**
 * withReadScope — the row-policy scoping wrapper.
 *
 * The contract these tests pin: EVERY query issued through a scoped client
 * carries the scope settings, and nothing a call site passes can strip or
 * spoof them. This wrapper is what turns the `analytics_readonly` connection
 * into enforced tenant isolation — a merge-order regression here would let a
 * per-call `clickhouse_settings` object silently re-point reads at another
 * tenant.
 */

import { describe, it, expect, vi } from 'vitest';

import { withReadScope, type IClickHouseQuery } from '../client';

function capturingClient() {
  const calls: Array<Record<string, unknown>> = [];
  const client: IClickHouseQuery = {
    query: vi.fn(async (params) => {
      calls.push(params as Record<string, unknown>);
      return { json: async <T = unknown>() => [] as T[] };
    }),
  };
  return { client, calls };
}

describe('withReadScope', () => {
  it('adds SQL_tenant_id (and SQL_app_id when app-scoped) to a settings-less query', async () => {
    const { client, calls } = capturingClient();
    const scoped = withReadScope(client, { tenantId: 't-1', appId: 'a-1' });

    await scoped.query({ query: 'SELECT 1', query_params: { x: 1 }, format: 'JSONEachRow' });

    expect(calls).toEqual([
      {
        query: 'SELECT 1',
        query_params: { x: 1 },
        format: 'JSONEachRow',
        clickhouse_settings: { SQL_tenant_id: 't-1', SQL_app_id: 'a-1' },
      },
    ]);
  });

  it('omits SQL_app_id for a tenant-only scope', async () => {
    const { client, calls } = capturingClient();
    await withReadScope(client, { tenantId: 't-only' }).query({ query: 'SELECT 1' });

    expect(calls[0]!.clickhouse_settings).toEqual({ SQL_tenant_id: 't-only' });
  });

  it('merges the scope LAST: per-call settings survive but cannot override the scope', async () => {
    const { client, calls } = capturingClient();
    const scoped = withReadScope(client, { tenantId: 't-1', appId: 'a-1' });

    await scoped.query({
      query: 'SELECT 1',
      clickhouse_settings: {
        max_execution_time: 30,
        SQL_tenant_id: 't-EVIL',
        SQL_app_id: 'a-EVIL',
      },
    });

    expect(calls[0]!.clickhouse_settings).toEqual({
      max_execution_time: 30,
      SQL_tenant_id: 't-1',
      SQL_app_id: 'a-1',
    });
  });

  it('returns the underlying result untouched (pass-through, not a re-implementation)', async () => {
    const rows = [{ n: 1 }, { n: 2 }];
    const client: IClickHouseQuery = {
      query: async () => ({ json: async <T = unknown>() => rows as T[] }),
    };

    const result = await withReadScope(client, { tenantId: 't' }).query({ query: 'SELECT 1' });
    expect(await result.json()).toEqual(rows);
  });
});
