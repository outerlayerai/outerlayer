/**
 * ClickHouse store for the entitlement-driven retention sweep.
 *
 * Owns the two physical operations the sweep needs:
 *   - discovery: the oldest row per tenant per table (the "who actually has
 *     expired data" pre-check, so tables with nothing to delete get NO
 *     mutation at all — a no-op mutation still fans out across every part);
 *   - deletion: ONE `ALTER TABLE ... DELETE` per table covering every
 *     expired tenant, with the tenant→cutoff map bound via `transform()`.
 *
 * `ALTER TABLE ... DELETE` (heavy mutation) is deliberate — NOT lightweight
 * `DELETE FROM`:
 *   - lightweight deletes only mask rows until a merge rewrites the part;
 *     cold parts may never merge, so "deleted" bytes could sit on disk
 *     indefinitely — the opposite of the hard-deletion guarantee the
 *     retention entitlement sells;
 *   - lightweight deletes don't support tables with projections
 *     (otel_traces has five).
 * Mutations are async (`mutations_sync = 0`): the cron tick schedules the
 * delete and returns; ClickHouse rewrites affected parts in the background.
 * The pending-mutation count is the backpressure signal — the service skips
 * a table whose previous sweep is still running (deletes are cumulative, so
 * a skipped day self-heals on the next run).
 *
 * Table/column identifiers are compile-time constants from
 * {@link RETENTION_TABLES} — only tenant ids and cutoffs travel as query
 * params.
 */

import { createClient } from "@clickhouse/client-web";

/**
 * Every tenant-keyed per-row data table physical retention governs, with the
 * INSERT-time column the cutoff compares against (retention semantics are
 * insert-time, matching migration 21: backfilled/replayed spans get their
 * full window from INSERT, and a row is only ever deleted when it has been
 * in the system longer than the tenant's retention).
 *
 * Deliberately absent (see migration 28's header for the full rationale):
 *   - trace_topic_maps — versioned model artifacts with their own 90-day
 *     DDL TTL lifecycle, not per-trace rows.
 */
export const RETENTION_TABLES = [
  { table: "otel_traces", timeColumn: "CreatedAt" },
  { table: "otel_traces_trace_id_ts", timeColumn: "CreatedAt" },
  { table: "scores", timeColumn: "CreatedAt" },
  { table: "trace_facets", timeColumn: "CreatedAt" },
  { table: "agent_session_summary", timeColumn: "InsertedAt" },
  { table: "agent_blobs", timeColumn: "InsertedAt" },
] as const;

export type RetentionTable = (typeof RETENTION_TABLES)[number];

/** A tenant whose rows older than `cutoffUnixSec` must be deleted. */
export interface TenantCutoff {
  tenantId: string;
  /** Unix seconds; rows with timeColumn strictly below this expire. */
  cutoffUnixSec: number;
}

export interface RetentionStore {
  /** Oldest row (unix seconds) per tenant in one table. */
  oldestRowPerTenant(table: RetentionTable): Promise<Map<string, number>>;
  /** Schedule the async delete mutation for the given tenants' expired rows. */
  deleteExpiredRows(table: RetentionTable, cutoffs: TenantCutoff[]): Promise<void>;
  /** Unfinished DELETE mutations per table — the backpressure signal. */
  pendingDeleteMutations(): Promise<Map<string, number>>;
}

/** Delay before the single retry of a read-only discovery query. */
const DISCOVERY_RETRY_DELAY_MS = 2_000;

/**
 * One delayed retry, for read-only discovery queries only: the shared
 * ClickHouse server intermittently rejects a query at its total-memory
 * ceiling and accepts the same query seconds later, and a single blip
 * shouldn't skip a table's sweep for the day. Mutations are never retried —
 * if an ALTER DELETE succeeded but its response was lost, a retry would
 * stack a second identical mutation and double the part-rewrite work.
 */
async function withOneRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS));
    return run();
  }
}

export const createRetentionStore = (config: {
  url: string;
  /** Write identity (`analytics_writer`); omit to fall back to `default`. */
  username?: string;
  password: string;
}): RetentionStore => {
  const client = createClient({
    url: config.url,
    ...(config.username ? { username: config.username } : {}),
    password: config.password,
  });

  return {
    async oldestRowPerTenant(table) {
      const result = await withOneRetry(() =>
        client.query({
          query: `
          SELECT TenantId, toUnixTimestamp(min(${table.timeColumn})) AS oldest
          FROM ${table.table}
          GROUP BY TenantId
        `,
          format: "JSONEachRow",
          clickhouse_settings: {
            // Every retention table's sorting key leads with TenantId, so
            // the GROUP BY streams in sort order with bounded memory instead
            // of hash-aggregating a full-table scan. This is a background
            // cron against the busiest tables on a shared server: capped
            // threads and a hard per-query memory ceiling keep it from ever
            // being the allocation that tips total server memory over the
            // limit — if the cap trips, the per-table isolation in the sweep
            // skips just this table and the next run covers it.
            optimize_aggregation_in_order: 1,
            max_threads: 2,
            max_memory_usage: "1000000000",
            max_execution_time: 300,
          },
        }),
      );
      const rows = await result.json<{ TenantId: string; oldest: string | number }>();
      return new Map(rows.map((r) => [r.TenantId, Number(r.oldest)]));
    },

    async deleteExpiredRows(table, cutoffs) {
      if (cutoffs.length === 0) return;
      const tenants = cutoffs.map((c) => c.tenantId);
      const cutoffSecs = cutoffs.map((c) => c.cutoffUnixSec);
      // `transform` maps each tenant to ITS cutoff; unlisted tenants hit the
      // toUInt32(0) default, which no timestamp is below — but the IN guard
      // already excludes their rows (and lets the mutation skip whole parts
      // via the TenantId-leading primary key).
      await client.command({
        query: `
          ALTER TABLE ${table.table} DELETE
          WHERE TenantId IN ({tenants:Array(String)})
            AND toUnixTimestamp(${table.timeColumn}) < transform(
              TenantId,
              {tenants:Array(String)},
              {cutoffs:Array(UInt32)},
              toUInt32(0)
            )
        `,
        query_params: { tenants, cutoffs: cutoffSecs },
      });
    },

    async pendingDeleteMutations() {
      const result = await client.query({
        query: `
          SELECT table, count() AS pending
          FROM system.mutations
          WHERE database = currentDatabase()
            AND table IN ({tables:Array(String)})
            AND is_done = 0
            AND command LIKE '%DELETE%'
          GROUP BY table
        `,
        query_params: { tables: RETENTION_TABLES.map((t) => t.table) },
        format: "JSONEachRow",
      });
      const rows = await result.json<{ table: string; pending: string | number }>();
      return new Map(rows.map((r) => [r.table, Number(r.pending)]));
    },
  };
};
