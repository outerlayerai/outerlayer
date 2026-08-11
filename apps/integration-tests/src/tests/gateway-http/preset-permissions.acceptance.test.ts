/**
 * Preset-role authorization on the headless read surface.
 *
 * The five read endpoints are reachable with an API key, so the preset a user
 * picks in the key-creation UI is the whole authorization story for them. Two
 * presets bracket the surface: `sdk` (ingest-only — `trace.write`/`score.write`)
 * must be refused everywhere, and `read-only` must succeed everywhere. The
 * failure this pins is a route registered without a `requiredPermission`, or
 * with the wrong one: an ingest-only CLI key that can read every transcript in
 * the tenant is a silent data-exposure bug, and a `read-only` key that 403s on
 * a read endpoint is a shipped-broken preset.
 *
 * Permission lists are read from `GATEWAY_ROLES` (via `getPermissionsForRole`)
 * rather than copied, so widening a preset in the dashboard's UI constants
 * moves this test with it instead of leaving it asserting a stale grant set.
 *
 * Each endpoint's expected `required_permission` is asserted, not just the
 * status: that pins WHICH permission each route demands, so re-pointing the
 * sessions routes at `metrics.read` (making them reachable by a metrics-only
 * key) fails here rather than passing a bare `403`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getPermissionsForRole } from 'tenant-dashboard/src/lib/gateway-permissions';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { GATEWAY_URL, getTestAppId } from '../../../gateway-http/setup-gateway';
import { mintTestApiKey, getTestTenantId } from './client';
import { resolveDefaultEnvironmentId } from '../../lib/environment-test-utils';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);
// ClickHouse TraceId/SpanId columns are plain Strings here, but the seeded id
// is kept hex-shaped and run-prefixed so the afterAll DELETE can target exactly
// this run's rows without touching a parallel suite's.
const RUN_HEX = RUN_ID.replace(/-/g, '');
const TRACE_ID = `${RUN_HEX}${'0'.repeat(32 - RUN_HEX.length)}`;
const SPAN_ID = `${RUN_HEX}${'0'.repeat(16 - RUN_HEX.length)}`;
const SESSION_ID = `preset-perms-${RUN_ID}`;

/** The five endpoints this feature adds, with the permission each demands. */
const READ_ENDPOINTS = [
  { path: '/v1/topics?facet=issues&limit=3', permission: 'metrics.read' },
  { path: '/v1/sessions?limit=5', permission: 'session.read' },
  { path: `/v1/sessions/${TRACE_ID}`, permission: 'session.read' },
  { path: '/v1/metrics/models', permission: 'metrics.read' },
  { path: '/v1/metrics/overview', permission: 'metrics.read' },
] as const;

const mintedKeyNames: string[] = [];
/** Set when this suite inserted the billing row, so cleanup only removes its own. */
let insertedBillingRow = false;

/**
 * `/v1/topics` sits behind the `topics_enabled` entitlement, which the default
 * `hobby` tier withholds — a tenant on hobby 402s there regardless of the key's
 * permissions. Put the seeded tenant on a tier that includes it so the
 * read-only half below measures AUTHORIZATION rather than billing tier.
 */
async function ensureTopicsEntitledTier(tenantId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: existing } = await admin
    .from('billing')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (existing) {
    await admin.from('billing').update({ tier_id: 'growth' }).eq('tenant_id', tenantId);
    return;
  }
  const { error } = await admin.from('billing').insert({ tenant_id: tenantId, tier_id: 'growth' });
  if (error) throw new Error(`billing seed failed: ${error.message}`);
  insertedBillingRow = true;
}

async function mintPresetKey(roleId: 'sdk' | 'read-only', environmentId: string): Promise<string> {
  const permissions = getPermissionsForRole(roleId);
  // A preset that silently lost its grants would make the 403 half of this
  // suite pass for the wrong reason (no permissions at all rather than the
  // ingest-only set), so assert the preset is non-empty at mint time.
  expect(permissions.length, `${roleId} preset resolved to no permissions`).toBeGreaterThan(0);
  const name = `preset-perms-${roleId}-${RUN_ID}`;
  mintedKeyNames.push(name);
  return mintTestApiKey({
    tenantId: getTestTenantId(),
    appId: getTestAppId(),
    environmentId,
    permissions,
    name,
  });
}

async function callWithKey(path: string, key: string): Promise<Response> {
  return fetch(`${GATEWAY_URL}${path}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'x-outerlayer-app-id': getTestAppId(),
    },
  });
}

/**
 * One real session for the seeded app, so `GET /v1/sessions/{traceId}` can
 * return a 200 for the allowed preset. Without a row the read-only half would
 * assert a 404 and stop distinguishing "authorized" from "route missing".
 *
 * The span name must live under the `agent.` prefix — the session-detail query
 * filters `SpanName LIKE 'agent.%'`, so a differently-named span seeds a
 * summary the detail endpoint then reports as not found.
 */
async function seedSession(tenantId: string, appId: string): Promise<void> {
  await executeClickHouse(`
    INSERT INTO agent_session_summary (
      TenantId, AppId, TraceId, SessionId, Title, AgentType, ActorId,
      GitRepo, GitBranch, CommitSha, CaptureTier,
      StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd, Models,
      InsertedAt, Origin
    ) VALUES (
      '${tenantId}','${appId}','${TRACE_ID}','${SESSION_ID}','preset perms fixture','claude-code','actor-${RUN_ID}',
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
      now64(3) - INTERVAL 1 HOUR, '${TRACE_ID}', '${SPAN_ID}', '', 'agent.turn',
      '1', 'SPAN', 'claude-opus-4-8', 1000, 10, 20, 30, 0.25,
      '${tenantId}', '${appId}', '${SESSION_ID}', 'actor-${RUN_ID}', 'preset perms fixture',
      now64(3), 'hello', 'world', now64(3), 0
    )
  `);
}

describe('API-key preset authorization on the headless read endpoints', () => {
  let sdkKey: string;
  let readOnlyKey: string;

  beforeAll(async () => {
    await ensureTopicsEntitledTier(getTestTenantId());
    const environmentId = await resolveDefaultEnvironmentId(getTestAppId());
    [sdkKey, readOnlyKey] = await Promise.all([
      mintPresetKey('sdk', environmentId),
      mintPresetKey('read-only', environmentId),
    ]);
    await seedSession(getTestTenantId(), getTestAppId());
  }, 60_000);

  afterAll(async () => {
    if (mintedKeyNames.length > 0) {
      await getSupabaseAdmin()
        .from('api_key')
        .delete()
        .in('name', mintedKeyNames)
        .eq('app_id', getTestAppId());
    }
    if (insertedBillingRow) {
      await getSupabaseAdmin().from('billing').delete().eq('tenant_id', getTestTenantId());
    }
    await executeClickHouse(
      `ALTER TABLE agent_session_summary DELETE WHERE TraceId = '${TRACE_ID}'`,
    );
    await executeClickHouse(`ALTER TABLE otel_traces DELETE WHERE TraceId = '${TRACE_ID}'`);
  });

  // proves AC-052-09
  it('refuses an sdk-preset key with a structured 403 on every read endpoint, and admits a read-only-preset key to all of them', async () => {
    // The sdk preset must not carry either read permission, or the 403 half
    // below would be asserting the wrong thing.
    const sdkPermissions = getPermissionsForRole('sdk');
    expect(sdkPermissions).not.toContain('metrics.read');
    expect(sdkPermissions).not.toContain('session.read');

    for (const { path, permission } of READ_ENDPOINTS) {
      const denied = await callWithKey(path, sdkKey);
      expect(denied.status, `sdk key should be forbidden on ${path}`).toBe(403);
      const body = (await denied.json()) as {
        error?: { code?: string; message?: string; required_permission?: string };
      };
      expect(body.error?.code, `${path} 403 should be structured`).toBe('forbidden');
      expect(body.error?.required_permission, `${path} should demand ${permission}`).toBe(
        permission,
      );
      expect(body.error?.message).toContain(permission);
    }

    for (const { path } of READ_ENDPOINTS) {
      const allowed = await callWithKey(path, readOnlyKey);
      expect(
        allowed.status,
        `read-only key should be admitted on ${path} (body: ${await allowed.clone().text()})`,
      ).toBe(200);
      // A 200 that carries an error envelope instead of a payload would mean
      // the route authorized but failed — `data` is the contract every one of
      // these endpoints returns.
      const body = (await allowed.json()) as { data?: unknown };
      expect(body.data, `${path} should return a data payload`).toBeDefined();
    }
  });
});
