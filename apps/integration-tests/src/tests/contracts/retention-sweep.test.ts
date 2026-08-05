/**
 * Retention sweep ↔ ClickHouse contract (real ClickHouse).
 *
 * The unit tests around the retention store pin the SQL text; these tests
 * make the contract breakable where it actually lives:
 *
 *   1. Migration 28 really removed the fixed 90-day DDL TTL from every
 *      swept table (and kept trace_topic_maps's own TTL) — the sweep is
 *      only safe as the SOLE deleter if nothing else expires rows.
 *   2. The `ALTER TABLE … DELETE` the store emits is valid ClickHouse for
 *      every table in the registry (column names verified against the real
 *      schemas — a renamed InsertedAt would only fail here).
 *   3. The transform() predicate deletes exactly each listed tenant's rows
 *      older than THAT tenant's cutoff — and nothing of anyone else's.
 */

import {
  createRetentionStore,
  RETENTION_TABLES,
} from '@repo/gateway-core/stores/clickhouse/retention-store';
import {
  CLICKHOUSE_TEST_HOST,
  executeClickHouse,
  queryClickHouse,
} from '../../../clickhouse/setup-clickhouse';

const store = createRetentionStore({ url: CLICKHOUSE_TEST_HOST, password: '' });

const NOW_SEC = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** 'YYYY-MM-DD HH:MM:SS' (UTC) for a moment n days ago — JSONEachRow-safe
 * for DateTime, DateTime64(3) and DateTime64(9) alike. Day-scale margins in
 * the fixtures absorb any server-timezone skew. */
function daysAgo(n: number): string {
  return new Date((NOW_SEC - n * DAY) * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
  await executeClickHouse(
    `INSERT INTO ${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join('\n'),
  );
}

/** Mutations are async; poll until every mutation on the table settles. */
async function waitForMutations(table: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const rows = await queryClickHouse(
      `SELECT count() AS c FROM system.mutations WHERE database = currentDatabase() AND table = '${table}' AND is_done = 0`,
    );
    if (Number(rows[0]?.c ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`mutations on ${table} did not finish`);
}

describe('ClickHouse DDL retention posture (migration 28)', () => {
  it('no swept table carries a DDL TTL; trace_topic_maps keeps its own', async () => {
    const names = [...RETENTION_TABLES.map((t) => t.table), 'trace_topic_maps'];
    const rows = await queryClickHouse(
      `SELECT name, create_table_query FROM system.tables WHERE database = currentDatabase() AND name IN (${names
        .map((n) => `'${n}'`)
        .join(',')}) ORDER BY name`,
    );

    // All seven tables must exist — a silently missing table would
    // otherwise pass the "no TTL" assertion below by absence.
    expect(rows.map((r: { name: string }) => r.name)).toEqual([...names].sort());

    for (const row of rows as { name: string; create_table_query: string }[]) {
      if (row.name === 'trace_topic_maps') {
        expect(row.create_table_query).toContain(' TTL ');
      } else {
        // A reintroduced fixed TTL would silently cap >90d retention again.
        expect(row.create_table_query).not.toContain(' TTL ');
      }
    }
  });
});

describe('deleteExpiredRows against real schemas', () => {
  it('executes on every registry table (column names match the live DDL)', async () => {
    // No rows match this throwaway tenant — the point is that ClickHouse
    // parses and accepts the mutation for each table's real columns.
    for (const table of RETENTION_TABLES) {
      await store.deleteExpiredRows(table, [
        { tenantId: crypto.randomUUID(), cutoffUnixSec: NOW_SEC - 90 * DAY },
      ]);
      await waitForMutations(table.table);
    }
  });

  it('deletes each listed tenant’s rows past its OWN cutoff and preserves everything else', async () => {
    const tenantShort = crypto.randomUUID(); // swept at 7 days
    const tenantLong = crypto.randomUUID(); // swept at 90 days
    const tenantUnlimited = crypto.randomUUID(); // not in the mutation at all
    const appId = crypto.randomUUID();

    const span = (tenant: string, traceId: string, ageDays: number) => ({
      Timestamp: daysAgo(ageDays),
      CreatedAt: daysAgo(ageDays),
      TraceId: traceId,
      SpanId: `span-${traceId}`,
      TenantId: tenant,
      AppId: appId,
    });

    await insertRows('otel_traces', [
      span(tenantShort, 'short-old', 100),
      span(tenantShort, 'short-mid', 30),
      span(tenantShort, 'short-fresh', 3),
      span(tenantLong, 'long-old', 100),
      span(tenantLong, 'long-mid', 50),
      span(tenantUnlimited, 'unlimited-old', 100),
    ]);

    // Pre-check the discovery read on the same fixtures.
    const oldest = await store.oldestRowPerTenant(
      RETENTION_TABLES.find((t) => t.table === 'otel_traces')!,
    );
    expect(oldest.get(tenantShort)).toBeGreaterThanOrEqual(NOW_SEC - 100 * DAY - DAY);
    expect(oldest.get(tenantShort)).toBeLessThanOrEqual(NOW_SEC - 100 * DAY + DAY);

    await store.deleteExpiredRows(RETENTION_TABLES.find((t) => t.table === 'otel_traces')!, [
      { tenantId: tenantShort, cutoffUnixSec: NOW_SEC - 7 * DAY },
      { tenantId: tenantLong, cutoffUnixSec: NOW_SEC - 90 * DAY },
    ]);
    await waitForMutations('otel_traces');

    const survivors = await queryClickHouse(
      `SELECT TraceId FROM otel_traces WHERE TenantId IN ('${tenantShort}','${tenantLong}','${tenantUnlimited}') ORDER BY TraceId`,
    );
    // short-old (100d > 7d) and long-old (100d > 90d) are gone; short-mid
    // (30d) died under the SHORT cutoff — proving per-tenant cutoffs, not a
    // shared one (a single 90d cutoff would have kept it); everything
    // fresh-enough and the unlisted tenant survive untouched.
    expect(survivors.map((r: { TraceId: string }) => r.TraceId)).toEqual([
      'long-mid',
      'short-fresh',
      'unlimited-old',
    ]);
  });

  it('applies the same predicate to a DateTime64(3) table (scores)', async () => {
    const tenant = crypto.randomUUID();
    const scoreRow = (id: string, ageDays: number) => ({
      Id: id,
      TenantId: tenant,
      AppId: crypto.randomUUID(),
      Score: 1,
      Label: 'l',
      Reason: 'r',
      ResourceId: 'res',
      Name: 'quality',
      CreatedAt: daysAgo(ageDays),
    });

    await insertRows('scores', [scoreRow('expired-score', 40), scoreRow('kept-score', 5)]);

    await store.deleteExpiredRows(RETENTION_TABLES.find((t) => t.table === 'scores')!, [
      { tenantId: tenant, cutoffUnixSec: NOW_SEC - 30 * DAY },
    ]);
    await waitForMutations('scores');

    const survivors = await queryClickHouse(
      `SELECT Id FROM scores WHERE TenantId = '${tenant}' ORDER BY Id`,
    );
    expect(survivors.map((r: { Id: string }) => r.Id)).toEqual(['kept-score']);
  });
});

describe('pendingDeleteMutations', () => {
  it('reports zero once all sweep mutations settled', async () => {
    for (const table of RETENTION_TABLES) {
      await waitForMutations(table.table);
    }
    const pending = await store.pendingDeleteMutations();
    expect([...pending.values()].every((count) => count === 0)).toBe(true);
  });
});
