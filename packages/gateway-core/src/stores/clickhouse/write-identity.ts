/**
 * Auth for a ClickHouse WRITE / mutation client — the trusted server identity
 * behind ingest inserts, the retention `ALTER DELETE` sweep, topics-enrichment
 * `ALTER UPDATE`, and the non-tenant-scoped server reads (billing/metering, the
 * /health probe, retention backpressure).
 *
 * When `CLICKHOUSE_WRITE_USER` is set, writes authenticate as the
 * `analytics_writer` role — data-plane DML only, no DDL / access management
 * (clickhouse migration 47). When unset — bare self-host, local dev before
 * `yarn clickhouse:write-user:dev`, or a CI stack that hasn't provisioned the
 * user — writes fall back to the historical `default` identity via
 * `CLICKHOUSE_PASSWORD`, so nothing breaks before the user exists.
 *
 * This is deliberately NOT the row-policy-scoped read identity
 * (`analytics_reader`, migration 29): tenant isolation is enforced only on the
 * read path. `analytics_writer` is a server credential and its SELECTs are
 * unscoped, exactly as `default`'s were.
 */
export interface ClickHouseWriteAuthEnv {
  CLICKHOUSE_PASSWORD?: string;
  CLICKHOUSE_WRITE_USER?: string;
  CLICKHOUSE_WRITE_PASSWORD?: string;
}

/**
 * The `{ username?, password }` pair to spread into `createClient({ url, ... })`
 * for any write / mutation / server-read client. Spreading keeps `username`
 * absent (not `undefined`) on the fallback path, so the client uses its own
 * `default` default rather than being handed an explicit undefined user.
 */
export function clickHouseWriteAuth(
  env: ClickHouseWriteAuthEnv,
): { username: string; password: string } | { password: string } {
  if (env.CLICKHOUSE_WRITE_USER) {
    return {
      username: env.CLICKHOUSE_WRITE_USER,
      password: env.CLICKHOUSE_WRITE_PASSWORD ?? '',
    };
  }
  return { password: env.CLICKHOUSE_PASSWORD ?? '' };
}
