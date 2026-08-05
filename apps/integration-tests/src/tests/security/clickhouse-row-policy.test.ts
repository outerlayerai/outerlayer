/**
 * ClickHouse row-policy tenant isolation — the red-team canary.
 *
 * These tests hit the REAL integration ClickHouse (:18123) with the REAL
 * `analytics_reader` user provisioned by setup-clickhouse.ts, against the
 * REAL policies from migration 29. No app code in the loop — this is the
 * policy layer itself, deliberately below the app-layer WHERE clauses that
 * `observability-service`'s tenant-id-enforcement tests already pin.
 *
 * What must hold: a tenant-B key can never read tenant-A rows, even with a
 * maliciously altered filter.
 *
 *   - a reader scoped to tenant A sees ONLY tenant A rows, with NO WHERE at all
 *   - a reader scoped to tenant B asking for tenant A by WHERE gets NOTHING
 *   - a reader with NO tenant setting gets an ERROR (fail-closed), never rows
 *   - the reader identity cannot INSERT
 *   - the writer/admin identity stays unrestricted (ingest + platform reads)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CLICKHOUSE_TEST_HOST,
  CLICKHOUSE_TEST_READ_USER,
  CLICKHOUSE_TEST_READ_PASSWORD,
  executeClickHouse,
  queryClickHouse,
} from '../../../clickhouse/setup-clickhouse';

// Unique per run so parallel/local re-runs never collide.
const RUN = randomBytes(4).toString('hex');
const TENANT_A = `rp-tenant-a-${RUN}`;
const TENANT_B = `rp-tenant-b-${RUN}`;
const APP_A = `rp-app-a-${RUN}`;
const APP_B = `rp-app-b-${RUN}`;

/** Query as the row-policy'd READ user. Returns raw ok/text so tests can
 * assert on errors as first-class outcomes (fail-closed is the contract). */
async function readerQuery(
  sql: string,
  settings: Record<string, string> = {},
): Promise<{ ok: boolean; text: string }> {
  const url = new URL(CLICKHOUSE_TEST_HOST);
  url.searchParams.set('user', CLICKHOUSE_TEST_READ_USER);
  url.searchParams.set('password', CLICKHOUSE_TEST_READ_PASSWORD);
  url.searchParams.set('default_format', 'JSONEachRow');
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'POST', body: sql });
  return { ok: res.ok, text: (await res.text()).trim() };
}

const parseRows = <T>(text: string): T[] =>
  text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as T);

beforeAll(async () => {
  // Seed two tenants across the table shapes the canary exercises: a policy'd
  // fact table (otel_traces), an agent table (agent_session_summary), scores,
  // and a derived rollup (skill_activation_by_day, below).
  await executeClickHouse(
    `INSERT INTO otel_traces (Timestamp, TraceId, SpanId, TenantId, AppId, Type, StatusCode, Cost, TotalTokens, Duration, Model)
     VALUES
       (now(), 'rp-trace-a-${RUN}', 's1', '${TENANT_A}', '${APP_A}', 'GENERATION', '1', 0.1, 10, 5, 'rp-model'),
       (now(), 'rp-trace-b-${RUN}', 's2', '${TENANT_B}', '${APP_B}', 'GENERATION', '1', 0.2, 20, 6, 'rp-model')`,
  );
  // Rollup rows arrive the way production's do — through
  // skill_activation_by_day_mv off an `agent.session` span carrying a
  // `skill_activated` event. Seeding the destination table directly would need
  // hand-built uniqExact states AND would stop proving the MV path lands rows
  // under the right tenant.
  await executeClickHouse(
    `INSERT INTO otel_traces
       (Timestamp, TraceId, SpanId, TenantId, AppId, SpanName,
        \`Events.Name\`, \`Events.Timestamp\`, \`Events.Attributes\`)
     VALUES
       (now(), 'rp-skill-a-${RUN}', 'sk1', '${TENANT_A}', '${APP_A}', 'agent.session',
        ['skill_activated'], [now()], [map('skill', 'rp-skill')]),
       (now(), 'rp-skill-b-${RUN}', 'sk2', '${TENANT_B}', '${APP_B}', 'agent.session',
        ['skill_activated'], [now()], [map('skill', 'rp-skill')])`,
  );
  await executeClickHouse(
    `INSERT INTO agent_session_summary (TenantId, AppId, TraceId, StartedAt)
     VALUES ('${TENANT_A}', '${APP_A}', 'rp-sess-a-${RUN}', now()),
            ('${TENANT_B}', '${APP_B}', 'rp-sess-b-${RUN}', now())`,
  );
  await executeClickHouse(
    `INSERT INTO scores (Id, TenantId, AppId, Name, CreatedAt)
     VALUES ('rp-score-a-${RUN}', '${TENANT_A}', '${APP_A}', 'accuracy', now()),
            ('rp-score-b-${RUN}', '${TENANT_B}', '${APP_B}', 'accuracy', now())`,
  );
});

afterAll(async () => {
  // The integration CH is torn down with `down -v` in CI, but local runs
  // reuse the container — delete only this run's uniquely-named rows.
  await executeClickHouse(
    `ALTER TABLE otel_traces DELETE WHERE TenantId IN ('${TENANT_A}', '${TENANT_B}')`,
  );
  await executeClickHouse(
    `ALTER TABLE agent_session_summary DELETE WHERE TenantId IN ('${TENANT_A}', '${TENANT_B}')`,
  );
  await executeClickHouse(
    `ALTER TABLE scores DELETE WHERE TenantId IN ('${TENANT_A}', '${TENANT_B}')`,
  );
  // A base-table delete never cascades into a rollup, so the aggregated rows
  // need their own delete.
  await executeClickHouse(
    `ALTER TABLE skill_activation_by_day DELETE WHERE TenantId IN ('${TENANT_A}', '${TENANT_B}')`,
  );
});

describe('ClickHouse row-policy tenant isolation (analytics_reader)', () => {
  it('a tenant-A-scoped read with NO WHERE clause sees only tenant A — on every covered table shape', async () => {
    const traces = await readerQuery(
      `SELECT TenantId FROM otel_traces WHERE TraceId LIKE 'rp-trace-%-${RUN}' ORDER BY TenantId`,
      { SQL_tenant_id: TENANT_A },
    );
    expect(traces.ok).toBe(true);
    expect(parseRows<{ TenantId: string }>(traces.text)).toEqual([{ TenantId: TENANT_A }]);

    const sessions = await readerQuery(
      `SELECT TenantId, TraceId FROM agent_session_summary WHERE TraceId LIKE 'rp-sess-%-${RUN}'`,
      { SQL_tenant_id: TENANT_A },
    );
    expect(sessions.ok).toBe(true);
    expect(parseRows(sessions.text)).toEqual([
      { TenantId: TENANT_A, TraceId: `rp-sess-a-${RUN}` },
    ]);

    const scores = await readerQuery(
      `SELECT TenantId FROM scores WHERE Id LIKE 'rp-score-%-${RUN}'`,
      { SQL_tenant_id: TENANT_A },
    );
    expect(scores.ok).toBe(true);
    expect(parseRows(scores.text)).toEqual([{ TenantId: TENANT_A }]);
  });

  it("RED TEAM: a tenant-B-scoped read explicitly WHERE'ing for tenant A gets ZERO rows", async () => {
    const res = await readerQuery(
      `SELECT TenantId FROM agent_session_summary WHERE TenantId = '${TENANT_A}'`,
      { SQL_tenant_id: TENANT_B },
    );
    expect(res.ok).toBe(true);
    expect(parseRows(res.text)).toEqual([]);
  });

  it('FAIL-CLOSED: a read with NO tenant setting ERRORS — it never returns unfiltered rows', async () => {
    const res = await readerQuery(`SELECT count() FROM agent_session_summary`);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('UNKNOWN_SETTING');
    expect(res.text).toContain('SQL_tenant_id');
  });

  it('a DERIVED rollup is policy-covered too: tenant-scoped read filters, cross-tenant WHERE gets nothing, tenant-less fails closed', async () => {
    // Row policies must cover every fact table AND every analytics aggregate
    // derived from them. Rollups are the shape that gets forgotten, and an
    // uncovered one exposes another tenant's totals even while the underlying
    // facts stay protected. Any new aggregate added without a policy fails here.
    const scoped = await readerQuery(
      `SELECT TenantId, AppId FROM skill_activation_by_day WHERE Skill = 'rp-skill' GROUP BY TenantId, AppId`,
      { SQL_tenant_id: TENANT_A },
    );
    expect(scoped.ok).toBe(true);
    expect(parseRows(scoped.text)).toEqual([{ TenantId: TENANT_A, AppId: APP_A }]);

    // RED TEAM: tenant B asking for tenant A's app by WHERE gets zero rows.
    const crossTenant = await readerQuery(
      `SELECT AppId FROM skill_activation_by_day WHERE AppId = '${APP_A}' GROUP BY AppId`,
      { SQL_tenant_id: TENANT_B },
    );
    expect(crossTenant.ok).toBe(true);
    expect(parseRows(crossTenant.text)).toEqual([]);

    const tenantless = await readerQuery(`SELECT count() FROM skill_activation_by_day`);
    expect(tenantless.ok).toBe(false);
    expect(tenantless.text).toContain('UNKNOWN_SETTING');
    expect(tenantless.text).toContain('SQL_tenant_id');
  });

  it('the reader identity cannot INSERT (read-only by grants, not by convention)', async () => {
    const res = await readerQuery(
      `INSERT INTO agent_session_summary (TenantId, AppId, TraceId, StartedAt)
       VALUES ('${TENANT_A}', '${APP_A}', 'rp-illegal-${RUN}', now())`,
      { SQL_tenant_id: TENANT_A },
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain('ACCESS_DENIED');
  });

  it('the writer/admin identity is NOT policy-restricted (ingest + platform reads unchanged)', async () => {
    const rows = await queryClickHouse(
      `SELECT TenantId FROM agent_session_summary WHERE TraceId LIKE 'rp-sess-%-${RUN}' ORDER BY TenantId`,
    );
    expect(rows).toEqual([{ TenantId: TENANT_A }, { TenantId: TENANT_B }]);
  });
});
