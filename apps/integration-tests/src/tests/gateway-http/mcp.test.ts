/**
 * HTTP-level coverage for `POST /v1/mcp` against the real (hosted) gateway —
 * the wrangler-dev boundary `client.ts`'s `gatewayFetch` drives, as opposed to
 * `self-host/mcp.test.ts`'s direct `dispatchRequest` call. Covers: session
 * bootstrap (`initialize`), the full ten-tool catalog (`tools/list`), a
 * `tools/call` per tool with its `structuredContent` validated against the
 * same `@repo/api-schemas` output schema `openapi/mcp/tools.ts` declares, the
 * permission/entitlement JSON-RPC app-error codes the dispatcher raises
 * (`-32001`/`-32002` — see `openapi/mcp/dispatcher.ts`), a tool executor
 * domain error surfacing as an `isError` result (not a transport fault), and
 * REST/MCP parity for `list_topics` and `get_breakdown` (the HTTP-level
 * analogue of `list-topics-parity.test.ts`, which proves the same invariant
 * at the unit layer).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TopicsResponseSchema,
  SessionsListResponseSchema,
  SessionDetailResponseSchema,
  ModelStatsResponseSchema,
  FleetOverviewResponseSchema,
  ContextChangesResponseSchema,
  CompareWindowsResponseSchema,
  MetricsBreakdownResponseSchema,
  MetricsTrendsResponseSchema,
  PrOutcomesResponseSchema,
} from '@repo/api-schemas';
import { getPermissionsForRole } from 'tenant-dashboard/src/lib/gateway-permissions';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId, mintTestApiKey } from './client';
import { getTestAppId, GATEWAY_URL } from '../../../gateway-http/setup-gateway';
import { resolveDefaultEnvironmentId } from '../../lib/environment-test-utils';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);
const RUN_HEX = RUN_ID.replace(/-/g, '');
const TRACE_ID = `${RUN_HEX}${'0'.repeat(32 - RUN_HEX.length)}`;
const SPAN_ID = `${RUN_HEX}${'0'.repeat(16 - RUN_HEX.length)}`;
const SESSION_ID = `mcp-http-${RUN_ID}`;
const MODEL_NAME = `mcp-http-model-${RUN_ID}`;
// Derived from RUN_ID (not a fixed constant) so two runs of this suite
// within GetModelStats' 60s query-cache TTL never share a cache key with
// each other — see waitForModelCostsTool's comment.
const MODEL_COSTS_LIMIT = 40 + (parseInt(RUN_ID.slice(0, 2), 16) % 40);
const TOPIC_ID = `mcp-http-topic-${RUN_ID}`;
const ACTOR_ID = `actor-mcp-${RUN_ID}`;
const BREAKDOWN_BRANCH_KEY = `mcp-breakdown-branch-${RUN_ID}`;
const BREAKDOWN_TOOL_KEY = `mcp-${RUN_ID}`;
const RUN_NUM = parseInt(RUN_ID.slice(0, 6), 16) % 900_000;
const PR_NUMBER = RUN_NUM + 3;
const PR_BRANCH = `mcp-pr-${RUN_ID}`;
const TRACE_BREAKDOWN = `mcp-breakdown-trace-${RUN_ID}`;
const TRACE_TOOL = `mcp-tool-trace-${RUN_ID}`;
const SPAN_TOOL = `mcp-tool-span-${RUN_ID}`;
const TRACE_PR = `mcp-pr-trace-${RUN_ID}`;

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: { code: number; message: string };
}

async function mcpCall<T = unknown>(
  method: string,
  params: unknown,
  id: number,
  key?: string,
): Promise<JsonRpcResponse<T>> {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const res = key
    ? await fetch(`${GATEWAY_URL}/v1/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'x-outerlayer-app-id': getTestAppId(),
        },
        body,
      })
    : await gatewayFetch('/v1/mcp', { method: 'POST', body });
  expect(res.status, `POST /v1/mcp (${method}) transport status`).toBe(200);
  return res.json() as Promise<JsonRpcResponse<T>>;
}

async function toolsCall<T = unknown>(name: string, args: unknown, id: number, key?: string) {
  return mcpCall<{
    content: Array<{ type: string; text: string }>;
    structuredContent: T;
    isError?: boolean;
  }>('tools/call', { name, arguments: args }, id, key);
}

/**
 * `getModelStats` runs with ClickHouse's server-side `use_query_cache`
 * (60s TTL, keyed on the rendered query — app, default date window, and
 * `limit`). `metrics.test.ts`'s `GET /v1/metrics/models?limit=50` shares an
 * app with this tool's `get_model_costs` calls; a `limit` distinct from that
 * file's keeps this tool off its cache entry, so this call never resolves
 * before its own fixture exists. Poll is defense-in-depth for the
 * `deduplicate_merge_projection_mode = 'rebuild'` merge lag `otel_traces`'s
 * GROUP-BY-Model projection is otherwise subject to.
 */
async function waitForModelCostsTool(model: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await toolsCall<{ data: { models: Array<{ model: string }> } }>(
      'get_model_costs',
      { limit: MODEL_COSTS_LIMIT },
      -1,
    );
    if (res.result?.structuredContent.data.models.some((m) => m.model === model)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`get_model_costs never surfaced model "${model}" within ${timeoutMs}ms`);
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

describe('POST /v1/mcp (hosted gateway)', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();
  let envName: string;
  let contextSnapshotId: string;
  const mintedKeyNames: string[] = [];

  beforeAll(async () => {
    envName = await defaultEnvironmentName(appId);
    await setTier(tenantId, 'growth');

    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_ID}','${SESSION_ID}','mcp http fixture','claude-code','${ACTOR_ID}',
        'org/repo','main','','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 2, 1, 0, 0.25, ['${MODEL_NAME}'],
        now(), 'cli'
      )
    `);
    await executeClickHouse(`
      INSERT INTO otel_traces (
        Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
        StatusCode, Type, Model, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
        TenantId, AppId, Environment, SessionId, UserId, TraceName,
        EndTime, Input, Output, UpdatedAt, IsDeleted
      ) VALUES (
        now64(3) - INTERVAL 1 HOUR, '${TRACE_ID}', '${SPAN_ID}', '', 'agent.turn',
        '1', 'GENERATION', '${MODEL_NAME}', 500, 15, 25, 40, 0.25,
        '${tenantId}', '${appId}', '${envName}', '${SESSION_ID}', '${ACTOR_ID}', 'mcp http fixture',
        now64(3), 'hello', 'world', now64(3), 0
      )
    `);
    // `otel_traces` rebuilds its GROUP-BY-Model projection only on merge
    // (`deduplicate_merge_projection_mode = 'rebuild'`) — a freshly inserted
    // part's projection isn't guaranteed to back get_model_costs' aggregation
    // until a merge runs, which a small table can defer indefinitely. Force
    // it synchronously rather than polling for an unbounded background merge.
    await executeClickHouse('OPTIMIZE TABLE otel_traces FINAL');
    await executeClickHouse(`
      INSERT INTO trace_topic_maps (TenantId, AppId, Environment, Facet, MapVersion, TopicId, Name, Description)
      VALUES ('${tenantId}', '${appId}', '${envName}', 'issues', 1, '${TOPIC_ID}', 'MCP fixture topic', 'seeded')
    `);
    await executeClickHouse(`
      INSERT INTO trace_facets (TenantId, AppId, Environment, TraceId, Facet, ItemIndex, ExtractorVersion, Summary, Status, TopicId, MapVersion)
      VALUES ('${tenantId}', '${appId}', '${envName}', 'mcp-http-facet-${RUN_ID}', 'issues', 0, 1, 'mcp fixture summary', 'ok', '${TOPIC_ID}', 1)
    `);

    // get_breakdown fixture: a RUN_ID-unique branch isolates the item this
    // tool call ranks, the same way sessions.test.ts pins repo='org/repo' to
    // stay on the shared tenant's dominant repo.
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_BREAKDOWN}','mcp-breakdown-session-${RUN_ID}','mcp breakdown fixture','claude-code','${ACTOR_ID}',
        'org/repo','${BREAKDOWN_BRANCH_KEY}','','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 3, 5, 1, 6.0, ['${MODEL_NAME}'],
        now(), 'cli'
      )
    `);
    // get_breakdown dimension=tool fixture — tenant+app scoped, not repo-scoped.
    await executeClickHouse(`
      INSERT INTO otel_traces (
        Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
        StatusCode, Type, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
        TenantId, AppId, SessionId, UserId, TraceName,
        EndTime, Input, Output, UpdatedAt, IsDeleted
      ) VALUES (
        now64(3) - INTERVAL 1 HOUR, '${TRACE_TOOL}', '${SPAN_TOOL}', '', 'agent.tool.${BREAKDOWN_TOOL_KEY}',
        '1', 'SPAN', 100, 0, 0, 0, 0,
        '${tenantId}', '${appId}', '${SESSION_ID}', '${ACTOR_ID}', 'mcp breakdown tool fixture',
        now64(3), 'call', 'result', now64(3), 0
      )
    `);
    // get_pr_outcomes fixture — UserTurnCount > 1 makes this PR "steered".
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, PrNumber, UserTurnCount, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_PR}','mcp-pr-session-${RUN_ID}','mcp pr outcomes fixture','claude-code','${ACTOR_ID}',
        'org/repo','${PR_BRANCH}',${PR_NUMBER},2,'','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 4, 2, 0, 2.75, ['${MODEL_NAME}'],
        now(), 'cli'
      )
    `);

    const admin = getSupabaseAdmin();
    const { data: snapshotRow, error: snapshotError } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        commit_sha: `mcp-http-${RUN_ID}`,
        classifier_version: 1,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (snapshotError) throw new Error(`seed context_snapshot: ${snapshotError.message}`);
    contextSnapshotId = snapshotRow!.id as string;

    // agent_session_summary/otel_traces/trace_facets inserts are async —
    // the tools below read them straight back, so this must not race the
    // ClickHouse insert queue.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId = '${TRACE_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
    // Matches get_model_costs' own query shape (FINAL + Type='GENERATION') —
    // a plain SELECT can see the row in an unmerged part before a FINAL
    // aggregation does.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces FINAL WHERE TraceId = '${TRACE_ID}' AND Type = 'GENERATION' AND Model != '' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM trace_facets WHERE TenantId = '${tenantId}' AND TopicId = '${TOPIC_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId IN ('${TRACE_BREAKDOWN}', '${TRACE_PR}') FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE TraceId = '${TRACE_TOOL}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
  }, 60_000);

  afterAll(async () => {
    await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId IN ('${TRACE_ID}', '${TRACE_BREAKDOWN}', '${TRACE_PR}')`);
    await executeClickHouse(`ALTER TABLE otel_traces DELETE WHERE TraceId IN ('${TRACE_ID}', '${TRACE_TOOL}')`);
    for (const table of ['trace_topic_maps', 'trace_facets']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TenantId = '${tenantId}' AND TopicId = '${TOPIC_ID}'`);
    }
    if (contextSnapshotId) {
      await getSupabaseAdmin().from('context_snapshot').delete().eq('id', contextSnapshotId);
    }
    if (mintedKeyNames.length > 0) {
      await getSupabaseAdmin().from('api_key').delete().in('name', mintedKeyNames).eq('app_id', appId);
    }
    await getSupabaseAdmin().from('billing').delete().eq('tenant_id', tenantId);
  });

  it('initialize returns a protocol version and server info', async () => {
    const res = await mcpCall<{ protocolVersion: string; serverInfo: { name: string } }>('initialize', {}, 1);
    expect(res.error).toBeUndefined();
    expect(typeof res.result!.protocolVersion).toBe('string');
    expect(res.result!.serverInfo.name).toBe('outerlayer-gateway');
  });

  it('tools/list returns exactly the 10 headless tools', async () => {
    const res = await mcpCall<{ tools: Array<{ name: string }> }>('tools/list', {}, 2);
    expect(res.result!.tools.map((t) => t.name).sort()).toEqual(
      [
        'compare_windows',
        'get_breakdown',
        'get_fleet_overview',
        'get_model_costs',
        'get_pr_outcomes',
        'get_session',
        'get_trends',
        'list_context_changes',
        'list_sessions',
        'list_topics',
      ].sort(),
    );
  });

  describe('tools/call — structuredContent conforms to the REST-twin output schema', () => {
    it('list_topics', async () => {
      const res = await toolsCall('list_topics', { facet: 'issues', limit: 10 }, 10);
      expect(res.error).toBeUndefined();
      expect(res.result!.isError).toBeUndefined();
      const parsed = TopicsResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as { data: { topics: Array<{ topicId: string }> } }).data;
      expect(data.topics.map((t) => t.topicId)).toContain(TOPIC_ID);
    });

    it('list_sessions', async () => {
      // Without a repo (or topic filter) the route auto-scopes to the
      // tenant's dominant repo by cost — pin the seeded fixture's repo so
      // this isn't at the mercy of whichever repo is priciest in the shared
      // test tenant.
      const res = await toolsCall('list_sessions', { limit: 25, offset: 0, repo: 'org/repo' }, 11);
      expect(res.error).toBeUndefined();
      const parsed = SessionsListResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as { data: { sessions: Array<{ traceId: string }> } }).data;
      expect(data.sessions.map((s) => s.traceId)).toContain(TRACE_ID);
    });

    it('get_session', async () => {
      const res = await toolsCall('get_session', { traceId: TRACE_ID }, 12);
      expect(res.error).toBeUndefined();
      expect(res.result!.isError).toBeUndefined();
      const parsed = SessionDetailResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as { data: { session: { traceId: string } } }).data;
      expect(data.session.traceId).toBe(TRACE_ID);
    });

    it(
      'get_model_costs',
      async () => {
        await waitForModelCostsTool(MODEL_NAME);
        const res = await toolsCall('get_model_costs', { limit: MODEL_COSTS_LIMIT }, 13);
        expect(res.error).toBeUndefined();
        const parsed = ModelStatsResponseSchema.safeParse(res.result!.structuredContent);
        expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
        const data = (res.result!.structuredContent as { data: { models: Array<{ model: string }> } }).data;
        expect(data.models.map((m) => m.model)).toContain(MODEL_NAME);
      },
      35_000,
    );

    it('get_fleet_overview', async () => {
      const res = await toolsCall('get_fleet_overview', {}, 14);
      expect(res.error).toBeUndefined();
      const parsed = FleetOverviewResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
    });

    it('list_context_changes', async () => {
      const res = await toolsCall('list_context_changes', { limit: 50 }, 15);
      expect(res.error).toBeUndefined();
      const parsed = ContextChangesResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as { data: { snapshots: Array<{ id: string }> } }).data;
      expect(data.snapshots.map((s) => s.id)).toContain(contextSnapshotId);
    });

    it('compare_windows', async () => {
      const now = new Date();
      const aFrom = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      const aTo = now.toISOString().slice(0, 10);
      const bFrom = aTo;
      const bTo = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
      const res = await toolsCall('compare_windows', { aFrom, aTo, bFrom, bTo }, 16);
      expect(res.error).toBeUndefined();
      const parsed = CompareWindowsResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
    });

    it('get_breakdown', async () => {
      const res = await toolsCall('get_breakdown', { dimension: 'branch', limit: 50 }, 17);
      expect(res.error).toBeUndefined();
      const parsed = MetricsBreakdownResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as { data: { items: Array<{ key: string; sessions: number; costUsd: number; toolErrorRate: number }> } }).data;
      const item = data.items.find((i) => i.key === BREAKDOWN_BRANCH_KEY);
      expect(item).toEqual({ key: BREAKDOWN_BRANCH_KEY, sessions: 1, costUsd: 6.0, toolErrorRate: 0.2 });
    });

    it('get_breakdown (dimension=tool) carries requests + toolErrorRate, never sessions/costUsd', async () => {
      const res = await toolsCall('get_breakdown', { dimension: 'tool', limit: 50 }, 42);
      expect(res.error).toBeUndefined();
      const parsed = MetricsBreakdownResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as {
        data: { items: Array<{ key: string; requests?: number; toolErrorRate?: number; sessions?: number; costUsd?: number }> };
      }).data;
      const item = data.items.find((i) => i.key === BREAKDOWN_TOOL_KEY);
      expect(item).toEqual({ key: BREAKDOWN_TOOL_KEY, requests: 1, toolErrorRate: 0 });
    });

    it('get_trends', async () => {
      const res = await toolsCall('get_trends', {}, 18);
      expect(res.error).toBeUndefined();
      const parsed = MetricsTrendsResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as { data: { points: Array<{ date: string; sessions: number }> } }).data;
      const todayDate = new Date().toISOString().slice(0, 10);
      expect(data.points.map((p) => p.date)).toContain(todayDate);
      const today = data.points.find((p) => p.date === todayDate)!;
      expect(today.sessions).toBeGreaterThanOrEqual(1);
    });

    it('get_pr_outcomes', async () => {
      const res = await toolsCall('get_pr_outcomes', {}, 19);
      expect(res.error).toBeUndefined();
      const parsed = PrOutcomesResponseSchema.safeParse(res.result!.structuredContent);
      expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
      const data = (res.result!.structuredContent as {
        data: { items: Array<{ repo: string; branch: string; prNumber: number; steered: boolean; costUsd: number }>; steeredPrNumbers: number[] };
      }).data;
      expect(data.steeredPrNumbers).toContain(PR_NUMBER);
      const item = data.items.find((i) => i.prNumber === PR_NUMBER);
      expect(item).toEqual({ repo: 'org/repo', branch: PR_BRANCH, prNumber: PR_NUMBER, steered: true, costUsd: 2.75 });
    });
  });

  describe('permission and entitlement denial', () => {
    let sdkKey: string;
    let readOnlyKey: string;

    beforeAll(async () => {
      const environmentId = await resolveDefaultEnvironmentId(appId);
      const sdkName = `mcp-http-sdk-${RUN_ID}`;
      const readOnlyName = `mcp-http-readonly-${RUN_ID}`;
      mintedKeyNames.push(sdkName, readOnlyName);
      [sdkKey, readOnlyKey] = await Promise.all([
        mintTestApiKey({ tenantId, appId, environmentId, permissions: getPermissionsForRole('sdk'), name: sdkName }),
        mintTestApiKey({ tenantId, appId, environmentId, permissions: getPermissionsForRole('read-only'), name: readOnlyName }),
      ]);
    }, 30_000);

    it('a key without metrics.read gets JSON-RPC app-error -32001 (permission denied) calling list_topics', async () => {
      const res = await mcpCall(
        'tools/call',
        { name: 'list_topics', arguments: { facet: 'issues', limit: 3 } },
        20,
        sdkKey,
      );
      expect(res.result).toBeUndefined();
      expect(res.error?.code).toBe(-32001);
      expect(res.error?.message).toContain('metrics.read');
    });

    it('a read-only key on a tier lacking topics_enabled gets JSON-RPC app-error -32002 (entitlement required)', async () => {
      await setTier(tenantId, 'hobby');
      try {
        const res = await mcpCall(
          'tools/call',
          { name: 'list_topics', arguments: { facet: 'issues', limit: 3 } },
          21,
          readOnlyKey,
        );
        expect(res.result).toBeUndefined();
        expect(res.error?.code).toBe(-32002);
        expect(res.error?.message).toContain('topics_enabled');
      } finally {
        await setTier(tenantId, 'growth');
      }
    });
  });

  it('a tool executor domain error (unknown trace) returns isError with the structured envelope, not a JSON-RPC InternalError', async () => {
    const res = await toolsCall('get_session', { traceId: 'f'.repeat(32) }, 30);
    // The outer JSON-RPC response is a normal result — the domain error is
    // carried inside the CallToolResult, not raised as a transport fault.
    expect(res.error).toBeUndefined();
    expect(res.result!.isError).toBe(true);
    const body = res.result!.structuredContent as { error: { code: string; message: string } };
    expect(body.error.code).toBe('trace_not_found');
  });

  it('REST GET /v1/topics and the list_topics MCP tool return the identical data for the same query', async () => {
    const restRes = await gatewayFetch('/v1/topics?facet=issues&limit=10');
    expect(restRes.status).toBe(200);
    const restBody = (await restRes.json()) as { data: unknown };

    const mcpRes = await toolsCall('list_topics', { facet: 'issues', limit: 10 }, 40);
    const mcpData = (mcpRes.result!.structuredContent as { data: unknown }).data;

    expect(mcpData).toEqual(restBody.data);
  });

  it('REST GET /v1/metrics/breakdown and the get_breakdown MCP tool return the identical data for the same query', async () => {
    const restRes = await gatewayFetch('/v1/metrics/breakdown?dimension=branch&limit=50');
    expect(restRes.status).toBe(200);
    const restBody = (await restRes.json()) as { data: unknown };

    const mcpRes = await toolsCall('get_breakdown', { dimension: 'branch', limit: 50 }, 41);
    const mcpData = (mcpRes.result!.structuredContent as { data: unknown }).data;

    expect(mcpData).toEqual(restBody.data);
  });
});
