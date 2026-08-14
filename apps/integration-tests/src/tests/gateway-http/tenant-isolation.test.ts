/**
 * Cross-TENANT behavioral isolation on the headless read surface.
 *
 * `sessions.test.ts`'s cross-app 404 test proves isolation between two apps
 * in the SAME tenant; the SQL every route emits is proven tenant-scoped by
 * regex-on-source-text assertions elsewhere. Neither exercises a second
 * tenant's API key against the first tenant's live data over the real
 * gateway HTTP boundary — this file is that behavioral backstop.
 *
 * Tenant A is the shared seeded tenant every other gateway-http file reads
 * (`getTestTenantId()`/`getTestAppId()`), carrying RUN_ID-unique fixtures
 * across every route this suite covers (sessions, topics, breakdown's tool
 * dimension, trends, PR outcomes). Tenant B is a genuinely separate
 * tenant/app/API-key, freshly minted via the same `seed-test-tenant.ts`
 * script `self-host/mcp.test.ts` uses to bootstrap an org for MCP testing —
 * every assertion below issues the request AS tenant B and checks tenant
 * A's RUN_ID markers never surface.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { getTestTenantId } from './client';
import { getTestAppId, GATEWAY_URL } from '../../../gateway-http/setup-gateway';
import { resolvePepper } from '../../lib/mint-test-key';
import { getSupabaseAdmin } from '../../lib/test-utils';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const RUN_ID = randomUUID().slice(0, 8);
const RUN_HEX = RUN_ID.replace(/-/g, '');
const RUN_NUM = parseInt(RUN_ID.slice(0, 6), 16) % 900_000;

const TRACE_A = `${RUN_HEX}a${'0'.repeat(31 - RUN_HEX.length)}`;
const SPAN_A = `${RUN_HEX}a${'0'.repeat(15 - RUN_HEX.length)}`;
const SESSION_A = `tenant-isolation-session-${RUN_ID}`;
const BRANCH_A = `tenant-isolation-branch-${RUN_ID}`;
const TOPIC_ID_A = `tenant-isolation-topic-${RUN_ID}`;
const TOOL_TRACE_A = `tenant-isolation-tool-trace-${RUN_ID}`;
const TOOL_SPAN_A = `tenant-isolation-tool-span-${RUN_ID}`;
const TOOL_KEY_A = `tenant-isolation-${RUN_ID}`;
const PR_TRACE_A = `tenant-isolation-pr-trace-${RUN_ID}`;
const PR_BRANCH_A = `tenant-isolation-pr-${RUN_ID}`;
const PR_NUMBER_A = RUN_NUM + 7;

interface SeedResult {
  appId: string;
  tenantId: string;
  apiKey: string;
}

/**
 * Mints a genuinely separate tenant + app + API key via the same script
 * `self-host/mcp.test.ts` uses — a fresh Postgres tenant/app row pair and a
 * real peppered key, with no ClickHouse rows of its own. `resolvePepper()`
 * matches whichever `.dev.vars` the already-running gateway booted with, so
 * the minted digest verifies.
 */
function seedSecondTenant(runLabel: string): SeedResult {
  const seed = spawnSync(
    'yarn',
    ['workspace', 'gateway', 'exec', 'tsx', 'scripts/seed-test-tenant.ts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SEED_ORG_NAME: `tenant-isolation-${runLabel}`,
        SEED_APP_NAME: `tenant-isolation-app-${runLabel}`,
        API_KEY_PEPPER: resolvePepper(),
      },
    },
  );
  if (seed.status !== 0) {
    throw new Error(`seed-test-tenant.ts failed (${seed.status}): ${seed.stderr}`);
  }
  const line = (prefix: string): string =>
    seed.stdout.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? '';
  const appId = line('app_id=');
  const tenantId = line('tenant_id=');
  const apiKey = line('api_key=');
  if (!/^[0-9a-f-]{36}$/i.test(appId) || !/^[0-9a-f-]{36}$/i.test(tenantId) || !apiKey) {
    throw new Error(`seed-test-tenant.ts emitted an incomplete result: ${JSON.stringify({ appId, tenantId, apiKeyPresent: !!apiKey })}`);
  }
  return { appId, tenantId, apiKey };
}

async function fetchAs(path: string, key: string, appId: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-outerlayer-app-id': appId,
      ...(init.headers as Record<string, string>),
    },
  });
}

async function mcpCallAs<T = unknown>(method: string, params: unknown, id: number, key: string, appId: string): Promise<{
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string };
}> {
  const res = await fetchAs('/v1/mcp', key, appId, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(res.status, `POST /v1/mcp (${method}) transport status`).toBe(200);
  return res.json();
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

describe('cross-tenant isolation on the headless read surface', () => {
  const tenantA = getTestTenantId();
  const appA = getTestAppId();
  let envNameA: string;
  let tenantB: SeedResult;

  beforeAll(async () => {
    envNameA = await defaultEnvironmentName(appA);
    tenantB = seedSecondTenant(RUN_ID);
    // Tenant B needs topics_enabled so its GET /v1/topics call below reaches
    // the ClickHouse read (an empty-tier 402 would prove nothing about
    // cross-tenant data isolation, only about the entitlement gate).
    await setTier(tenantB.tenantId, 'growth');

    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, PrNumber, UserTurnCount, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantA}','${appA}','${TRACE_A}','${SESSION_A}','tenant isolation fixture','claude-code','actor-${RUN_ID}',
        'org/repo','${BRANCH_A}',0,0,'','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 2, 4, 1, 9.0, ['claude-opus-4-8'],
        now(), 'cli'
      )
    `);
    await executeClickHouse(`
      INSERT INTO otel_traces (
        Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
        StatusCode, Type, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
        TenantId, AppId, Environment, SessionId, UserId, TraceName,
        EndTime, Input, Output, UpdatedAt, IsDeleted
      ) VALUES (
        now64(3) - INTERVAL 1 HOUR, '${TRACE_A}', '${SPAN_A}', '', 'agent.turn',
        '1', 'SPAN', 500, 0, 0, 0, 0,
        '${tenantA}', '${appA}', '${envNameA}', '${SESSION_A}', 'actor-${RUN_ID}', 'tenant isolation fixture',
        now64(3), 'hello', 'world', now64(3), 0
      )
    `);
    await executeClickHouse(`
      INSERT INTO trace_topic_maps (TenantId, AppId, Environment, Facet, MapVersion, TopicId, Name, Description)
      VALUES ('${tenantA}', '${appA}', '${envNameA}', 'issues', 1, '${TOPIC_ID_A}', 'Tenant isolation topic', 'seeded')
    `);
    await executeClickHouse(`
      INSERT INTO trace_facets (TenantId, AppId, Environment, TraceId, Facet, ItemIndex, ExtractorVersion, Summary, Status, TopicId, MapVersion)
      VALUES ('${tenantA}', '${appA}', '${envNameA}', 'tenant-isolation-facet-${RUN_ID}', 'issues', 0, 1, 'tenant isolation summary', 'ok', '${TOPIC_ID_A}', 1)
    `);
    await executeClickHouse(`
      INSERT INTO otel_traces (
        Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
        StatusCode, Type, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
        TenantId, AppId, SessionId, UserId, TraceName,
        EndTime, Input, Output, UpdatedAt, IsDeleted
      ) VALUES (
        now64(3) - INTERVAL 1 HOUR, '${TOOL_TRACE_A}', '${TOOL_SPAN_A}', '', 'agent.tool.${TOOL_KEY_A}',
        '1', 'SPAN', 100, 0, 0, 0, 0,
        '${tenantA}', '${appA}', '${SESSION_A}', 'actor-${RUN_ID}', 'tenant isolation tool fixture',
        now64(3), 'call', 'result', now64(3), 0
      )
    `);
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, PrNumber, UserTurnCount, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantA}','${appA}','${PR_TRACE_A}','tenant-isolation-pr-session-${RUN_ID}','tenant isolation pr fixture','claude-code','actor-${RUN_ID}',
        'org/repo','${PR_BRANCH_A}',${PR_NUMBER_A},2,'','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 3, 2, 0, 5.5, ['claude-opus-4-8'],
        now(), 'cli'
      )
    `);

    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId IN ('${TRACE_A}', '${PR_TRACE_A}') FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM otel_traces WHERE TraceId IN ('${TRACE_A}', '${TOOL_TRACE_A}') FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM trace_facets WHERE TenantId = '${tenantA}' AND TopicId = '${TOPIC_ID_A}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
  }, 90_000);

  afterAll(async () => {
    await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId IN ('${TRACE_A}', '${PR_TRACE_A}')`);
    await executeClickHouse(`ALTER TABLE otel_traces DELETE WHERE TraceId IN ('${TRACE_A}', '${TOOL_TRACE_A}')`);
    for (const table of ['trace_topic_maps', 'trace_facets']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TenantId = '${tenantA}' AND TopicId = '${TOPIC_ID_A}'`);
    }
    await getSupabaseAdmin().from('billing').delete().eq('tenant_id', tenantB.tenantId);
    const admin = getSupabaseAdmin();
    await admin.from('api_key').delete().eq('tenant_id', tenantB.tenantId);
    await admin.from('environment').delete().eq('tenant_id', tenantB.tenantId);
    await admin.from('app').delete().eq('tenant_id', tenantB.tenantId);
    await admin.from('tenant').delete().eq('tenant_id', tenantB.tenantId);
  });

  it('GET /v1/sessions as tenant B returns no sessions and never surfaces tenant A\'s trace/session ids', async () => {
    const res = await fetchAs('/v1/sessions?limit=50', tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sessions: Array<{ traceId: string; sessionId: string }>; total: number } };
    expect(body.data.sessions).toEqual([]);
    expect(body.data.total).toBe(0);
    expect(body.data.sessions.map((s) => s.traceId)).not.toContain(TRACE_A);
  });

  it('GET /v1/sessions/{traceId} as tenant B 404s on tenant A\'s trace id — same shape as an unknown trace', async () => {
    const res = await fetchAs(`/v1/sessions/${TRACE_A}`, tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('trace_not_found');
  });

  it('GET /v1/topics as tenant B returns no topics and never surfaces tenant A\'s topic id', async () => {
    const res = await fetchAs('/v1/topics?facet=issues&limit=50', tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { mapVersion: number; topics: Array<{ topicId: string }> } };
    expect(body.data.mapVersion).toBe(0);
    expect(body.data.topics).toEqual([]);
    expect(body.data.topics.map((t) => t.topicId)).not.toContain(TOPIC_ID_A);
  });

  it('GET /v1/metrics/breakdown?dimension=tool as tenant B never surfaces tenant A\'s tool', async () => {
    const res = await fetchAs('/v1/metrics/breakdown?dimension=tool&limit=50', tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ key: string }> } };
    expect(body.data.items).toEqual([]);
    expect(body.data.items.map((i) => i.key)).not.toContain(TOOL_KEY_A);
  });

  it('GET /v1/metrics/trends as tenant B returns no points and never surfaces tenant A\'s cost', async () => {
    const res = await fetchAs('/v1/metrics/trends', tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { points: Array<{ date: string; costUsd: number }> } };
    expect(body.data.points).toEqual([]);
  });

  it('GET /v1/prs/outcomes as tenant B returns no attribution and never surfaces tenant A\'s branch/PR', async () => {
    const res = await fetchAs('/v1/prs/outcomes', tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { branches: string[]; prNumbers: number[]; steeredPrNumbers: number[]; items: unknown[] };
    };
    expect(body.data).toEqual({ branches: [], prNumbers: [], steeredPrNumbers: [], items: [] });
    expect(body.data.branches).not.toContain(PR_BRANCH_A);
    expect(body.data.prNumbers).not.toContain(PR_NUMBER_A);
  });

  it('MCP get_session as tenant B on tenant A\'s trace id returns isError trace_not_found, not the transcript', async () => {
    const res = await mcpCallAs<{ structuredContent: { error?: { code: string } }; isError?: boolean }>(
      'tools/call',
      { name: 'get_session', arguments: { traceId: TRACE_A } },
      1,
      tenantB.apiKey,
      tenantB.appId,
    );
    expect(res.error).toBeUndefined();
    expect(res.result!.isError).toBe(true);
    expect(res.result!.structuredContent.error?.code).toBe('trace_not_found');
  });

  // Sanity check that the seeded key really can reach the read surface at
  // all — otherwise every "empty" assertion above would trivially pass for
  // the wrong reason (a denied/broken key, not real tenant isolation).
  // Every "empty" assertion above would trivially pass for the wrong reason
  // (a denied/broken key) if tenant B's key couldn't reach the read surface
  // at all — pin that it authenticates and is bound to tenant B, not A.
  it('sanity: tenant B\'s key authenticates and is bound to tenant B\'s own app id', async () => {
    const res = await fetchAs('/v1/api-keys?limit=10', tenantB.apiKey, tenantB.appId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    // The seed script mints exactly one key (`ci-seed-key`) for the fresh app.
    expect(body.data).toHaveLength(1);
  });
});
