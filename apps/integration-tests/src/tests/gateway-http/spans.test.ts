/**
 * HTTP-level contract tests for GET /v1/spans new filter params.
 *
 * The spans list endpoint gained new filter params:
 *   - start_date / end_date  (Timestamp range, ISO 8601)
 *   - user_id                (UserId equality)
 *   - session_id             (SessionId equality)
 *   - filter=<JSON>          (AnalyticsFilter[] DSL — span-grain + metadata.*)
 *
 * Mirrors the trace-side pattern in src/tests/gateway-http/traces.test.ts:
 *  - seed otel_traces directly (one row per span, ParentSpanId='' = root)
 *  - drive the live wrangler dev gateway through gatewayFetch
 *  - scope each test run with RUN_ID so we can co-exist with other suites
 *  - cleanup with ALTER TABLE ... DELETE on RUN_ID prefix
 *
 * Cross-tenant isolation: we seed one row owned by a *different* TenantId/AppId
 * and verify it never surfaces in any of the seeded-tenant queries above.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';

const RUN_ID = Date.now().toString(36);

// Time anchors. We seed three windows so ?start_date / ?end_date can each be
// independently verified. ClickHouse's DateTime is second-precision, so the
// gaps below are seconds-wide on purpose.
const NOW = Date.now();
const T_OLD = new Date(NOW - 10 * 24 * 60 * 60 * 1000); // 10 days ago — outside the 7-day default window
const T_MID = new Date(NOW - 90 * 60 * 1000);     // 90m ago
const T_RECENT = new Date(NOW - 5 * 60 * 1000);   //  5m ago

function chDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}
function isoZ(d: Date): string {
  // RFC 3339 with `Z` — what the schema's z.string().datetime() expects.
  return d.toISOString();
}

type Seed = {
  spanId: string;
  traceId: string;
  ts: Date;
  user: string;
  session: string;
  model: string;
  metadata: Record<string, string>;
  status: string; // numeric ClickHouse StatusCode
};

// 4 spans, each varying one dimension so a single filter narrows uniquely.
//   A: T_OLD   , alice, sess-1, gpt-4,        env=prod, OK
//   B: T_MID   , bob  , sess-1, gpt-4,        env=dev , OK   (shares sess+model with A)
//   C: T_RECENT, alice, sess-2, claude-sonnet, env=prod, ERROR (shares user+env with A)
//   D: T_RECENT, carol, sess-3, gpt-4,        env=stg , OK   (isolates carol/sess-3/stg)
const SPANS: Seed[] = [
  { spanId: `s-A-${RUN_ID}`, traceId: `t-A-${RUN_ID}`, ts: T_OLD,    user: `alice-${RUN_ID}`, session: `sess-1-${RUN_ID}`, model: 'gpt-4',          metadata: { env: 'prod' }, status: '1' },
  { spanId: `s-B-${RUN_ID}`, traceId: `t-B-${RUN_ID}`, ts: T_MID,    user: `bob-${RUN_ID}`,   session: `sess-1-${RUN_ID}`, model: 'gpt-4',          metadata: { env: 'dev' },  status: '1' },
  { spanId: `s-C-${RUN_ID}`, traceId: `t-C-${RUN_ID}`, ts: T_RECENT, user: `alice-${RUN_ID}`, session: `sess-2-${RUN_ID}`, model: 'claude-sonnet-4', metadata: { env: 'prod' }, status: '2' },
  { spanId: `s-D-${RUN_ID}`, traceId: `t-D-${RUN_ID}`, ts: T_RECENT, user: `carol-${RUN_ID}`, session: `sess-3-${RUN_ID}`, model: 'gpt-4',          metadata: { env: 'stg' },  status: '1' },
];

function metadataMapLiteral(m: Record<string, string>): string {
  const pairs = Object.entries(m).map(([k, v]) => `'${k}', '${v}'`).join(', ');
  return pairs ? `map(${pairs})` : 'map()';
}

async function seedSpans(appId: string, tenantId: string): Promise<void> {
  const rows = SPANS.map((s) => `(
    '${chDate(s.ts)}', '${s.traceId}', '${s.spanId}', '', 'span-${s.spanId}',
    '${s.status}', 'GENERATION', '${s.model}', 100, 10, 10, 20, 0.001,
    '${tenantId}', '${appId}',
    '${s.session}', '', '${s.user}', 'trace-${s.traceId}',
    ${metadataMapLiteral(s.metadata)},
    '${chDate(new Date(s.ts.getTime() + 100))}',
    now64(3), 0
  )`);

  await executeClickHouse(`
    INSERT INTO otel_traces (
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      StatusCode, Type, Model, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
      TenantId, AppId,
      SessionId, SessionName, UserId, TraceName,
      Metadata,
      EndTime,
      UpdatedAt, IsDeleted
    ) VALUES ${rows.join(',')}
  `);
}

// One row owned by a foreign tenant — same RUN_ID prefix so cleanup catches
// it, but a different TenantId so the gateway must filter it out.
const FOREIGN_TENANT = `foreign-tenant-${RUN_ID}`;
const FOREIGN_APP = `foreign-app-${RUN_ID}`;
const FOREIGN_SPAN = `s-foreign-${RUN_ID}`;

async function seedForeignSpan(): Promise<void> {
  await executeClickHouse(`
    INSERT INTO otel_traces (
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      StatusCode, Type, Model, Duration, TenantId, AppId,
      SessionId, UserId, TraceName, Metadata, EndTime, UpdatedAt, IsDeleted
    ) VALUES (
      '${chDate(T_RECENT)}', 't-foreign-${RUN_ID}', '${FOREIGN_SPAN}', '', 'foreign-span',
      '1', 'GENERATION', 'gpt-4', 100, '${FOREIGN_TENANT}', '${FOREIGN_APP}',
      'sess-1-${RUN_ID}', 'alice-${RUN_ID}', 'trace-foreign', map('env','prod'),
      '${chDate(T_RECENT)}', now64(3), 0
    )
  `);
}

type SpanRow = { id: string; trace_id: string; name: string };
type SpansListBody = {
  data: SpanRow[];
  pagination: { total: number; limit: number; offset: number };
};

async function fetchSpans(params: Record<string, string>): Promise<{
  status: number;
  body: SpansListBody;
}> {
  const qs = new URLSearchParams(params);
  qs.set('limit', '100');
  qs.set('offset', '0');
  const res = await gatewayFetch(`/v1/spans?${qs.toString()}`);
  const body = (await res.json()) as SpansListBody;
  return { status: res.status, body };
}

const SEEDED_IDS = new Set(SPANS.map((s) => s.spanId));
function seededIdsOf(body: SpansListBody): string[] {
  return body.data.map((r) => r.id).filter((id) => SEEDED_IDS.has(id)).sort();
}

describe('GET /v1/spans — new filter params', () => {
  let appId: string;
  let tenantId: string;

  beforeAll(async () => {
    appId = getTestAppId();
    tenantId = getTestTenantId();
    await seedSpans(appId, tenantId);
    await seedForeignSpan();
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE SpanId LIKE 's-%-${RUN_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= SPANS.length + 1,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(
      `ALTER TABLE otel_traces DELETE WHERE SpanId LIKE 's-%-${RUN_ID}'`,
    );
  });

  // -------------------------------------------------------------------------
  // 1. Time range
  // -------------------------------------------------------------------------

  it('?start_date + ?end_date narrows to spans inside the window', async () => {
    // Window covers MID only (excludes OLD which is before, RECENT which is after).
    const start = new Date(T_MID.getTime() - 60 * 1000);
    const end = new Date(T_MID.getTime() + 60 * 1000);
    const { status, body } = await fetchSpans({
      start_date: isoZ(start),
      end_date: isoZ(end),
    });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual([`s-B-${RUN_ID}`]);
  });

  it('?start_date alone (no end_date) bounds only the lower edge', async () => {
    // After T_MID — captures B, C, D but not A.
    const start = new Date(T_MID.getTime() - 60 * 1000);
    const { status, body } = await fetchSpans({ start_date: isoZ(start) });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual(
      [`s-B-${RUN_ID}`, `s-C-${RUN_ID}`, `s-D-${RUN_ID}`].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // 2. user_id
  // -------------------------------------------------------------------------

  it('?user_id= narrows to spans for that user', async () => {
    // alice owns A + C; widen the window to include the older span A.
    const start = new Date(T_OLD.getTime() - 60 * 1000);
    const { status, body } = await fetchSpans({
      user_id: `alice-${RUN_ID}`,
      start_date: isoZ(start),
    });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual(
      [`s-A-${RUN_ID}`, `s-C-${RUN_ID}`].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // 3. session_id
  // -------------------------------------------------------------------------

  it('?session_id= narrows to spans in that session', async () => {
    const start = new Date(T_OLD.getTime() - 60 * 1000);
    const { status, body } = await fetchSpans({
      session_id: `sess-1-${RUN_ID}`,
      start_date: isoZ(start),
    });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual(
      [`s-A-${RUN_ID}`, `s-B-${RUN_ID}`].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // 4. filter DSL — span-grain field (model)
  // -------------------------------------------------------------------------

  it('?filter=<DSL> narrows on span-grain model equals', async () => {
    const start = new Date(T_OLD.getTime() - 60 * 1000);
    const { status, body } = await fetchSpans({
      filter: 'model = "claude-sonnet-4"',
      start_date: isoZ(start),
    });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual([`s-C-${RUN_ID}`]);
  });

  // -------------------------------------------------------------------------
  // 5. filter DSL — metadata.<key> predicate
  // -------------------------------------------------------------------------

  it('?filter=<DSL> with metadata.env predicate narrows on Map lookup', async () => {
    const start = new Date(T_OLD.getTime() - 60 * 1000);
    const { status, body } = await fetchSpans({
      filter: 'metadata.env = "prod"',
      start_date: isoZ(start),
    });
    expect(status).toBe(200);
    // env=prod on A + C only.
    expect(seededIdsOf(body)).toEqual(
      [`s-A-${RUN_ID}`, `s-C-${RUN_ID}`].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // 6. Combined filters (AND semantics)
  // -------------------------------------------------------------------------

  it('combining time + user_id + session_id + filter DSL applies all as AND', async () => {
    // Widen window to include all 4 seeded rows.
    const start = new Date(T_OLD.getTime() - 60 * 1000);
    const { status, body } = await fetchSpans({
      start_date: isoZ(start),
      user_id: `alice-${RUN_ID}`,
      session_id: `sess-2-${RUN_ID}`,
      filter: 'metadata.env = "prod"',
    });
    expect(status).toBe(200);
    // alice ∩ sess-2 ∩ env=prod = {C}.
    expect(seededIdsOf(body)).toEqual([`s-C-${RUN_ID}`]);
  });

  // -------------------------------------------------------------------------
  // 7. Cross-tenant isolation
  // -------------------------------------------------------------------------

  it('never returns spans owned by a different tenant, even when other filters match', async () => {
    // The foreign span shares user/session/env with alice-owned rows. The
    // gateway adds `TenantId = {seeded}` unconditionally, so it must be
    // excluded regardless of which other filter we use.
    const start = new Date(T_OLD.getTime() - 60 * 1000);
    const requests: Array<Record<string, string>> = [
      { user_id: `alice-${RUN_ID}`, start_date: isoZ(start) },
      { session_id: `sess-1-${RUN_ID}`, start_date: isoZ(start) },
      { filter: 'metadata.env = "prod"', start_date: isoZ(start) },
    ];

    for (const params of requests) {
      const { status, body } = await fetchSpans(params);
      expect(status).toBe(200);
      const allIds = body.data.map((r) => r.id);
      expect(allIds).not.toContain(FOREIGN_SPAN);
    }
  });

  // -------------------------------------------------------------------------
  // trace_id-only requests skip the default time window
  //
  // /v1/spans applies a default "recent" window. Applying
  // it to `?trace_id=xxx` requests too would silently drop spans older than the
  // window for callers who only pass `trace_id`, so the default window applies
  // ONLY when `trace_id` is unspecified. These tests pin that contract.
  // -------------------------------------------------------------------------

  it('?trace_id= without start/end returns spans regardless of age (no default window)', async () => {
    // Trace A is anchored at T_OLD (10 days ago), outside the 7-day default
    // window. Without `trace_id`, reaching it would require an explicit
    // start_date wide enough to include T_OLD — so returning span A here is
    // only possible if `trace_id` genuinely bypasses the default window.
    const { status, body } = await fetchSpans({ trace_id: `t-A-${RUN_ID}` });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual([`s-A-${RUN_ID}`]);
  });

  it('?trace_id= + explicit ?start_date narrows further (explicit window wins)', async () => {
    // Trace A's span is at T_OLD. Asking for trace A but with start_date
    // AFTER T_OLD should return zero seeded spans — the explicit bound
    // overrides the "no default when trace_id is set" allowance.
    const start = new Date(T_OLD.getTime() + 5 * 60 * 1000); // 5 min after A
    const { status, body } = await fetchSpans({
      trace_id: `t-A-${RUN_ID}`,
      start_date: isoZ(start),
    });
    expect(status).toBe(200);
    expect(seededIdsOf(body)).toEqual([]);
  });

  // Note: the "default window applies when trace_id is unset" path is the
  // pre-052 trace-handler behavior mirrored on the spans endpoint via
  // `getDefaultTracesStartDate()` (7 days). It's already covered by the
  // trace-side tests and by `getDefaultTracesStartDate`'s own unit tests
  // in `packages/observability-service/src/__tests__/date-utils.test.ts`.
  // What this file pins is the spans-specific contract change above.
});
