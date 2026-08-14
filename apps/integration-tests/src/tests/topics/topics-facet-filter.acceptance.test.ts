/**
 * Topic facet drill-down on the real ClickHouse read path.
 *
 * The Topics view's "click a topic row" drill-down carries `topicId`/
 * `topicFacet` onto the sessions list (`Topics` component's row click, see
 * `apps/tenant-dashboard/src/features/topics/components/__tests__/topics.test.tsx`),
 * and `AgentSessionsService.listSessions` is the server seam that turns those
 * params into a `trace_facets` filter (`service.ts`'s `topicActive` branch).
 * Driven here for real — real row-policy client, real `trace_facets`/
 * `trace_topic_maps`/`agent_session_summary` rows — the same identity and env
 * mock `agent-sessions-clickhouse.test.ts` uses.
 */

import type { env as dashboardEnv } from 'tenant-dashboard/src/env';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';
import { CLICKHOUSE_TEST_HOST, CLICKHOUSE_TEST_READ_USER, CLICKHOUSE_TEST_READ_PASSWORD, executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';

vi.mock('tenant-dashboard/src/features/agent-sessions/scope', async (importOriginal) => {
  const original = await importOriginal<typeof import('tenant-dashboard/src/features/agent-sessions/scope')>();
  return { ...original, resolveAgentSessionScope: async () => ({ kind: 'team' as const }) };
});

// Imported AFTER the vi.mock above so the service picks up the mocked scope.
const { agentSessionsService } = await import('tenant-dashboard/src/features/agent-sessions/service');
const { parseSessionsUrlParams } = await import('tenant-dashboard/src/features/agent-sessions/list-query');

// See agent-sessions-clickhouse.test.ts for why this full literal is needed:
// createTenantReadClient reads ClickHouse config from tenant-dashboard's T3
// env module, which test-setup.ts mocks to "not configured" by default.
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
const ENV_NAME = 'dev';

function ctx(user: SameTenantUser, tenantId: string, appId: string, db: SupabaseClient): TenantContext & { db: SupabaseClient } {
  return {
    userId: user.id,
    tenantId,
    appId: appId as VerifiedAppId,
    dataRetentionDays: -1,
    db,
  };
}

describe('topic drill-down filters the sessions list to that topic + facet, over the real ClickHouse read path', () => {
  let org: SameTenantUser;
  let appId: string;
  const refundIds = [`refund-${RUN}-1`, `refund-${RUN}-2`];
  const loginId = `login-${RUN}-1`;
  const unassignedId = `unassigned-${RUN}-1`;

  beforeAll(async () => {
    org = await createTenantWithOwner();
    const { createSupabaseAdminClient } = await import('../../lib/supabase-admin');
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from('app')
      .insert({ name: `topics-facet-filter-${RUN}`, tenant_id: org.tenantId, created_by: org.id })
      .select('id')
      .single();
    if (error) throw new Error(`seed app: ${error.message}`);
    appId = data!.id as string;

    // Two topics on the 'task' facet's active map version, plus one trace
    // with no facet row at all.
    await executeClickHouse(`
      INSERT INTO trace_topic_maps (TenantId, AppId, Environment, Facet, MapVersion, TopicId, Name, Description)
      VALUES
        ('${org.tenantId}', '${appId}', '${ENV_NAME}', 'task', 1, 'topic-refund-${RUN}', 'Refund Requests', 'seeded'),
        ('${org.tenantId}', '${appId}', '${ENV_NAME}', 'task', 1, 'topic-login-${RUN}', 'Login Problems', 'seeded')
    `);
    await executeClickHouse(`
      INSERT INTO trace_facets (TenantId, AppId, Environment, TraceId, Facet, ItemIndex, ExtractorVersion, Summary, Status, TopicId, MapVersion)
      VALUES
        ('${org.tenantId}', '${appId}', '${ENV_NAME}', '${refundIds[0]}', 'task', 0, 1, 'refund one', 'ok', 'topic-refund-${RUN}', 1),
        ('${org.tenantId}', '${appId}', '${ENV_NAME}', '${refundIds[1]}', 'task', 0, 1, 'refund two', 'ok', 'topic-refund-${RUN}', 1),
        ('${org.tenantId}', '${appId}', '${ENV_NAME}', '${loginId}', 'task', 0, 1, 'login one', 'ok', 'topic-login-${RUN}', 1)
    `);
    // Every trace needs a root session row for listSessions to return it —
    // origin default ('') satisfies the task facet's non-agent-origin guard.
    const traces = [...refundIds, loginId, unassignedId];
    const values = traces
      .map(
        (id, i) =>
          `('${org.tenantId}', '${appId}', '${id}', '${id}-sess', 'Session ${i}', '${org.membershipId}', now() - INTERVAL ${traces.length - i} MINUTE, now(), 1, 1, 0, 0.1)`,
      )
      .join(',\n        ');
    await executeClickHouse(`
      INSERT INTO agent_session_summary
        (TenantId, AppId, TraceId, SessionId, Title, ActorId, StartedAt, EndedAt, TurnCount, ToolCallCount, ErrorCount, CostUsd)
      VALUES
        ${values}
    `);
  }, 90000);

  afterAll(async () => {
    for (const table of ['trace_topic_maps', 'trace_facets', 'agent_session_summary']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TenantId = '${org.tenantId}'`);
    }
    const { createSupabaseAdminClient } = await import('../../lib/supabase-admin');
    const admin = createSupabaseAdminClient();
    await admin.from('app').delete().eq('id', appId);
    await admin.from('membership').delete().eq('user_id', org.id);
    await admin.from('profile').delete().eq('id', org.id);
    try {
      await admin.auth.admin.deleteUser(org.id);
    } catch {
      // best-effort; a leaked auth user does not affect other suites
    }
    await admin.from('tenant').delete().eq('tenant_id', org.tenantId);
  });

  // proves AC-056-02
  it('returns only the traces assigned to the drilled-down topic, never the other topic or the unassigned trace', async () => {
    const db = await createTenantScopedClient(org, org.tenantId);
    const page = await agentSessionsService.listSessions(
      ctx(org, org.tenantId, appId, db),
      parseSessionsUrlParams({ topicId: `topic-refund-${RUN}`, topicFacet: 'task', sort: 'startedAt', dir: 'asc' }, true),
    );

    expect(page.total).toBe(2);
    expect(page.sessions.map((s) => s.traceId)).toEqual(refundIds);
    const returnedIds = page.sessions.map((s) => s.traceId);
    expect(returnedIds).not.toContain(loginId);
    expect(returnedIds).not.toContain(unassignedId);
  });

  it("drilling into the other topic returns only that topic's trace", async () => {
    const db = await createTenantScopedClient(org, org.tenantId);
    const page = await agentSessionsService.listSessions(
      ctx(org, org.tenantId, appId, db),
      parseSessionsUrlParams({ topicId: `topic-login-${RUN}`, topicFacet: 'task' }, true),
    );

    expect(page.total).toBe(1);
    expect(page.sessions.map((s) => s.traceId)).toEqual([loginId]);
  });
});
