/**
 * Privilege-boundary test — the APP write identity on real ClickHouse.
 *
 * The gateway data plane authenticates as `analytics_writer`, not the `default`
 * superuser. This proves that role is exactly as powerful as the data plane
 * needs and no more, against a real
 * server — so a future migration that over-grants it (e.g. widening
 * `SELECT, INSERT, ALTER UPDATE, ALTER DELETE ON default.*` to `ALL`, or adding
 * ACCESS MANAGEMENT) fails here instead of shipping.
 *
 * What must hold, driven as the CI-provisioned analytics_writer user:
 *   - it CAN do the data-plane DML: INSERT, the retention `ALTER DELETE`, and
 *     the `system.mutations` backpressure read;
 *   - it is DENIED every escalation: DROP / CREATE TABLE (DDL) and CREATE USER
 *     (access management) all come back ACCESS_DENIED.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CLICKHOUSE_TEST_HOST,
  CLICKHOUSE_TEST_WRITE_USER,
  CLICKHOUSE_TEST_WRITE_PASSWORD,
} from '../../../clickhouse/setup-clickhouse';

const RUN = randomBytes(4).toString('hex');
const TRACE_ID = `wperm-trace-${RUN}`;
const TENANT = `wperm-tenant-${RUN}`;

/** Run a statement as the write identity; return the HTTP status + body. */
async function asWriter(sql: string): Promise<{ ok: boolean; status: number; body: string }> {
  const url = new URL(CLICKHOUSE_TEST_HOST);
  url.searchParams.set('user', CLICKHOUSE_TEST_WRITE_USER);
  url.searchParams.set('password', CLICKHOUSE_TEST_WRITE_PASSWORD);
  // Synchronous insert so the row is visible to the follow-up read/delete.
  url.searchParams.set('async_insert', '0');
  url.searchParams.set('wait_for_async_insert', '1');
  const res = await fetch(url, { method: 'POST', body: sql });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

afterAll(async () => {
  await asWriter(`ALTER TABLE otel_traces DELETE WHERE TenantId = '${TENANT}'`);
});

describe('analytics_writer privilege boundary on real ClickHouse', () => {
  it('CAN INSERT ingest rows', async () => {
    const r = await asWriter(
      `INSERT INTO otel_traces (Timestamp, TraceId, SpanId, TenantId, AppId)
       VALUES (now(), '${TRACE_ID}', '${TRACE_ID}-span', '${TENANT}', 'wperm-app')`,
    );
    expect(r.ok).toBe(true);
  });

  it('CAN run the retention ALTER DELETE mutation', async () => {
    const r = await asWriter(
      `ALTER TABLE otel_traces DELETE WHERE TraceId = '${TRACE_ID}'`,
    );
    expect(r.ok).toBe(true);
  });

  it('CAN read system.mutations (retention backpressure signal)', async () => {
    const r = await asWriter(
      `SELECT count() FROM system.mutations WHERE database = currentDatabase() AND is_done = 0`,
    );
    expect(r.ok).toBe(true);
  });

  it('is DENIED DROP TABLE (no DDL)', async () => {
    const r = await asWriter(`DROP TABLE otel_traces`);
    expect(r.ok).toBe(false);
    expect(r.body).toContain('ACCESS_DENIED');
  });

  it('is DENIED CREATE TABLE (no DDL)', async () => {
    const r = await asWriter(`CREATE TABLE wperm_evil_${RUN} (x UInt8) ENGINE = Memory`);
    expect(r.ok).toBe(false);
    expect(r.body).toContain('ACCESS_DENIED');
  });

  it('is DENIED CREATE USER (no access management)', async () => {
    const r = await asWriter(
      `CREATE USER wperm_evil_${RUN} IDENTIFIED WITH sha256_password BY 'x'`,
    );
    expect(r.ok).toBe(false);
    expect(r.body).toContain('ACCESS_DENIED');
  });
});
