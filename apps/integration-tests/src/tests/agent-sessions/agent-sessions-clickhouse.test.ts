/**
 * Agent-sessions tenancy on the real ClickHouse read path.
 *
 * `AgentSessionsService.listSessions`/`getSessionDetail` are driven for real
 * (real row-policy client, real `agent_session_summary`/`otel_traces` rows,
 * migration-29 tenant_isolation_sessions policy) exactly like
 * `security/clickhouse-read-path-leak.test.ts` drives `AnalyticsService`.
 * The blob route's own query (`agent_blobs`, tenant_isolation_blobs) is run
 * directly against `createTenantReadClient` — the identical function and
 * scope the canonical `/api/orgs/[orgName]/apps/[appId]/agents/blob/[sha256]`
 * route uses — since there is no live Next server in this harness to hit the
 * route itself.
 *
 * The actor-privacy permission gate (`resolveAgentSessionScope` →
 * `checkAppPermission`) is mocked to a fixed team scope here: that function
 * unconditionally builds a cookie-session-bound Supabase client
 * (`createSupabaseServerClient` → `next/headers` `cookies()`), and this
 * harness stubs only `headers()`, not `cookies()` — there is no bridge for a
 * real Supabase session here, so this file's job is CH row-policy tenant
 * isolation only. The permission layer itself is proven over the real wire
 * in `agent-sessions-permissions.acceptance.test.ts` (the `app_authorize`
 * RPC matrix); the scope seam's own branch logic is proven in
 * `apps/tenant-dashboard/src/features/agent-sessions/scope.test.ts` and
 * `service.test.ts` (the self/team split, the sentinel, and the
 * 404-no-oracle branch).
 */

import type { env as dashboardEnv } from 'tenant-dashboard/src/env';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';
import {
  CLICKHOUSE_TEST_HOST,
  CLICKHOUSE_TEST_READ_USER,
  CLICKHOUSE_TEST_READ_PASSWORD,
  executeClickHouse,
} from '../../../clickhouse/setup-clickhouse';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';

vi.mock('tenant-dashboard/src/features/agent-sessions/scope', async (importOriginal) => {
  const original = await importOriginal<typeof import('tenant-dashboard/src/features/agent-sessions/scope')>();
  return { ...original, resolveAgentSessionScope: async () => ({ kind: 'team' as const }) };
});

// Imported AFTER the vi.mock above so the service picks up the mocked scope.
const { agentSessionsService } = await import('tenant-dashboard/src/features/agent-sessions/service');
const { createTenantReadClient } = await import('tenant-dashboard/src/lib/analytics/client');
const { parseSessionsUrlParams } = await import('tenant-dashboard/src/features/agent-sessions/list-query');

// createTenantReadClient reads its ClickHouse config from tenant-dashboard's
// T3 env module, which the shared test-setup.ts mocks with
// CLICKHOUSE_HOST/READ_USER/READ_PASSWORD all undefined (no analytics config
// by default). Point it at this suite's real integration ClickHouse instead —
// the exact identity `security/clickhouse-read-path-leak.test.ts` uses. A
// full literal (not `importOriginal`): the real env module runs strict T3
// validation against process.env at import time, and this harness's env only
// satisfies the fields test-setup.ts's own mock lists.
vi.mock('tenant-dashboard/src/env', () => ({
  env: {
    SUPABASE_SECRET_KEY:
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    UNKEY_API_KEY: 'test-unkey-api-key',
    STRIPE_SECRET_KEY: 'sk_test_stripe_secret_key',
    STRIPE_SECRET_WEBHOOK_KEY: 'whsec_test_webhook_key',
    STRIPE_GROWTH_FLAT_PRICE_ID: 'price_test_growth_flat',
    STRIPE_TEAM_FLAT_PRICE_ID: 'price_test_team_flat',
    STRIPE_GROWTH_USAGE_PRICE_ID: 'price_test_growth_usage',
    STRIPE_TEAM_USAGE_PRICE_ID: 'price_test_team_usage',
    STRIPE_SPAN_METER_ID: 'meter_test_span',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----',
    GITHUB_APP_WEBHOOK_SECRET: 'test-webhook-secret',
    OAUTH_STATE_SECRET: 'test-oauth-state-secret-at-least-32-chars',
    TOKEN_ENCRYPTION_KEY: 'test-encryption-key-must-be-32-chars!',
    NODE_ENV: 'test',
    RESEND_API_KEY: undefined,
    FROM_EMAIL: undefined,
    RESEND_BROADCAST_AUDIENCE_ID: undefined,
    // The one deliberate divergence from test-setup.ts's default mock: real
    // integration ClickHouse instead of "not configured".
    CLICKHOUSE_HOST: CLICKHOUSE_TEST_HOST,
    CLICKHOUSE_READ_USER: CLICKHOUSE_TEST_READ_USER,
    CLICKHOUSE_READ_PASSWORD: CLICKHOUSE_TEST_READ_PASSWORD,
    CLICKHOUSE_PASSWORD: undefined,
    FLY_API_TOKEN: 'test-fly-api-token',
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54331',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3002',
    NEXT_PUBLIC_POSTHOG_UI_HOST: undefined,
    NEXT_PUBLIC_POSTHOG_PROJECT_ID: undefined,
  } satisfies Partial<Record<keyof typeof dashboardEnv, unknown>>,
}));

const RUN = randomBytes(4).toString('hex');

function ctx(user: SameTenantUser, tenantId: string, appId: string, db: SupabaseClient): TenantContext & { db: SupabaseClient } {
  return {
    userId: user.id,
    tenantId,
    appId: appId as VerifiedAppId,
    dataRetentionDays: -1,
    db,
  };
}

describe('agent-sessions tenancy on the real ClickHouse read path', () => {
  const admin_seedApp = async (name: string, tenantId: string, createdBy: string) => {
    const { createSupabaseAdminClient } = await import('../../lib/supabase-admin');
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.from('app').insert({ name, tenant_id: tenantId, created_by: createdBy }).select('id').single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id as string;
  };

  let orgA: SameTenantUser;
  let orgB: SameTenantUser;
  let appA: string;
  let appB: string;
  const traceA = `sess-a-${RUN}`;
  const traceB = `sess-b-${RUN}`;
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    appA = await admin_seedApp(`agent-sess-a-${RUN}`, orgA.tenantId, orgA.id);
    appB = await admin_seedApp(`agent-sess-b-${RUN}`, orgB.tenantId, orgB.id);

    await executeClickHouse(
      `INSERT INTO agent_session_summary
         (TenantId, AppId, TraceId, SessionId, Title, ActorId, StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd)
       VALUES
         ('${orgA.tenantId}', '${appA}', '${traceA}', '${traceA}-sess', 'A session', '${orgA.membershipId}', now(), now(), 3, 2, 0, 0.5),
         ('${orgB.tenantId}', '${appB}', '${traceB}', '${traceB}-sess', 'B session', '${orgB.membershipId}', now(), now(), 4, 3, 0, 0.9)`,
    );
    await executeClickHouse(
      `INSERT INTO otel_traces (Timestamp, TraceId, SpanId, SpanName, TenantId, AppId, ActorId, StatusCode)
       VALUES
         (now(), '${traceA}', '${traceA}-root', 'agent.session', '${orgA.tenantId}', '${appA}', '${orgA.membershipId}', '1'),
         (now(), '${traceB}', '${traceB}-root', 'agent.session', '${orgB.tenantId}', '${appB}', '${orgB.membershipId}', '1')`,
    );
    await executeClickHouse(
      `INSERT INTO agent_blobs (TenantId, AppId, Sha256, MediaType, Bytes, Data)
       VALUES
         ('${orgA.tenantId}', '${appA}', '${shaA}', 'image/png', 5, '${Buffer.from('hello-a').toString('base64')}'),
         ('${orgB.tenantId}', '${appB}', '${shaB}', 'image/png', 5, '${Buffer.from('hello-b').toString('base64')}')`,
    );
  }, 90000);

  afterAll(async () => {
    for (const table of ['agent_session_summary', 'otel_traces', 'agent_blobs']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TenantId IN ('${orgA.tenantId}', '${orgB.tenantId}')`);
    }
    const { createSupabaseAdminClient } = await import('../../lib/supabase-admin');
    const admin = createSupabaseAdminClient();
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id]);
    for (const user of [orgA, orgB]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  it("listSessions under tenant A returns ONLY A's session, never B's", async () => {
    const db = await createTenantScopedClient(orgA, orgA.tenantId);
    const page = await agentSessionsService.listSessions(
      ctx(orgA, orgA.tenantId, appA, db),
      parseSessionsUrlParams({}, false),
    );
    expect(page.total).toBe(1);
    expect(page.sessions.map((s) => s.traceId)).toEqual([traceA]);
  });

  it("getSessionDetail under tenant A opens A's own trace", async () => {
    const db = await createTenantScopedClient(orgA, orgA.tenantId);
    const detail = await agentSessionsService.getSessionDetail(ctx(orgA, orgA.tenantId, appA, db), traceA);
    expect(detail?.session.traceId).toBe(traceA);
  });

  it("getSessionDetail under tenant A cannot open tenant B's trace — CH row policy filters it to zero rows", async () => {
    const db = await createTenantScopedClient(orgA, orgA.tenantId);
    const detail = await agentSessionsService.getSessionDetail(ctx(orgA, orgA.tenantId, appA, db), traceB);
    expect(detail).toBeNull();
  });

  it("the tenant_isolation_blobs ROW POLICY alone denies tenant B's blob by exact hash, no WHERE-clause help", async () => {
    // No TenantId/AppId predicate here — only ClickHouse's own row policy
    // (`TenantId = getSetting('SQL_tenant_id')`, migration-29) can be doing
    // the filtering. This isolates that layer from the route's own
    // defense-in-depth WHERE clause, proven separately below.
    const chA = createTenantReadClient({ tenantId: orgA.tenantId, appId: appA });
    if (!chA) throw new Error('ClickHouse not configured');

    const rows = await chA
      .query({
        query: `SELECT MediaType AS mediaType, Data AS data FROM agent_blobs FINAL
                WHERE Sha256 = {sha256:String} LIMIT 1`,
        query_params: { sha256: shaB },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ mediaType: string; data: string }>());
    expect(rows).toEqual([]);
  });

  it("the canonical route's own query (WHERE-clause scoping under the caller's tenant ctx) returns A's bytes and never B's", async () => {
    // This exercises the route's actual query shape — the explicit
    // TenantId/AppId/Sha256 WHERE clause it runs under `ctx.tenantId`/
    // `ctx.appId` — not the row policy in isolation (that's the case above;
    // `security/clickhouse-read-path-leak.test.ts` is the suite that proves
    // the row-policy layer generally, across every scoped table).
    const chA = createTenantReadClient({ tenantId: orgA.tenantId, appId: appA });
    if (!chA) throw new Error('ClickHouse not configured');

    const ownBlob = await chA
      .query({
        query: `SELECT MediaType AS mediaType, Data AS data FROM agent_blobs FINAL
                WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND Sha256 = {sha256:String} LIMIT 1`,
        query_params: { tenantId: orgA.tenantId, appId: appA, sha256: shaA },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ mediaType: string; data: string }>());
    expect(Buffer.from(ownBlob[0]!.data, 'base64').toString()).toBe('hello-a');

    const crossTenantProbe = await chA
      .query({
        query: `SELECT MediaType AS mediaType, Data AS data FROM agent_blobs FINAL
                WHERE TenantId = {tenantId:String} AND AppId = {appId:String} AND Sha256 = {sha256:String} LIMIT 1`,
        query_params: { tenantId: orgA.tenantId, appId: appA, sha256: shaB },
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ mediaType: string; data: string }>());
    expect(crossTenantProbe).toEqual([]);
  });

  describe('listSessions — origin filter, sort, pagination, originCounts, empty state', () => {
    // A dedicated app (not appA) so this block's five-row population never
    // touches the single-session assertions above.
    let appC: string;
    const t = (n: number) => `sess-c${n}-${RUN}`;

    beforeAll(async () => {
      appC = await admin_seedApp(`agent-sess-c-${RUN}`, orgA.tenantId, orgA.id);
      // Five sessions, three origins, staggered StartedAt (oldest → newest is
      // t1..t5) and distinct CostUsd so sort order is unambiguous.
      await executeClickHouse(
        `INSERT INTO agent_session_summary
           (TenantId, AppId, TraceId, SessionId, Title, ActorId, Origin, StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd)
         VALUES
           ('${orgA.tenantId}', '${appC}', '${t(1)}', '${t(1)}-sess', 'Interactive One', '${orgA.membershipId}', 'interactive', now() - INTERVAL 5 MINUTE, now(), 1, 1, 0, 0.10),
           ('${orgA.tenantId}', '${appC}', '${t(2)}', '${t(2)}-sess', 'Interactive Two', '${orgA.membershipId}', 'interactive', now() - INTERVAL 4 MINUTE, now(), 1, 1, 0, 0.50),
           ('${orgA.tenantId}', '${appC}', '${t(3)}', '${t(3)}-sess', 'Agent One', '${orgA.membershipId}', 'agent', now() - INTERVAL 3 MINUTE, now(), 1, 1, 0, 0.20),
           ('${orgA.tenantId}', '${appC}', '${t(4)}', '${t(4)}-sess', 'Agent Two', '${orgA.membershipId}', 'agent', now() - INTERVAL 2 MINUTE, now(), 1, 1, 0, 0.80),
           ('${orgA.tenantId}', '${appC}', '${t(5)}', '${t(5)}-sess', 'Worker One', '${orgA.membershipId}', 'worker', now() - INTERVAL 1 MINUTE, now(), 1, 1, 0, 0.30)`,
      );
    }, 90000);

    afterAll(async () => {
      await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE AppId = '${appC}'`);
      const { createSupabaseAdminClient } = await import('../../lib/supabase-admin');
      await createSupabaseAdminClient().from('app').delete().eq('id', appC);
    });

    it('origin=agent returns only the two agent-origin sessions', async () => {
      const db = await createTenantScopedClient(orgA, orgA.tenantId);
      const page = await agentSessionsService.listSessions(
        ctx(orgA, orgA.tenantId, appC, db),
        parseSessionsUrlParams({ origin: 'agent', sort: 'startedAt', dir: 'asc' }, false),
      );
      expect(page.total).toBe(2);
      expect(page.sessions.map((s) => s.traceId)).toEqual([t(3), t(4)]);
    });

    it('sort=cost/dir=asc orders every origin (origin=all) by CostUsd ascending', async () => {
      const db = await createTenantScopedClient(orgA, orgA.tenantId);
      const page = await agentSessionsService.listSessions(
        ctx(orgA, orgA.tenantId, appC, db),
        parseSessionsUrlParams({ origin: 'all', sort: 'cost', dir: 'asc' }, false),
      );
      expect(page.total).toBe(5);
      // Ascending CostUsd: t1(.10) < t3(.20) < t5(.30) < t2(.50) < t4(.80).
      expect(page.sessions.map((s) => s.traceId)).toEqual([t(1), t(3), t(5), t(2), t(4)]);
    });

    it('limit/offset paginate the same (origin=all) population without dropping or duplicating rows', async () => {
      const db = await createTenantScopedClient(orgA, orgA.tenantId);
      const base = parseSessionsUrlParams({ origin: 'all', sort: 'startedAt', dir: 'asc' }, false);

      const pageOne = await agentSessionsService.listSessions(ctx(orgA, orgA.tenantId, appC, db), {
        ...base,
        limit: 2,
        offset: 0,
      });
      const pageTwo = await agentSessionsService.listSessions(ctx(orgA, orgA.tenantId, appC, db), {
        ...base,
        limit: 2,
        offset: 2,
      });
      const pageThree = await agentSessionsService.listSessions(ctx(orgA, orgA.tenantId, appC, db), {
        ...base,
        limit: 2,
        offset: 4,
      });

      // total is the FULL count regardless of limit/offset.
      expect(pageOne.total).toBe(5);
      expect(pageOne.sessions.map((s) => s.traceId)).toEqual([t(1), t(2)]);
      expect(pageTwo.sessions.map((s) => s.traceId)).toEqual([t(3), t(4)]);
      expect(pageThree.sessions.map((s) => s.traceId)).toEqual([t(5)]);
    });

    it('originCounts sums every origin over the unfiltered (origin=all) population', async () => {
      const db = await createTenantScopedClient(orgA, orgA.tenantId);
      const page = await agentSessionsService.listSessions(
        ctx(orgA, orgA.tenantId, appC, db),
        parseSessionsUrlParams({ origin: 'all' }, false),
      );
      expect(page.originCounts).toEqual({ interactive: 2, agent: 2, worker: 1 });
    });

    it('a filter matching zero sessions returns a well-shaped empty page, not an error', async () => {
      const db = await createTenantScopedClient(orgA, orgA.tenantId);
      const page = await agentSessionsService.listSessions(
        ctx(orgA, orgA.tenantId, appC, db),
        parseSessionsUrlParams({ origin: 'all', q: 'no-session-title-matches-this' }, false),
      );
      expect(page.total).toBe(0);
      expect(page.sessions).toEqual([]);
    });
  });
});
