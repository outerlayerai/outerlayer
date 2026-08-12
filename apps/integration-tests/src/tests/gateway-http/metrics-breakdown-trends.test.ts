/**
 * HTTP-level coverage for `GET /v1/metrics/breakdown` and `GET /v1/metrics/trends`
 * — headless read routes for spend/quality analytics. Neither carries an
 * entitlement gate (see `openapi/index.ts`'s registration calls).
 *
 * `branch`/`agent_type`/`worker_kind`/`model` breakdown dimensions read
 * `agent_session_summary` scoped to the app's dominant repo (mirrors
 * `sessions.test.ts`'s seeding — GitRepo='org/repo' keeps this file's rows
 * on the same dominant repo every other gateway-http fixture uses); `tool`
 * reads `otel_traces` scoped to tenant+app only (no dominant-repo game
 * needed there). `trends` reads the same `agent_session_summary` population
 * as `/v1/metrics/overview`.
 *
 * RUN_ID-unique GitBranch/AgentType/WorkerKind/Model/tool-span values keep
 * each breakdown item isolated from every other file's `org/repo` fixtures
 * that run in the same shared tenant/app, so assertions can be exact
 * (`toEqual`) instead of a `toBeGreaterThanOrEqual` fudge.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsBreakdownResponseSchema, MetricsTrendsResponseSchema } from '@repo/api-schemas';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';

const RUN_ID = randomUUID().slice(0, 8);

const BRANCH_KEY = `breakdown-branch-${RUN_ID}`;
const AGENT_TYPE_KEY = `breakdown-agent-${RUN_ID}`;
const WORKER_KIND_KEY = `breakdown-worker-${RUN_ID}`;
const MODEL_KEY = `breakdown-model-${RUN_ID}`;
const TOOL_KEY = `breakdown-${RUN_ID}`;

const TRACE_DIMENSION = `breakdown-dim-trace-${RUN_ID}`;
const SESSION_DIMENSION = `breakdown-dim-session-${RUN_ID}`;

const TRACE_TREND = `breakdown-trend-trace-${RUN_ID}`;
const SESSION_TREND = `breakdown-trend-session-${RUN_ID}`;

const TOOL_TRACE = `breakdown-tool-trace-${RUN_ID}`;
const TOOL_SPAN_OK = `breakdown-tool-span-ok-${RUN_ID}`;
const TOOL_SPAN_ERR = `breakdown-tool-span-err-${RUN_ID}`;

function chDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe('GET /v1/metrics/breakdown and GET /v1/metrics/trends', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();

  beforeAll(async () => {
    // One session carrying the RUN_ID-unique branch/agent_type/worker_kind/model
    // values every dimension breakdown (except `tool`) ranks — a comfortably
    // large CostUsd keeps `org/repo` the tenant's dominant repo regardless of
    // what other gateway-http files seed under it.
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, WorkerKind, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_DIMENSION}','${SESSION_DIMENSION}','breakdown dimension fixture','${AGENT_TYPE_KEY}','${WORKER_KIND_KEY}','actor-${RUN_ID}',
        'org/repo','${BRANCH_KEY}','','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 4, 10, 2, 7.5, ['${MODEL_KEY}'],
        now(), 'cli'
      )
    `);

    // A second session, on a distinct RUN_ID-unique branch, for the daily
    // trends point — separate row so the breakdown assertions above (which
    // key off BRANCH_KEY) stay exact and unaffected by this one's numbers.
    const trendTs = chDate(new Date());
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_TREND}','${SESSION_TREND}','breakdown trend fixture','claude-code','actor-${RUN_ID}',
        'org/repo','trend-branch-${RUN_ID}','','full',
        '${trendTs}','${trendTs}', 3, 4, 0, 3.25, ['claude-opus-4-8'],
        now(), 'cli'
      )
    `);

    // Two `agent.tool.%` spans (one clean, one erroring) for dimension=tool —
    // tenant+app scoped, not dominant-repo scoped, so no GitRepo column here.
    const ts = chDate(new Date(Date.now() - 30 * 60 * 1000));
    const endTs = chDate(new Date(Date.now() - 29 * 60 * 1000));
    await executeClickHouse(`
      INSERT INTO otel_traces (
        Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
        StatusCode, Type, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
        TenantId, AppId, SessionId, UserId, TraceName,
        EndTime, Input, Output, UpdatedAt, IsDeleted
      ) VALUES
        ('${ts}','${TOOL_TRACE}','${TOOL_SPAN_OK}','','agent.tool.${TOOL_KEY}',
         '1','SPAN',200,0,0,0,0,
         '${tenantId}','${appId}','${SESSION_DIMENSION}','actor-${RUN_ID}','breakdown tool fixture',
         '${endTs}','ok call','ok result', now64(3), 0),
        ('${ts}','${TOOL_TRACE}','${TOOL_SPAN_ERR}','','agent.tool.${TOOL_KEY}',
         '2','SPAN',150,0,0,0,0,
         '${tenantId}','${appId}','${SESSION_DIMENSION}','actor-${RUN_ID}','breakdown tool fixture',
         '${endTs}','err call','err result', now64(3), 0)
    `);

    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId IN ('${TRACE_DIMENSION}', '${TRACE_TREND}') FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE TraceId = '${TOOL_TRACE}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId IN ('${TRACE_DIMENSION}', '${TRACE_TREND}')`);
    await executeClickHouse(`ALTER TABLE otel_traces DELETE WHERE TraceId = '${TOOL_TRACE}'`);
  });

  describe('GET /v1/metrics/breakdown', () => {
    it('dimension=branch ranks by cost with sessions/costUsd/toolErrorRate, isolated to the seeded branch', async () => {
      const res = await gatewayFetch(`/v1/metrics/breakdown?dimension=branch&limit=50`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = MetricsBreakdownResponseSchema.safeParse(body);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

      const data = (body as { data: { dimension: string; items: Array<{ key: string; sessions: number; costUsd: number; toolErrorRate: number }> } }).data;
      expect(data.dimension).toBe('branch');
      const item = data.items.find((i) => i.key === BRANCH_KEY);
      expect(item).toEqual({ key: BRANCH_KEY, sessions: 1, costUsd: 7.5, toolErrorRate: 0.2 });
    });

    it('dimension=agent_type isolates the seeded agent type', async () => {
      const res = await gatewayFetch(`/v1/metrics/breakdown?dimension=agent_type&limit=50`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { items: Array<{ key: string; sessions: number; costUsd: number; toolErrorRate: number }> } };
      const item = body.data.items.find((i) => i.key === AGENT_TYPE_KEY);
      expect(item).toEqual({ key: AGENT_TYPE_KEY, sessions: 1, costUsd: 7.5, toolErrorRate: 0.2 });
    });

    it('dimension=worker_kind isolates the seeded worker kind', async () => {
      const res = await gatewayFetch(`/v1/metrics/breakdown?dimension=worker_kind&limit=50`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { items: Array<{ key: string; sessions: number; costUsd: number; toolErrorRate: number }> } };
      const item = body.data.items.find((i) => i.key === WORKER_KIND_KEY);
      expect(item).toEqual({ key: WORKER_KIND_KEY, sessions: 1, costUsd: 7.5, toolErrorRate: 0.2 });
    });

    it('dimension=model isolates the seeded model', async () => {
      const res = await gatewayFetch(`/v1/metrics/breakdown?dimension=model&limit=50`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { items: Array<{ key: string; sessions: number; costUsd: number; toolErrorRate: number }> } };
      const item = body.data.items.find((i) => i.key === MODEL_KEY);
      expect(item).toEqual({ key: MODEL_KEY, sessions: 1, costUsd: 7.5, toolErrorRate: 0.2 });
    });

    it('dimension=tool carries requests + toolErrorRate, never sessions/costUsd', async () => {
      const res = await gatewayFetch(`/v1/metrics/breakdown?dimension=tool&limit=50`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { items: Array<{ key: string; requests?: number; toolErrorRate?: number; sessions?: number; costUsd?: number }> };
      };
      const item = body.data.items.find((i) => i.key === TOOL_KEY);
      expect(item).toEqual({ key: TOOL_KEY, requests: 2, toolErrorRate: 0.5 });
    });

    // proves AC-052-15
    it('dimension=actor is rejected — outside the closed vocabulary', async () => {
      const res = await gatewayFetch(`/v1/metrics/breakdown?dimension=actor&limit=10`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/metrics/trends', () => {
    // proves AC-052-16
    it('returns one point per day with sessions/costUsd/toolErrorRate/cleanSessionRate, from the overview population', async () => {
      const res = await gatewayFetch(`/v1/metrics/trends?from=${dateOnly(-1)}&to=${dateOnly(1)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = MetricsTrendsResponseSchema.safeParse(body);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

      const points = (body as { data: { points: Array<{ date: string; sessions: number; costUsd: number; toolErrorRate: number; cleanSessionRate: number }> } }).data.points;
      expect(points.map((p) => p.date)).toContain(dateOnly(0));
      const today = points.find((p) => p.date === dateOnly(0))!;
      // Other gateway-http files seed `org/repo` sessions on the same day, so
      // today's bucket isn't exclusively this fixture's row — assert the
      // seeded session's cost is reflected as a floor, not an exact total.
      expect(today!.sessions).toBeGreaterThanOrEqual(1);
      expect(today!.costUsd).toBeGreaterThanOrEqual(3.25);
    });
  });
});
