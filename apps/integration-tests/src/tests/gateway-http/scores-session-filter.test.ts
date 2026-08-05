/**
 * HTTP-level contract test for GET /v1/scores `session_id` filter.
 *
 * The session_id filter resolves a SessionId via otel_traces, then narrows
 * scores whose ResourceId matches a TraceId or SpanId in that session — see
 * SCORES_SESSION_FILTER_CLAUSE in packages/observability-service/src/queries.ts.
 * This test exercises the full HTTP path (chanfana parsing, Hono routing,
 * observability-service, real ClickHouse round-trip) so that contract drift
 * surfaces here rather than in a downstream consumer.
 *
 * Mirrors the seeding/run-id pattern used by gateway-http/traces.test.ts and
 * analytics-filters.test.ts: TraceIds + ScoreIds keyed by Date.now() to avoid
 * cross-run pollution on a shared ClickHouse.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';

const RUN_ID = Date.now().toString(36);

const SESSION_A = `scores-sess-A-${RUN_ID}`;
const SESSION_B = `scores-sess-B-${RUN_ID}`;
const SESSION_EMPTY = `scores-sess-EMPTY-${RUN_ID}`;
const FOREIGN_TENANT_ID = `foreign-tenant-${RUN_ID}`;

// Trace + span ids per session. Scores attach to either TraceId or SpanId
// (ResourceId is the union), so we cover both link forms.
const TRACE_A1 = `scores-trace-A1-${RUN_ID}`;
const SPAN_A1 = `scores-span-A1-${RUN_ID}`;
const TRACE_A2 = `scores-trace-A2-${RUN_ID}`;
const SPAN_A2 = `scores-span-A2-${RUN_ID}`;

const TRACE_B1 = `scores-trace-B1-${RUN_ID}`;
const SPAN_B1 = `scores-span-B1-${RUN_ID}`;

// Foreign-tenant trace and score in SESSION_A — must NOT appear in our results.
const FOREIGN_TRACE = `scores-foreign-trace-${RUN_ID}`;
const FOREIGN_SPAN = `scores-foreign-span-${RUN_ID}`;

// Score ids — scoped by RUN_ID so cleanup + filtering are easy.
const SCORE_A_TRACE = `scores-id-A-trace-${RUN_ID}`;
const SCORE_A_SPAN = `scores-id-A-span-${RUN_ID}`;
const SCORE_A2_TRACE = `scores-id-A2-trace-${RUN_ID}`;
const SCORE_B_TRACE = `scores-id-B-trace-${RUN_ID}`;
const SCORE_NO_SESSION = `scores-id-no-session-${RUN_ID}`;
const SCORE_FOREIGN = `scores-id-foreign-${RUN_ID}`;

const ALL_SESSION_A_SCORE_IDS = [SCORE_A_TRACE, SCORE_A_SPAN, SCORE_A2_TRACE].sort();

function formatClickHouseDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

async function seedTraces(appId: string, tenantId: string): Promise<void> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const ts = formatClickHouseDate(hourAgo);
  const endTs = formatClickHouseDate(new Date(hourAgo.getTime() + 1000));

  type TraceRow = {
    traceId: string;
    spanId: string;
    sessionId: string;
    tenantId: string;
  };

  const rows: TraceRow[] = [
    { traceId: TRACE_A1, spanId: SPAN_A1, sessionId: SESSION_A, tenantId },
    { traceId: TRACE_A2, spanId: SPAN_A2, sessionId: SESSION_A, tenantId },
    { traceId: TRACE_B1, spanId: SPAN_B1, sessionId: SESSION_B, tenantId },
    // Foreign tenant in SESSION_A — used to verify cross-tenant isolation.
    {
      traceId: FOREIGN_TRACE,
      spanId: FOREIGN_SPAN,
      sessionId: SESSION_A,
      tenantId: FOREIGN_TENANT_ID,
    },
  ];

  const valueRows = rows.map(
    (r) => `(
    '${ts}', '${r.traceId}', '${r.spanId}', '', 'span',
    'OK', 'GENERATION', 'gpt-4', 1000, 50, 50, 100, 0.01,
    '${r.tenantId}', '${appId}',
    '${r.sessionId}', '', '', 'trace',
    '', [],
    '${endTs}', '', '',
    now64(3), 0
  )`,
  );

  await executeClickHouse(`
    INSERT INTO otel_traces (
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      StatusCode, Type, Model, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
      TenantId, AppId,
      SessionId, SessionName, UserId, TraceName,
      CommitSha, Tags,
      EndTime, Input, Output,
      UpdatedAt, IsDeleted
    ) VALUES ${valueRows.join(',')}
  `);
}

async function seedScores(appId: string, tenantId: string): Promise<void> {
  type ScoreRow = {
    id: string;
    resourceId: string;
    name: string;
    score: number;
    tenantId: string;
  };

  const rows: ScoreRow[] = [
    // SESSION_A — score attached to TraceId.
    { id: SCORE_A_TRACE, resourceId: TRACE_A1, name: 'A-trace', score: 0.91, tenantId },
    // SESSION_A — score attached to SpanId (covers the UNION DISTINCT branch).
    { id: SCORE_A_SPAN, resourceId: SPAN_A1, name: 'A-span', score: 0.92, tenantId },
    // SESSION_A — second trace in same session.
    { id: SCORE_A2_TRACE, resourceId: TRACE_A2, name: 'A2-trace', score: 0.93, tenantId },
    // SESSION_B — must be excluded when filtering by SESSION_A.
    { id: SCORE_B_TRACE, resourceId: TRACE_B1, name: 'B-trace', score: 0.5, tenantId },
    // No matching session — orphan ResourceId, must always be excluded.
    {
      id: SCORE_NO_SESSION,
      resourceId: `orphan-${RUN_ID}`,
      name: 'orphan',
      score: 0.1,
      tenantId,
    },
    // Foreign-tenant score on a foreign-tenant SESSION_A trace — cross-tenant
    // isolation guard. Even though SessionId matches, the trace's TenantId
    // differs, so the UNION sub-select returns nothing for our tenant.
    {
      id: SCORE_FOREIGN,
      resourceId: FOREIGN_TRACE,
      name: 'foreign',
      score: 0.42,
      tenantId: FOREIGN_TENANT_ID,
    },
  ];

  const valueRows = rows.map(
    (r) => `(
    '${r.id}', '${r.tenantId}', '${appId}',
    ${r.score}, '', '', '${r.resourceId}', '${r.name}',
    '', '', 'eval', '',
    now64(3), now64(3), 0
  )`,
  );

  await executeClickHouse(`
    INSERT INTO scores (
      Id, TenantId, AppId, Score, Label, Reason, ResourceId, Name,
      Type, DataType, Source, UserId,
      CreatedAt, UpdatedAt, IsDeleted
    ) VALUES ${valueRows.join(',')}
  `);
}

type ScoreListBody = {
  data: Array<{ id: string; resource_id: string; name: string }>;
  pagination: { total: number; limit: number; offset: number };
};

async function fetchScoresList(
  params: Record<string, string>,
): Promise<{ status: number; body: ScoreListBody }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.append(k, v);
  qs.set('limit', '50');
  qs.set('offset', '0');
  // Wide window so seeded rows (now64(3)) are within the date filter.
  // ScoresListParamsSchema enforces YYYY-MM-DD format on these fields.
  const ymd = (d: Date): string => d.toISOString().slice(0, 10);
  qs.set('start_date', ymd(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  qs.set('end_date', ymd(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const res = await gatewayFetch(`/v1/scores?${qs.toString()}`);
  const body = (await res.json()) as ScoreListBody;
  return { status: res.status, body };
}

function seededIdsOf(body: ScoreListBody): string[] {
  const seeded = new Set([
    SCORE_A_TRACE,
    SCORE_A_SPAN,
    SCORE_A2_TRACE,
    SCORE_B_TRACE,
    SCORE_NO_SESSION,
    SCORE_FOREIGN,
  ]);
  return body.data
    .map((s) => s.id)
    .filter((id) => seeded.has(id))
    .sort();
}

describe('GET /v1/scores — session_id filter', () => {
  let appId: string;
  let tenantId: string;

  beforeAll(async () => {
    appId = getTestAppId();
    tenantId = getTestTenantId();
    await seedTraces(appId, tenantId);
    await seedScores(appId, tenantId);

    // Wait for both tables to expose the seeded rows. ReplacingMergeTree is
    // eventually consistent + async inserts add a flush delay.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE TraceId LIKE 'scores-%-${RUN_ID}' OR TraceId = '${FOREIGN_TRACE}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 4,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM scores WHERE Id LIKE 'scores-id-%-${RUN_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 6,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(
      `ALTER TABLE otel_traces DELETE WHERE TraceId LIKE 'scores-%-${RUN_ID}' OR TraceId = '${FOREIGN_TRACE}'`,
    );
    await executeClickHouse(
      `ALTER TABLE scores DELETE WHERE Id LIKE 'scores-id-%-${RUN_ID}'`,
    );
  });

  it('returns only scores whose ResourceId is a Trace or Span in the session', async () => {
    const { status, body } = await fetchScoresList({ session_id: SESSION_A });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual(ALL_SESSION_A_SCORE_IDS);
  });

  it('excludes scores attached to traces in a different session', async () => {
    const { status, body } = await fetchScoresList({ session_id: SESSION_A });
    expect(status).toBe(200);
    const ids = seededIdsOf(body);
    expect(ids).not.toContain(SCORE_B_TRACE);
    expect(ids).not.toContain(SCORE_NO_SESSION);
  });

  it('isolates across tenants — does not return foreign-tenant scores in the same session id', async () => {
    const { status, body } = await fetchScoresList({ session_id: SESSION_A });
    expect(status).toBe(200);
    // SCORE_FOREIGN sits on a SESSION_A trace owned by FOREIGN_TENANT_ID. The
    // gateway scopes both the scores query and the session UNION sub-select
    // by TenantId, so the foreign score must never surface — even though it
    // technically matches the requested SessionId.
    expect(seededIdsOf(body)).not.toContain(SCORE_FOREIGN);
  });

  it('returns an empty list when session_id has no matching scores', async () => {
    const { status, body } = await fetchScoresList({ session_id: SESSION_EMPTY });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('omitting session_id returns scores from all sessions (no narrowing)', async () => {
    const { status, body } = await fetchScoresList({});
    expect(status).toBe(200);
    const ids = seededIdsOf(body);
    // All same-tenant seeds (A1+A_SPAN+A2 + B + orphan); foreign is excluded
    // by the gateway's TenantId scope on the scores table itself.
    expect(ids).toEqual(
      [SCORE_A_TRACE, SCORE_A_SPAN, SCORE_A2_TRACE, SCORE_B_TRACE, SCORE_NO_SESSION].sort(),
    );
    expect(ids).not.toContain(SCORE_FOREIGN);
  });
});
