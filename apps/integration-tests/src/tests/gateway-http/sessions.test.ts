/**
 * HTTP-level coverage for `GET /v1/sessions` and `GET /v1/sessions/{traceId}`:
 * topic-scoped filtering, pagination, the actor-filter 400 boundary for a
 * key without `agents.sessions.team.read`, a real trace's full span tree,
 * and the cross-app/unknown-trace 404 (same shape either way).
 *
 * Session rows are seeded the same way `preset-permissions.acceptance.test.ts`
 * seeds them (`agent_session_summary` + `otel_traces`, `SpanName LIKE
 * 'agent.%'` so the detail query's span-tree filter finds them); the topic
 * link reuses the `trace_topic_maps`/`trace_facets` seed from `topics.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionsListResponseSchema, SessionDetailResponseSchema } from '@repo/api-schemas';
import { getPermissionsForRole } from 'tenant-dashboard/src/lib/gateway-permissions';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId, mintTestApiKey } from './client';
import { getTestAppId, GATEWAY_URL } from '../../../gateway-http/setup-gateway';
import { resolveDefaultEnvironmentId } from '../../lib/environment-test-utils';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);
const RUN_HEX = RUN_ID.replace(/-/g, '');

const TRACE_A = `${RUN_HEX}a${'0'.repeat(31 - RUN_HEX.length)}`;
const SPAN_A = `${RUN_HEX}a${'0'.repeat(15 - RUN_HEX.length)}`;
const SESSION_A = `sessions-http-a-${RUN_ID}`;

const TRACE_B = `${RUN_HEX}b${'0'.repeat(31 - RUN_HEX.length)}`;
const SPAN_B = `${RUN_HEX}b${'0'.repeat(15 - RUN_HEX.length)}`;
const SESSION_B = `sessions-http-b-${RUN_ID}`;

const TOPIC_ID = `sessions-topic-${RUN_ID}`;
const ACTOR_ID = `actor-${RUN_ID}`;

async function chFetch(path: string, key: string): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-outerlayer-app-id': getTestAppId(),
    },
  });
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

async function seedSession(
  tenantId: string,
  appId: string,
  traceId: string,
  spanId: string,
  sessionId: string,
): Promise<void> {
  await executeClickHouse(`
    INSERT INTO agent_session_summary (
      TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
      GitRepo, GitBranch, CommitSha, CaptureTier,
      StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
      InsertedAt, Origin
    ) VALUES (
      '${tenantId}','${appId}','${traceId}','${sessionId}','sessions http fixture','claude-code','${ACTOR_ID}',
      'org/repo','main','','full',
      now64(3) - INTERVAL 1 HOUR, now64(3), 2, 1, 0, 0.25, ['claude-opus-4-8'],
      now(), 'cli'
    )
  `);
  await executeClickHouse(`
    INSERT INTO otel_traces (
      Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      StatusCode, Type, Model, Duration, InputTokens, OutputTokens, TotalTokens, Cost,
      TenantId, AppId, SessionId, UserId, TraceName,
      EndTime, Input, Output, UpdatedAt, IsDeleted
    ) VALUES (
      now64(3) - INTERVAL 1 HOUR, '${traceId}', '${spanId}', '', 'agent.turn',
      '1', 'SPAN', 'claude-opus-4-8', 1000, 10, 20, 30, 0.25,
      '${tenantId}', '${appId}', '${sessionId}', '${ACTOR_ID}', 'sessions http fixture',
      now64(3), 'hello', 'world', now64(3), 0
    )
  `);
}

describe('GET /v1/sessions and GET /v1/sessions/{traceId}', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();
  let envName: string;
  let readOnlyKey: string;
  const mintedKeyNames: string[] = [];

  beforeAll(async () => {
    envName = await defaultEnvironmentName(appId);
    await seedSession(tenantId, appId, TRACE_A, SPAN_A, SESSION_A);
    await seedSession(tenantId, appId, TRACE_B, SPAN_B, SESSION_B);

    await executeClickHouse(`
      INSERT INTO trace_topic_maps (TenantId, AppId, Environment, Facet, MapVersion, TopicId, Name, Description)
      VALUES ('${tenantId}', '${appId}', '${envName}', 'issues', 1, '${TOPIC_ID}', 'Sessions filter topic', 'seeded')
    `);
    await executeClickHouse(`
      INSERT INTO trace_facets (TenantId, AppId, Environment, TraceId, Facet, ItemIndex, ExtractorVersion, Summary, Status, TopicId, MapVersion)
      VALUES ('${tenantId}', '${appId}', '${envName}', '${TRACE_A}', 'issues', 0, 1, 'trace A matched', 'ok', '${TOPIC_ID}', 1)
    `);

    const environmentId = await resolveDefaultEnvironmentId(appId);
    const name = `sessions-http-readonly-${RUN_ID}`;
    mintedKeyNames.push(name);
    readOnlyKey = await mintTestApiKey({
      tenantId,
      appId,
      environmentId,
      permissions: getPermissionsForRole('read-only'),
      name,
    });

    // agent_session_summary/otel_traces inserts are async — the sessions
    // route reads them straight back, so tests must not race the ClickHouse
    // insert queue.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId IN ('${TRACE_A}', '${TRACE_B}') FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 2,
    );
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM trace_facets WHERE TenantId = '${tenantId}' AND TopicId = '${TOPIC_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
  }, 60_000);

  afterAll(async () => {
    for (const table of ['agent_session_summary', 'otel_traces']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TraceId IN ('${TRACE_A}', '${TRACE_B}')`);
    }
    for (const table of ['trace_topic_maps', 'trace_facets']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TenantId = '${tenantId}' AND TopicId = '${TOPIC_ID}'`);
    }
    if (mintedKeyNames.length > 0) {
      await getSupabaseAdmin().from('api_key').delete().in('name', mintedKeyNames).eq('app_id', appId);
    }
  });

  it('lists both seeded sessions and conforms to SessionsListResponseSchema', async () => {
    // Without an explicit repo (or a topic filter), the route auto-scopes to
    // the tenant's dominant repo by cost — pin it explicitly so this assertion
    // is about the seeded rows, not which repo happens to be most expensive
    // in the shared test tenant.
    const res = await gatewayFetch(
      `/v1/sessions?limit=25&offset=0&repo=${encodeURIComponent('org/repo')}&q=${encodeURIComponent('sessions http fixture')}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = SessionsListResponseSchema.safeParse(body);
    expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

    const traceIds = (body as { data: { sessions: Array<{ traceId: string }> } }).data.sessions.map((s) => s.traceId);
    expect(traceIds).toEqual(expect.arrayContaining([TRACE_A, TRACE_B]));
  });

  it('topicId + topicFacet narrows the list to only the matching session', async () => {
    const res = await gatewayFetch(`/v1/sessions?topicId=${TOPIC_ID}&topicFacet=issues&limit=25`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sessions: Array<{ traceId: string }> } };
    const traceIds = body.data.sessions.map((s) => s.traceId);
    expect(traceIds).toContain(TRACE_A);
    expect(traceIds).not.toContain(TRACE_B);
  });

  it('limit + offset paginate deterministically over the seeded rows', async () => {
    const q = encodeURIComponent('sessions http fixture');
    const repo = encodeURIComponent('org/repo');
    const page1 = await gatewayFetch(`/v1/sessions?repo=${repo}&q=${q}&limit=1&offset=0&sort=startedAt&dir=desc`);
    const page2 = await gatewayFetch(`/v1/sessions?repo=${repo}&q=${q}&limit=1&offset=1&sort=startedAt&dir=desc`);
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    const body1 = (await page1.json()) as { data: { sessions: Array<{ traceId: string }> } };
    const body2 = (await page2.json()) as { data: { sessions: Array<{ traceId: string }> } };
    expect(body1.data.sessions).toHaveLength(1);
    expect(body2.data.sessions).toHaveLength(1);
    expect(body1.data.sessions[0]!.traceId).not.toBe(body2.data.sessions[0]!.traceId);
  });

  it('rejects an actor filter with 400 for a key lacking agents.sessions.team.read', async () => {
    const permissions = getPermissionsForRole('read-only');
    expect(permissions).not.toContain('agents.sessions.team.read');

    const res = await chFetch(`/v1/sessions?actor=${ACTOR_ID}&limit=5`, readOnlyKey);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('returns the full span tree for a real trace, matching SessionDetailResponseSchema', async () => {
    const res = await gatewayFetch(`/v1/sessions/${TRACE_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = SessionDetailResponseSchema.safeParse(body);
    expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

    const detail = (body as { data: { session: { traceId: string }; spans: Array<{ spanId: string }> } }).data;
    expect(detail.session.traceId).toBe(TRACE_A);
    expect(detail.spans.map((s) => s.spanId)).toContain(SPAN_A);
  });

  it('returns the identical 404 shape for an unknown trace id and a cross-app trace id', async () => {
    const unknownRes = await gatewayFetch(`/v1/sessions/${'f'.repeat(32)}`);
    expect(unknownRes.status).toBe(404);
    const unknownBody = (await unknownRes.json()) as { error: { code: string; message: string } };
    expect(unknownBody.error.code).toBe('trace_not_found');

    // A real trace, but seeded under an app id the current caller isn't bound
    // to: same 404 shape, no existence oracle for a transcript outside the app.
    const foreignAppId = randomUUID();
    const crossAppTrace = `${RUN_HEX}c${'0'.repeat(31 - RUN_HEX.length)}`;
    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${foreignAppId}','${crossAppTrace}','cross-app-${RUN_ID}','cross-app fixture','claude-code','${ACTOR_ID}',
        'org/repo','main','','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 1, 0, 0, 0, ['claude-opus-4-8'],
        now(), 'cli'
      )
    `);
    try {
      const crossAppRes = await gatewayFetch(`/v1/sessions/${crossAppTrace}`);
      expect(crossAppRes.status).toBe(404);
      const crossAppBody = (await crossAppRes.json()) as { error: { code: string } };
      expect(crossAppBody.error.code).toBe(unknownBody.error.code);
    } finally {
      await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId = '${crossAppTrace}'`);
    }
  });
});
