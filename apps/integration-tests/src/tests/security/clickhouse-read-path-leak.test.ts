/**
 * Cross-tenant leak test — the APP read path on real ClickHouse.
 *
 * The raw-policy canary (`clickhouse-row-policy.test.ts`) proves the migration-29/31
 * policies with no app code. This proves the layer above it: the actual
 * `observability-service` `AnalyticsService` — the class every dashboard read
 * runs through — built over a row-policy read client (analytics_reader identity
 * + `SQL_tenant_id`/`SQL_app_id`, exactly what the dashboard's
 * `createTenantReadClient` constructs) cannot return another tenant's rows.
 *
 * What must hold, driven through getMetrics / getTraces / getScores /
 * getAgentFleetOverview:
 *   - a read under tenant A returns ONLY tenant A's rows — zero tenant B, even
 *     though B's rows sit in the same tables with larger/different values;
 *   - a cross-app read (tenant A's context asking for tenant B's app) is empty;
 *   - a service with no tenant scope fails closed — it errors, never unfiltered.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import {
  AnalyticsService,
  type IClickHouseQuery,
  type TenantContext,
  type VerifiedAppId,
} from '@repo/observability-service';
import {
  CLICKHOUSE_TEST_HOST,
  CLICKHOUSE_TEST_READ_USER,
  CLICKHOUSE_TEST_READ_PASSWORD,
  executeClickHouse,
} from '../../../clickhouse/setup-clickhouse';

const RUN = randomBytes(4).toString('hex');
const TENANT_A = `leak-tenant-a-${RUN}`;
const TENANT_B = `leak-tenant-b-${RUN}`;
const APP_A = `leak-app-a-${RUN}`;
const APP_B = `leak-app-b-${RUN}`;

// A's rows are deliberately fewer and cheaper than B's, so a leak shows up as a
// wrong count OR a wrong cost, not just extra ids.
const A_TRACES = [`leak-trace-a1-${RUN}`, `leak-trace-a2-${RUN}`];
const B_TRACES = [`leak-trace-b1-${RUN}`, `leak-trace-b2-${RUN}`, `leak-trace-b3-${RUN}`];
const A_COST_EACH = 0.1;
const B_COST_EACH = 1.0;

const clients: ClickHouseClient[] = [];

/** A service over the row-policy read identity, scoped like createTenantReadClient. */
function readerService(scope: { tenantId?: string; appId?: string }): AnalyticsService {
  const settings: Record<string, string> = {};
  if (scope.tenantId !== undefined) settings.SQL_tenant_id = scope.tenantId;
  if (scope.appId) settings.SQL_app_id = scope.appId;
  const client = createClient({
    url: CLICKHOUSE_TEST_HOST,
    username: CLICKHOUSE_TEST_READ_USER,
    password: CLICKHOUSE_TEST_READ_PASSWORD,
    database: 'default',
    clickhouse_settings: settings,
  });
  clients.push(client);
  return new AnalyticsService(client as unknown as IClickHouseQuery);
}

function ctx(tenantId: string, appId: string): TenantContext {
  return {
    userId: `leak-user-${RUN}`,
    tenantId,
    appId: appId as VerifiedAppId,
    dataRetentionDays: -1,
  };
}

// A window that brackets `now()` so the seeded rows fall in the current period.
const DAY = 86_400_000;
const RANGE = {
  start: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10),
  end: new Date(Date.now() + 1 * DAY).toISOString().slice(0, 10),
};

beforeAll(async () => {
  const traceRows = [
    ...A_TRACES.map(
      (t) =>
        `(now(), '${t}', '${t}-span', '${TENANT_A}', '${APP_A}', 'GENERATION', '1', ${A_COST_EACH}, 10, 5, 'leak-model')`,
    ),
    ...B_TRACES.map(
      (t) =>
        `(now(), '${t}', '${t}-span', '${TENANT_B}', '${APP_B}', 'GENERATION', '1', ${B_COST_EACH}, 20, 6, 'leak-model')`,
    ),
  ].join(',\n');
  await executeClickHouse(
    `INSERT INTO otel_traces (Timestamp, TraceId, SpanId, TenantId, AppId, Type, StatusCode, Cost, TotalTokens, Duration, Model)
     VALUES ${traceRows}`,
  );

  await executeClickHouse(
    `INSERT INTO agent_session_summary (TenantId, AppId, TraceId, StartedAt)
     VALUES ('${TENANT_A}', '${APP_A}', 'leak-sess-a1-${RUN}', now()),
            ('${TENANT_A}', '${APP_A}', 'leak-sess-a2-${RUN}', now()),
            ('${TENANT_B}', '${APP_B}', 'leak-sess-b1-${RUN}', now()),
            ('${TENANT_B}', '${APP_B}', 'leak-sess-b2-${RUN}', now()),
            ('${TENANT_B}', '${APP_B}', 'leak-sess-b3-${RUN}', now())`,
  );

  await executeClickHouse(
    `INSERT INTO scores (Id, TenantId, AppId, Name, CreatedAt)
     VALUES ('leak-score-a1-${RUN}', '${TENANT_A}', '${APP_A}', 'accuracy', now()),
            ('leak-score-a2-${RUN}', '${TENANT_A}', '${APP_A}', 'accuracy', now()),
            ('leak-score-b1-${RUN}', '${TENANT_B}', '${APP_B}', 'accuracy', now()),
            ('leak-score-b2-${RUN}', '${TENANT_B}', '${APP_B}', 'accuracy', now()),
            ('leak-score-b3-${RUN}', '${TENANT_B}', '${APP_B}', 'accuracy', now())`,
  );
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  for (const table of ['otel_traces', 'agent_session_summary', 'scores']) {
    await executeClickHouse(
      `ALTER TABLE ${table} DELETE WHERE TenantId IN ('${TENANT_A}', '${TENANT_B}')`,
    );
  }
});

describe('AnalyticsService cross-tenant isolation on the real read path', () => {
  it('getMetrics under tenant A aggregates ONLY tenant A (B rows never counted)', async () => {
    const { summary } = await readerService({ tenantId: TENANT_A, appId: APP_A }).getMetrics(
      ctx(TENANT_A, APP_A),
      RANGE,
    );
    // Two A rows, cost 0.1 each. A leak of any B row would raise the count and
    // push cost toward B's 1.0-each, so both pin the boundary.
    expect(summary.totalRequests).toBe(A_TRACES.length);
    expect(summary.totalCost).toBeCloseTo(A_TRACES.length * A_COST_EACH, 5);
  });

  it('getTraces under tenant A returns ONLY tenant A trace ids', async () => {
    const { traces, total } = await readerService({ tenantId: TENANT_A, appId: APP_A }).getTraces(
      ctx(TENANT_A, APP_A),
      { limit: 100, offset: 0 },
    );
    expect(total).toBe(A_TRACES.length);
    expect(traces.map((t) => t.id).sort()).toEqual([...A_TRACES].sort());
    for (const id of B_TRACES) expect(traces.map((t) => t.id)).not.toContain(id);
  });

  it('getScores under tenant A returns ONLY tenant A scores', async () => {
    const { total } = await readerService({ tenantId: TENANT_A, appId: APP_A }).getScores(
      ctx(TENANT_A, APP_A),
      { limit: 100, offset: 0 },
    );
    expect(total).toBe(2);
  });

  it('getAgentFleetOverview under tenant A counts ONLY tenant A sessions (org sweep)', async () => {
    const overview = await readerService({ tenantId: TENANT_A, appId: APP_A }).getAgentFleetOverview(
      ctx(TENANT_A, APP_A),
      RANGE,
      { scope: 'org' },
    );
    // Two A sessions; B's three would show if the tenant scope leaked.
    expect(overview.sessions.current).toBe(2);
  });

  it('a cross-app read (tenant A context, tenant B app) returns nothing', async () => {
    // Both the policy (SQL_tenant_id = A) and the WHERE (AppId = B's app) deny.
    const { total } = await readerService({ tenantId: TENANT_A, appId: APP_B }).getTraces(
      ctx(TENANT_A, APP_B),
      { limit: 100, offset: 0 },
    );
    expect(total).toBe(0);
  });

  it('fail-closed: a service with no tenant scope errors, never returns unfiltered rows', async () => {
    // No SQL_tenant_id → the row policy rejects with UNKNOWN_SETTING rather
    // than exposing every tenant's rows.
    await expect(
      readerService({}).getTraces(ctx(TENANT_A, APP_A), { limit: 100, offset: 0 }),
    ).rejects.toThrow();
  });
});
