/**
 * Guarded ClickHouse client for the billing metering jobs.
 *
 * Metering runs on the every-minute cron against the same instance as
 * ingest, dashboards, and topics enrichment. The storage-delta query reads
 * the wide payload columns under FINAL, and unguarded it peaks in the GiB
 * range — on a small instance that pins the SERVER-wide memory ceiling, and
 * every co-tenant workload's queries die as collateral. These settings make
 * a runaway metering query fail alone and fast (per-query cap far below any
 * server ceiling), let the aggregations spill to disk instead of failing,
 * and bound FINAL's merge working set to one partition at a time — rows
 * sharing a sorting key never span toDate(Timestamp) partitions, so
 * per-partition processing is semantics-preserving.
 */
import { createClient } from "@clickhouse/client-web";
import { clickHouseWriteAuth } from "@repo/gateway-core/stores/clickhouse/write-identity";

/**
 * The cap clears the storage-delta query's observed pre-index peak
 * (~2.6 GiB — the FINAL merge state over a day-sized partition, which spill
 * settings cannot relieve) while staying well below any instance's server
 * ceiling. Once the CreatedAt minmax skip index prunes the one-minute
 * windows down to a handful of granules, this can ratchet down.
 */
export const METERING_QUERY_SETTINGS = {
  max_memory_usage: "3000000000",
  max_bytes_before_external_group_by: "700000000",
  max_bytes_before_external_sort: "700000000",
  do_not_merge_across_partitions_select_final: 1,
} as const;

export function createMeteringClickHouseClient(env: {
  CLICKHOUSE_HOST?: string;
  CLICKHOUSE_PASSWORD?: string;
  CLICKHOUSE_WRITE_USER?: string;
  CLICKHOUSE_WRITE_PASSWORD?: string;
}): ReturnType<typeof createClient> {
  return createClient({
    url: env.CLICKHOUSE_HOST,
    ...clickHouseWriteAuth(env),
    clickhouse_settings: METERING_QUERY_SETTINGS,
  });
}
