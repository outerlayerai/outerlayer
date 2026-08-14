/**
 * HTTP-level coverage for `GET /v1/metrics/models`, `GET /v1/metrics/overview`,
 * and `GET /v1/metrics/compare`. `compare` shares the `topics_enabled`
 * entitlement gate with `GET /v1/topics` (its topic-mix half needs the same
 * feature), so the gate is proven here too.
 *
 * `models` reads `otel_traces` GENERATION rows (mirrors the seed in
 * `response-schema-conformance.test.ts`); `overview`/`compare` read
 * `agent_session_summary` (mirrors `preset-permissions.acceptance.test.ts`).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ModelStatsResponseSchema,
  FleetOverviewResponseSchema,
  CompareWindowsResponseSchema,
} from '@repo/api-schemas';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);
const MODEL_NAME = `metrics-http-model-${RUN_ID}`;
// Derived from RUN_ID (not a fixed constant) so two runs of this suite
// within GetModelStats' 60s query-cache TTL never share a cache key with
// each other, or with mcp.test.ts's get_model_costs — see waitForModelStats'
// comment.
const MODELS_LIMIT = 80 + (parseInt(RUN_ID.slice(0, 2), 16) % 20);

async function defaultEnvironmentName(appId: string): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from('environment')
    .select('name')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw new Error(`environment lookup failed: ${error.message}`);
  if (!data?.name) throw new Error(`no default environment for app ${appId}`);
  return data.name;
}

async function setTier(tenantId: string, tierId: 'hobby' | 'growth'): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: existing } = await admin.from('billing').select('tenant_id').eq('tenant_id', tenantId).maybeSingle();
  if (existing) {
    await admin.from('billing').update({ tier_id: tierId }).eq('tenant_id', tenantId);
    return;
  }
  const { error } = await admin.from('billing').insert({ tenant_id: tenantId, tier_id: tierId });
  if (error) throw new Error(`billing seed failed: ${error.message}`);
}

function chDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `GetModelStats` runs with ClickHouse's server-side `use_query_cache`
 * (60s TTL, keyed on the rendered query — app, default date window, and
 * `limit`). `mcp.test.ts`'s `get_model_costs` tool shares an app with this
 * route; using a `limit` distinct from that file's keeps this route off its
 * cache entry (see `MODELS_LIMIT`). Poll is defense-in-depth for the
 * `deduplicate_merge_projection_mode = 'rebuild'` merge lag `otel_traces`'s
 * GROUP-BY-Model projection is otherwise subject to.
 */
async function waitForModelStats(model: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await gatewayFetch(`/v1/metrics/models?limit=${MODELS_LIMIT}`);
    if (res.status === 200) {
      const body = (await res.json()) as { data: { models: Array<{ model: string }> } };
      if (body.data.models.some((m) => m.model === model)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`GET /v1/metrics/models never surfaced model "${model}" within ${timeoutMs}ms`);
}

describe('GET /v1/metrics/*', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();
  let envName: string;

  const TRACE_MODEL = `metrics-http-trace-${RUN_ID}`;
  const SPAN_MODEL = `metrics-http-span-${RUN_ID}`;

  const TRACE_SESSION = `metrics-http-session-trace-${RUN_ID}`;
  const SESSION_ID = `metrics-http-session-${RUN_ID}`;

  beforeAll(async () => {
    envName = await defaultEnvironmentName(appId);
    await setTier(tenantId, 'growth');

    const ts = chDate(new Date(Date.now() - 30 * 60 * 1000));
    const endTs = chDate(new Date(Date.now() - 29 * 60 * 1000));
    await executeClickHouse(`
      INSERT INTO otel_traces (
        Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
        StatusCode, Type, Model, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
        TenantId, AppId, Environment, SessionId, UserId, TraceName,
        EndTime, Input, Output, UpdatedAt, IsDeleted
      ) VALUES (
        '${ts}','${TRACE_MODEL}','${SPAN_MODEL}','','chat',
        '1','GENERATION','${MODEL_NAME}',500,15,25,40,0.42,
        '${tenantId}','${appId}','${envName}','${SESSION_ID}','user-${RUN_ID}','metrics http fixture',
        '${endTs}','hello','world', now64(3), 0
      )
    `);
    // `otel_traces` rebuilds its GROUP-BY-Model projection only on merge
    // (`deduplicate_merge_projection_mode = 'rebuild'`) — a freshly inserted
    // part's projection isn't guaranteed to back GetModelStats' aggregation
    // until a merge runs, which a small table can defer indefinitely. Force
    // it synchronously rather than polling for an unbounded background merge.
    await executeClickHouse('OPTIMIZE TABLE otel_traces FINAL');

    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_SESSION}','${SESSION_ID}-summary','metrics http fixture','claude-code','actor-${RUN_ID}',
        'org/repo','main','','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 2, 1, 0, 0.42, ['${MODEL_NAME}'],
        now(), 'cli'
      )
    `);

    // Match the route's own query shape (FINAL + Type='GENERATION') rather
    // than a bare row-count — a plain SELECT can see the row in an unmerged
    // part before a FINAL aggregation does, and GetModelStats always reads
    // via FINAL.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces FINAL WHERE TraceId = '${TRACE_MODEL}' AND Type = 'GENERATION' AND Model != '' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId = '${TRACE_SESSION}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(`ALTER TABLE otel_traces DELETE WHERE TraceId = '${TRACE_MODEL}'`);
    await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId = '${TRACE_SESSION}'`);
    await getSupabaseAdmin().from('billing').delete().eq('tenant_id', tenantId);
  });

  it(
    'GET /v1/metrics/models conforms to ModelStatsResponseSchema and includes the seeded model',
    async () => {
      await waitForModelStats(MODEL_NAME);
      const res = await gatewayFetch(`/v1/metrics/models?limit=${MODELS_LIMIT}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = ModelStatsResponseSchema.safeParse(body);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

      const models = (body as { data: { models: Array<{ model: string; requests: number }> } }).data.models;
      expect(models.map((m) => ({ model: m.model, requests: m.requests }))).toContainEqual({
        model: MODEL_NAME,
        requests: 1,
      });
    },
    35_000,
  );

  it('GET /v1/metrics/overview conforms to FleetOverviewResponseSchema with a non-zero current session tile', async () => {
    const res = await gatewayFetch(`/v1/metrics/overview?from=${dateOnly(-1)}&to=${dateOnly(1)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = FleetOverviewResponseSchema.safeParse(body);
    expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

    const tiles = (body as { data: { sessions: { current: number } } }).data;
    expect(tiles.sessions.current).toBeGreaterThanOrEqual(1);
  });

  describe('GET /v1/metrics/compare', () => {
    it('conforms to CompareWindowsResponseSchema for two explicit windows', async () => {
      const query = new URLSearchParams({
        aFrom: dateOnly(-1),
        aTo: dateOnly(0),
        bFrom: dateOnly(0),
        bTo: dateOnly(1),
        facet: 'issues',
        limit: '10',
      });
      const res = await gatewayFetch(`/v1/metrics/compare?${query.toString()}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = CompareWindowsResponseSchema.safeParse(body);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

      const data = (body as { data: { windowA: { from: string; to: string }; windowB: { from: string; to: string } } }).data;
      expect(data.windowA.from).toBe(dateOnly(-1));
      expect(data.windowB.to).toBe(dateOnly(1));
    });

    describe('topics_enabled entitlement gate', () => {
      afterAll(async () => {
        await setTier(tenantId, 'growth');
      });

      it('402s with entitlement_required on a tier lacking topics_enabled (hobby)', async () => {
        await setTier(tenantId, 'hobby');
        const query = new URLSearchParams({
          aFrom: dateOnly(-1),
          aTo: dateOnly(0),
          bFrom: dateOnly(0),
          bTo: dateOnly(1),
        });
        const res = await gatewayFetch(`/v1/metrics/compare?${query.toString()}`);
        expect(res.status).toBe(402);
        const body = (await res.json()) as { error: { code: string; entitlement: string } };
        expect(body.error.code).toBe('entitlement_required');
        expect(body.error.entitlement).toBe('topics_enabled');
      });

      it('200s on a tier that includes topics_enabled (growth)', async () => {
        await setTier(tenantId, 'growth');
        const query = new URLSearchParams({
          aFrom: dateOnly(-1),
          aTo: dateOnly(0),
          bFrom: dateOnly(0),
          bTo: dateOnly(1),
        });
        const res = await gatewayFetch(`/v1/metrics/compare?${query.toString()}`);
        expect(res.status).toBe(200);
      });
    });
  });
});
