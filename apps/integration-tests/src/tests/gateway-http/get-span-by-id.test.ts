/**
 * HTTP-level contract tests for GET /v1/spans/:spanId.
 *
 * The span-by-id endpoint returns the FULL span — metadata + I/O payload
 * (input / output / output_object / tool_calls) — in ONE call, keyed on the
 * globally-unique span_id WITHOUT needing the trace_id. It's the thing you
 * reach for when you hold only a span_id.
 *
 * Mirrors the seeding / teardown pattern in spans.test.ts:
 *  - seed otel_traces directly (one row per span)
 *  - drive the live wrangler dev gateway via gatewayFetch
 *  - scope with RUN_ID; cleanup via ALTER TABLE ... DELETE on the RUN_ID prefix
 *
 * What each test pins:
 *  1. 200 — the full MERGED shape (metadata AND I/O). The metadata-only shape
 *     we explicitly rejected would fail the I/O assertions here.
 *  2. 404 — unknown span_id returns the structured `span_not_found` envelope.
 *  3. cross-tenant 404 — a span owned by a DIFFERENT tenant is not fetchable by
 *     id (the gateway's unconditional TenantId filter), and its I/O never leaks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';

const RUN_ID = Date.now().toString(36);

// Whole-second UTC instant (0 ms) so the round-tripped timestamp compares
// exactly: chDate truncates to seconds, ClickHouse stores it, and
// clickHouseToISO reflects it back to the same instant.
const SEED_TS = new Date('2026-05-01T12:00:00.000Z');

function chDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}
function q(v: string): string {
  return v.replace(/'/g, "''");
}
function metadataMapLiteral(m: Record<string, string>): string {
  const pairs = Object.entries(m)
    .map(([k, v]) => `'${q(k)}', '${q(v)}'`)
    .join(', ');
  return pairs ? `map(${pairs})` : 'map()';
}

type SpanSeed = {
  timestamp: Date;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  spanName: string;
  statusCode: string;
  statusMessage: string;
  type: string;
  model: string;
  duration: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  spanKind: string;
  serviceName: string;
  tenantId: string;
  appId: string;
  sessionId: string;
  userId: string;
  traceName: string;
  metadata: Record<string, string>;
  input: string;
  output: string;
  outputObject: string;
  toolCalls: string;
};

// Column order MUST match the INSERT column list below.
function valuesTuple(s: SpanSeed): string {
  return `(
    '${chDate(s.timestamp)}', '${q(s.traceId)}', '${q(s.spanId)}', '${q(s.parentSpanId)}', '${q(s.spanName)}',
    '${s.statusCode}', '${q(s.statusMessage)}', '${q(s.type)}', '${q(s.model)}', ${s.duration},
    ${s.inputTokens}, ${s.outputTokens}, ${s.totalTokens}, ${s.cost},
    '${q(s.spanKind)}', '${q(s.serviceName)}',
    '${q(s.tenantId)}', '${q(s.appId)}',
    '${q(s.sessionId)}', '${q(s.userId)}', '${q(s.traceName)}',
    ${metadataMapLiteral(s.metadata)},
    '${q(s.input)}', '${q(s.output)}', '${q(s.outputObject)}', '${q(s.toolCalls)}',
    '${chDate(s.timestamp)}', now64(3), 0
  )`;
}

async function insertSpans(rows: SpanSeed[]): Promise<void> {
  await executeClickHouse(`
    INSERT INTO otel_traces (
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      StatusCode, StatusMessage, Type, Model, Duration,
      InputTokens, OutputTokens, TotalTokens, Cost,
      SpanKind, ServiceName,
      TenantId, AppId,
      SessionId, UserId, TraceName,
      Metadata,
      Input, Output, OutputObject, ToolCalls,
      EndTime, UpdatedAt, IsDeleted
    ) VALUES ${rows.map(valuesTuple).join(',')}
  `);
}

const FOREIGN_TENANT = `foreign-tenant-${RUN_ID}`;
const FOREIGN_APP = `foreign-app-${RUN_ID}`;

// The owned span: every field set to a distinct, non-default value so the
// 200 assertion pins each one flowing through (status mapping, parent_id,
// token columns, the metadata Map, and all four I/O columns).
const OWNED: SpanSeed = {
  timestamp: SEED_TS,
  traceId: `t-owned-${RUN_ID}`,
  spanId: `getspan-owned-${RUN_ID}`,
  parentSpanId: `p-${RUN_ID}`,
  spanName: 'llm-call',
  statusCode: '2', // → 'ERROR'
  statusMessage: 'rate limited',
  type: 'GENERATION',
  model: 'gpt-4o',
  duration: 1234,
  inputTokens: 11,
  outputTokens: 22,
  totalTokens: 33,
  cost: 0.125, // exact in binary float64
  spanKind: 'client',
  serviceName: 'api',
  tenantId: '', // filled in beforeAll
  appId: '', // filled in beforeAll
  sessionId: `sess-${RUN_ID}`,
  userId: `user-${RUN_ID}`,
  traceName: 'trace-owned',
  metadata: { env: 'prod', region: 'us' },
  input: `INPUT_${RUN_ID}`,
  output: `OUTPUT_${RUN_ID}`,
  outputObject: '{"answer":42}',
  toolCalls: '[{"name":"search"}]',
};

// A span with a KNOWN id owned by a different tenant, carrying secret I/O that
// must never surface to the seeded tenant.
const FOREIGN: SpanSeed = {
  timestamp: SEED_TS,
  traceId: `t-foreign-${RUN_ID}`,
  spanId: `getspan-foreign-${RUN_ID}`,
  parentSpanId: '',
  spanName: 'foreign-span',
  statusCode: '1',
  statusMessage: '',
  type: 'GENERATION',
  model: 'gpt-4',
  duration: 50,
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cost: 0,
  spanKind: '',
  serviceName: '',
  tenantId: FOREIGN_TENANT,
  appId: FOREIGN_APP,
  sessionId: '',
  userId: '',
  traceName: 'trace-foreign',
  metadata: {},
  input: `FOREIGN_INPUT_${RUN_ID}`,
  output: `FOREIGN_OUTPUT_${RUN_ID}`,
  outputObject: '',
  toolCalls: '',
};

type FullSpan = {
  id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  status: string;
  status_message: string;
  duration_ms: number;
  timestamp: string;
  type: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  tokens: number;
  cost: number;
  span_kind: string;
  service_name: string;
  metadata: Record<string, string>;
  input: string;
  output: string;
  output_object: string | null;
  tool_calls: string | null;
};

async function getSpanById(
  spanId: string,
): Promise<{ status: number; json: unknown }> {
  const res = await gatewayFetch(`/v1/spans/${encodeURIComponent(spanId)}`);
  return { status: res.status, json: (await res.json()) as unknown };
}

describe('GET /v1/spans/:spanId', () => {
  beforeAll(async () => {
    OWNED.tenantId = getTestTenantId();
    OWNED.appId = getTestAppId();
    await insertSpans([OWNED, FOREIGN]);
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE SpanId LIKE 'getspan-%-${RUN_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(
      `ALTER TABLE otel_traces DELETE WHERE SpanId LIKE 'getspan-%-${RUN_ID}'`,
    );
  });

  it('returns the full span (metadata + I/O) by span_id alone — no trace_id needed', async () => {
    const { status, json } = await getSpanById(OWNED.spanId);
    expect(status).toBe(200);

    const { data } = json as { data: FullSpan };
    expect(data).toEqual({
      id: OWNED.spanId,
      trace_id: OWNED.traceId,
      parent_id: OWNED.parentSpanId,
      name: OWNED.spanName,
      status: 'ERROR',
      status_message: OWNED.statusMessage,
      duration_ms: OWNED.duration,
      timestamp: expect.any(String),
      type: OWNED.type,
      model: OWNED.model,
      input_tokens: OWNED.inputTokens,
      output_tokens: OWNED.outputTokens,
      tokens: OWNED.totalTokens,
      cost: OWNED.cost,
      span_kind: OWNED.spanKind,
      service_name: OWNED.serviceName,
      metadata: OWNED.metadata,
      // The four I/O fields are the point of this endpoint: a metadata-only
      // response (the shape we rejected) would be missing all of them.
      input: OWNED.input,
      output: OWNED.output,
      output_object: OWNED.outputObject,
      tool_calls: OWNED.toolCalls,
    });
    // Timestamp is normalized to ISO 8601 and pins back to the seeded instant.
    expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(data.timestamp).getTime()).toBe(SEED_TS.getTime());
  });

  it('404s with span_not_found for an unknown span id', async () => {
    const { status, json } = await getSpanById(`getspan-nope-${RUN_ID}`);
    expect(status).toBe(404);
    expect((json as { error: { code: string; message: string } }).error).toEqual({
      code: 'span_not_found',
      message: 'Span not found',
    });
  });

  it('404s (never 200) for a span owned by a different tenant, and leaks no I/O', async () => {
    // FOREIGN.spanId exists in otel_traces, but belongs to FOREIGN_TENANT. The
    // gateway scopes every query by the caller's TenantId, so fetching it by id
    // must behave exactly like "not found" — and must not expose its payload.
    const { status, json } = await getSpanById(FOREIGN.spanId);
    expect(status).toBe(404);
    expect((json as { error: { code: string } }).error.code).toBe('span_not_found');

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(FOREIGN.input);
    expect(serialized).not.toContain(FOREIGN.output);
  });
});
