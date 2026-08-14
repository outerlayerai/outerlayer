/**
 * `GET /v1/sessions` actor-name resolution for an API-key caller holding
 * `agents.sessions.team.read`: a session's `ActorId` is a real
 * `membership.id`, and the resolver reads `membership`/`profile` under the
 * `gateway` Postgres role to turn it into a display name.
 *
 * That read depends on `GRANT EXECUTE ON FUNCTION private.authorize TO
 * gateway` (95-gateway-rls.sql) — the legacy "Users can read
 * memberships"/"Users can read profiles" policies (12-rbac.sql) carry no TO
 * clause, so PUBLIC, so the gateway role inherits their OR-arm that calls
 * `private.authorize()`. Without the EXECUTE grant that arm errors (42501)
 * instead of evaluating to false, and `buildActorNameResolver`
 * (packages/gateway-core/src/openapi/routes/sessions.ts) swallows the error
 * and degrades to an empty name map — this test pins the resolved-name
 * behavior so that regression surfaces here instead of silently in
 * production.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPermissionsForRole } from 'tenant-dashboard/src/lib/gateway-permissions';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { gatewayFetch, getTestTenantId, mintTestApiKey } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';
import { resolveDefaultEnvironmentId } from '../../lib/environment-test-utils';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);
const RUN_HEX = RUN_ID.replace(/-/g, '');
const TRACE_ID = `${RUN_HEX}n${'0'.repeat(31 - RUN_HEX.length)}`;
const SPAN_ID = `${RUN_HEX}n${'0'.repeat(15 - RUN_HEX.length)}`;
const SESSION_ID = `actor-name-${RUN_ID}`;

describe('GET /v1/sessions resolves actor names for a team-read API key', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();
  const admin = getSupabaseAdmin();

  let userId: string;
  let membershipId: string;
  let teamReadKey: string;
  const mintedKeyNames: string[] = [];
  const profileName = `Actor Name Fixture ${RUN_ID}`;

  beforeAll(async () => {
    const email = `actor-name-${RUN_ID}@test-gateway-http.com`;
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password: 'TestPassword123!',
      email_confirm: true,
    });
    if (authError || !authData?.user) throw new Error(`auth user create: ${authError?.message}`);
    userId = authData.user.id;

    const { error: profileError } = await admin.from('profile').insert({
      id: userId,
      name: profileName,
      email,
    });
    if (profileError) throw new Error(`profile create: ${profileError.message}`);

    const { data: membership, error: membershipError } = await admin
      .from('membership')
      .insert({ user_id: userId, tenant_id: tenantId, role: 'read', status: 'active' })
      .select('id')
      .single();
    if (membershipError) throw new Error(`membership create: ${membershipError.message}`);
    membershipId = membership.id;

    await executeClickHouse(`
      INSERT INTO agent_session_summary (
        TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
        GitRepo, GitBranch, CommitSha, CaptureTier,
        StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
        InsertedAt, Origin
      ) VALUES (
        '${tenantId}','${appId}','${TRACE_ID}','${SESSION_ID}','actor name fixture','claude-code','${membershipId}',
        'org/repo','main','','full',
        now64(3) - INTERVAL 1 HOUR, now64(3), 1, 0, 0, 0.1, ['claude-opus-4-8'],
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
        now64(3) - INTERVAL 1 HOUR, '${TRACE_ID}', '${SPAN_ID}', '', 'agent.turn',
        '1', 'SPAN', 'claude-opus-4-8', 1000, 10, 20, 30, 0.1,
        '${tenantId}', '${appId}', '${SESSION_ID}', '${membershipId}', 'actor name fixture',
        now64(3), 'hello', 'world', now64(3), 0
      )
    `);

    const environmentId = await resolveDefaultEnvironmentId(appId);
    const name = `actor-name-team-read-${RUN_ID}`;
    mintedKeyNames.push(name);
    teamReadKey = await mintTestApiKey({
      tenantId,
      appId,
      environmentId,
      permissions: getPermissionsForRole('full-access'),
      name,
    });

    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId = '${TRACE_ID}' FORMAT JSONEachRow`,
      (rows) => rows.length > 0 && Number(rows[0].n) >= 1,
    );
  }, 60_000);

  afterAll(async () => {
    for (const table of ['agent_session_summary', 'otel_traces']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TraceId = '${TRACE_ID}'`);
    }
    if (mintedKeyNames.length > 0) {
      await admin.from('api_key').delete().in('name', mintedKeyNames).eq('app_id', appId);
    }
    if (membershipId) await admin.from('membership').delete().eq('id', membershipId);
    if (userId) {
      await admin.from('profile').delete().eq('id', userId);
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
  });

  it('resolves the seeded profile name for the session actor, not the raw membership id', async () => {
    const res = await gatewayFetch(
      `/v1/sessions?limit=25&offset=0&repo=${encodeURIComponent('org/repo')}&q=${encodeURIComponent('actor name fixture')}`,
      { headers: { authorization: `Bearer ${teamReadKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { actorNames: Record<string, string> } };

    const resolvedName = body.data.actorNames[membershipId];
    expect(resolvedName).toBe(profileName);
    expect(resolvedName).not.toBe(membershipId);
    expect(resolvedName).not.toBe('anonymous');
  });
});
