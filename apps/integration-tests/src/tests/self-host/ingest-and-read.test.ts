/**
 * Self-host agent-session ingest — end-to-end through the NODE self-host
 * composition against real Supabase (auth) + real ClickHouse (ingest + read).
 *
 * The gateway-http suite boots wrangler = the CLOUDFLARE composition. This test
 * drives the SELF-HOST GatewayContext instead — the seam that makes self-host
 * observability work: `SelfHostAuthResolver` authenticates a programmatic
 * request by resolving the tenant from the operator's Supabase `app` row (no
 * key service, perimeter trust), through the SAME `dispatchRequest` funnel the
 * Node server uses (see apps/gateway-node/src/context.ts, which this file's
 * `buildSelfHostGtx` mirrors — that file lives in an app and isn't importable).
 *
 * `POST /v1/agents/sync` is the live self-host ingest path (OTLP `/v1/traces`
 * ingest no longer exists). It is authenticated only by `X-Outerlayer-App-Id`
 * and writes `otel_traces` + `agent_session_summary` rows directly — no queue,
 * no InlineTraceIngestor. The session payload embeds a decoy: a SECOND
 * tenant's id inside `env.gitRepo`, a free-text field the route never reads
 * for identity. The regression this guards against is a converter that trusts
 * anything content-shaped as a tenant id instead of the auth-resolved one —
 * the row must carry the tenant `SelfHostAuthResolver` resolved from the app
 * id, never the decoy. `GET /v1/spans` (the surviving read route) then reads
 * the row back through the same self-host composition.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { queryClickHouse, executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { flushAndWaitForClickHouse } from '../../helpers/wait-for-clickhouse';
import { dispatchRequest } from '@repo/gateway-core/dispatch-request';
import { setGatewayContextFactory } from '@repo/gateway-core/openapi';
import { initCache } from '@repo/gateway-core/utils';
import { memory } from '@repo/gateway-core/cache-store';
import { initLogContext } from '@repo/gateway-core/context';
import { traceIdForSession } from '@repo/gateway-core/services/agent-session-converter';
import type { Env, GatewayRequest } from '@repo/gateway-core/types';
import type { ExecutionCtx } from '@repo/gateway-core/runtime/execution';
import type { GatewayContext } from '@repo/gateway-core/runtime/gateway-context';
import { NoopCacheStore } from '@repo/gateway-core/runtime/adapters/noop-cache-store';
import { SelfHostBillingService } from '@repo/gateway-core/runtime/adapters/self-host-billing-service';
import { NodeLogger } from '@repo/gateway-core/runtime/adapters/node-logger';
import { SelfHostAuthResolver } from '@repo/gateway-core/runtime/adapters/self-host-auth-resolver';
import { NoopRateLimiter } from '@repo/gateway-core/runtime/adapters/noop-rate-limiter';
import { NotSupportedSmtpEmailSender } from '@repo/gateway-core/runtime/adapters/not-supported-smtp-sender';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

// Local/CI infra (same values the gateway-http suite's .dev.vars.ci uses).
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
const SERVICE_ROLE =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const ANON =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Self-host boot env (mirrors what apps/gateway-node's loadEnv would produce).
const env = {
  SUPABASE_API_BASE_URL: SUPABASE_URL,
  SUPABASE_SECRET_KEY: SERVICE_ROLE,
  SUPABASE_PUBLISHABLE_KEY: ANON,
  SUPABASE_JWT_SECRET:
    process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long',
  CLICKHOUSE_HOST: 'http://127.0.0.1:18123',
  CLICKHOUSE_PASSWORD: '',
  NODE_ENV: 'development',
  OUTERLAYER_SELF_HOSTED: 'true',
} as unknown as Env;

// Fire-and-forget background work, captured so the test can await any
// waitUntil'd work before asserting (on Node, `waitUntil` is detached — there
// is no request-outlives-response guarantee to lean on). agents/sync itself
// inserts synchronously inside the handler, but the log flush still rides
// waitUntil, so this keeps the same shape as the rest of the suite.
const pending: Promise<unknown>[] = [];
const execCtx: ExecutionCtx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(Promise.resolve(p).catch(() => {}));
  },
  passThroughOnException: () => {},
};

/** The self-host GatewayContext — mirror of apps/gateway-node/src/context.ts.
 * `_e` (the boot env) is unused at construction: every self-host adapter is
 * env-free or reads env per-request (the ClickHouse host flows in via the
 * request `env` threaded through `dispatchRequest`), same as context.ts. */
function buildSelfHostGtx(_e: Env, ctx: ExecutionCtx): GatewayContext {
  const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);
  return {
    waitUntil,
    execCtx: ctx,
    cacheL2Store: new NoopCacheStore(),
    billing: new SelfHostBillingService(),
    logger: new NodeLogger(),
    auth: new SelfHostAuthResolver(),
    rateLimiter: new NoopRateLimiter(),
    smtpEmailSender: new NotSupportedSmtpEmailSender(),
  };
}

/** Drive one request through the self-host dispatcher, exactly as the Node server does. */
async function callSelfHostGateway(
  method: string,
  path: string,
  appId: string,
  body?: string,
): Promise<Response> {
  const req = new Request(`http://self-host.test${path}`, {
    method,
    headers: {
      // This env sets no SELF_HOST_GATEWAY_SECRET, so SelfHostAuthResolver is in
      // its perimeter-trust posture and resolves from X-Outerlayer-App-Id alone.
      Authorization: 'Bearer selfhost-no-secret',
      'X-Outerlayer-App-Id': appId,
      'Content-Type': 'application/json',
    },
    body,
  }) as GatewayRequest;
  req.context = {};
  initLogContext(req, env);
  const gtx = buildSelfHostGtx(env, execCtx);
  const cache = initCache(gtx.cacheL2Store, execCtx, memory);
  return dispatchRequest({ request: req, env, ctx: execCtx, cache, gtx });
}

/** Seed a tenant + app via the same seeder the gateway-http suite uses.
 * Returns [appId, tenantId]. */
async function seedTenant(runLabel: string): Promise<[string, string]> {
  const seed = spawnSync(
    'yarn',
    ['workspace', 'gateway', 'exec', 'tsx', 'scripts/seed-test-tenant.ts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
        SEED_ORG_NAME: `selfhost-it-${runLabel}`,
        SEED_APP_NAME: `selfhost-it-app-${runLabel}`,
        // Self-host never verifies key values (perimeter trust) — any pepper
        // satisfies the seeder, which hard-fails without one.
        API_KEY_PEPPER: process.env.API_KEY_PEPPER ?? 'selfhost-it-pepper-not-a-secret',
      },
    },
  );
  if (seed.status !== 0) {
    throw new Error(`seed-test-tenant.ts failed (${seed.status}): ${seed.stderr}`);
  }
  const appId = seed.stdout.split('\n').find((l) => l.startsWith('app_id='))?.slice(7).trim() ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(appId)) {
    throw new Error(`seed did not emit a UUID: ${JSON.stringify(appId)}`);
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app?id=eq.${appId}&select=tenant_id`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!res.ok) throw new Error(`tenant lookup failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as Array<{ tenant_id: string }>;
  if (rows.length !== 1 || !rows[0]?.tenant_id) {
    throw new Error(`expected 1 app row for ${appId}, got ${rows.length}`);
  }
  return [appId, rows[0].tenant_id];
}

describe('self-host: POST /v1/agents/sync (SelfHostAuthResolver → ClickHouse) + GET /v1/spans read-back', () => {
  let appIdA: string;
  let tenantIdA: string;
  let tenantIdB: string;
  const sessionId = randomUUID();
  const traceId = traceIdForSession(sessionId);

  beforeAll(async () => {
    // Seed TWO tenants. Tenant A is the caller; tenant B's id is only ever
    // used as free-text decoy content in the payload below (env.gitRepo) —
    // it must never end up as the row's TenantId.
    const run = randomUUID().slice(0, 8);
    [appIdA, tenantIdA] = await seedTenant(`a-${run}`);
    [, tenantIdB] = await seedTenant(`b-${run}`);

    // Route /v1/* requests through the self-host composition (the openapi
    // middleware builds gtx from this factory — dispatchRequest's gtx param
    // only covers legacy/dispatch routes).
    setGatewayContextFactory((e, ctx) => buildSelfHostGtx(e as Env, ctx));
  }, 120_000);

  afterAll(async () => {
    await executeClickHouse(`ALTER TABLE otel_traces DELETE WHERE TraceId = '${traceId}'`);
    await executeClickHouse(`ALTER TABLE agent_session_summary DELETE WHERE TraceId = '${traceId}'`);
    setGatewayContextFactory(() => {
      throw new Error('gateway context factory reset after self-host ingest test');
    });
  });

  it('authenticates by app id, stamps rows with the RESOLVED tenant (not a payload decoy), and reads them back', async () => {
    const payload = {
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          id: sessionId,
          agent: { type: 'claude-code', version: '2.1.201' },
          // A second tenant's id, embedded in free-text content the converter
          // never treats as identity. If it ever leaked into TenantId, this
          // decoy is what would prove it.
          env: { cwd: '/home/dev/acme', gitRepo: `github.com/${tenantIdB}/decoy-repo`, gitBranch: 'main' },
          startedAt: '2026-07-01T10:00:00.000Z',
          endedAt: '2026-07-01T10:05:00.000Z',
          models: ['claude-opus-4-8'],
          turns: [
            { index: 0, role: 'user', toolCalls: [], text: 'fix issue', ts: '2026-07-01T10:00:01.000Z' },
            {
              index: 1,
              role: 'assistant',
              text: 'done',
              model: 'claude-opus-4-8',
              usage: { in: 10, out: 20, cacheRead: 0, cacheCreate: 0 },
              toolCalls: [],
              ts: '2026-07-01T10:00:05.000Z',
            },
          ],
          events: [],
          totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
          captureTier: 'full',
          warnings: [],
        },
      ],
    };

    // 1) INGEST — SelfHostAuthResolver authenticates via X-Outerlayer-App-Id.
    const ingest = await callSelfHostGateway('POST', '/v1/agents/sync', appIdA, JSON.stringify(payload));
    expect(ingest.status).toBe(200);
    const ingestBody = (await ingest.json()) as {
      data: { accepted: string[]; rejected: unknown[]; spanRows: number };
    };
    expect(ingestBody.data.accepted).toEqual([sessionId]);
    expect(ingestBody.data.rejected).toEqual([]);

    await Promise.allSettled(pending);

    // 2) The rows landed, stamped with the tenant the resolver derived from
    // Supabase for appIdA — NOT the decoy tenant id embedded in env.gitRepo.
    await flushAndWaitForClickHouse(
      `SELECT count() AS n FROM agent_session_summary WHERE TraceId = '${traceId}' FORMAT JSONEachRow`,
      (r) => r.length > 0 && Number(r[0].n) >= 1,
      30_000,
    );
    const summaryRows = await queryClickHouse(
      `SELECT TraceId, TenantId, AppId FROM agent_session_summary WHERE TraceId = '${traceId}' FORMAT JSONEachRow`,
    );
    expect(summaryRows).toEqual([{ TraceId: traceId, TenantId: tenantIdA, AppId: appIdA }]);

    const spanRows = await queryClickHouse(
      `SELECT DISTINCT TraceId, TenantId, AppId FROM otel_traces WHERE TraceId = '${traceId}' FORMAT JSONEachRow`,
    );
    expect(spanRows).toEqual([{ TraceId: traceId, TenantId: tenantIdA, AppId: appIdA }]);

    // 3) READ PATH — GET /v1/spans reads the ingested spans back, scoped to
    // the same resolved appIdA/tenantIdA identity.
    const read = await callSelfHostGateway('GET', `/v1/spans?trace_id=${traceId}`, appIdA);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { data: Array<{ trace_id: string; name: string }> };
    expect(readBody.data.map((s) => s.trace_id)).toEqual([traceId, traceId, traceId]);
    expect(readBody.data.map((s) => s.name).sort()).toEqual(
      ['agent.session', 'agent.turn.assistant', 'agent.turn.user'].sort(),
    );
  });
});
