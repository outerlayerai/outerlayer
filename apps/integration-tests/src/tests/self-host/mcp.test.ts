/**
 * Self-host MCP mount — the SAME `POST /v1/mcp` dispatcher the hosted
 * Cloudflare gateway serves (`@repo/gateway-core`'s `openapi/mcp/` is
 * runtime-agnostic), driven through the Node self-host composition exactly
 * as `self-host/ingest-and-read.test.ts` drives `/v1/agents/sync` and
 * `/v1/spans` — `SelfHostAuthResolver` resolves the caller from
 * `X-Outerlayer-App-Id` (perimeter trust; no key service), and
 * `NoopRateLimiter` backs every rate-limited tool call, so a self-host
 * deployment never throttles MCP the way hosted does.
 *
 * OAuth (spec §5.4 / group 13) needs Supabase's OAuth 2.1 server, which is
 * unavailable under `SELF_HOST_TRUST_PERIMETER` — this suite exercises only
 * the API-key MCP path, which is the one self-host connector setup uses
 * (see apps/gateway-node/README.md's MCP section).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dispatchRequest } from '@repo/gateway-core/dispatch-request';
import { setGatewayContextFactory } from '@repo/gateway-core/openapi';
import { initCache } from '@repo/gateway-core/utils';
import { memory } from '@repo/gateway-core/cache-store';
import { initLogContext } from '@repo/gateway-core/context';
import type { Env, GatewayRequest } from '@repo/gateway-core/types';
import type { ExecutionCtx } from '@repo/gateway-core/runtime/execution';
import type { GatewayContext } from '@repo/gateway-core/runtime/gateway-context';
import { NoopCacheStore } from '@repo/gateway-core/runtime/adapters/noop-cache-store';
import { SelfHostBillingService } from '@repo/gateway-core/runtime/adapters/self-host-billing-service';
import { NodeLogger } from '@repo/gateway-core/runtime/adapters/node-logger';
import { SelfHostAuthResolver } from '@repo/gateway-core/runtime/adapters/self-host-auth-resolver';
import { NoopRateLimiter } from '@repo/gateway-core/runtime/adapters/noop-rate-limiter';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
const SERVICE_ROLE =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const ANON =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

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

const pending: Promise<unknown>[] = [];
const execCtx: ExecutionCtx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(Promise.resolve(p).catch(() => {}));
  },
  passThroughOnException: () => {},
};

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
  };
}

async function callSelfHostGateway(appId: string, jsonRpcBody: unknown): Promise<Response> {
  const req = new Request('http://self-host.test/v1/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer selfhost-no-secret',
      'X-Outerlayer-App-Id': appId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(jsonRpcBody),
  }) as GatewayRequest;
  req.context = {};
  initLogContext(req, env);
  const gtx = buildSelfHostGtx(env, execCtx);
  const cache = initCache(gtx.cacheL2Store, execCtx, memory);
  return dispatchRequest({ request: req, env, ctx: execCtx, cache, gtx });
}

async function seedTenant(runLabel: string): Promise<string> {
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
        SEED_ORG_NAME: `selfhost-mcp-${runLabel}`,
        SEED_APP_NAME: `selfhost-mcp-app-${runLabel}`,
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
  return appId;
}

describe('self-host: POST /v1/mcp (SelfHostAuthResolver + NoopRateLimiter)', () => {
  let appId: string;

  beforeAll(async () => {
    appId = await seedTenant(randomUUID().slice(0, 8));
    setGatewayContextFactory((e, ctx) => buildSelfHostGtx(e as Env, ctx));
  }, 120_000);

  afterAll(() => {
    setGatewayContextFactory(() => {
      throw new Error('gateway context factory reset after self-host MCP test');
    });
  });

  // proves AC-052-08
  it('lists the same seven tools + guide resource as hosted', async () => {
    const res = await callSelfHostGateway(appId, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(
      [
        'compare_windows',
        'get_fleet_overview',
        'get_model_costs',
        'get_session',
        'list_context_changes',
        'list_sessions',
        'list_topics',
      ].sort(),
    );

    const resourcesRes = await callSelfHostGateway(appId, { jsonrpc: '2.0', id: 2, method: 'resources/list' });
    const resourcesBody = (await resourcesRes.json()) as { result: { resources: Array<{ uri: string }> } };
    expect(resourcesBody.result.resources.map((r) => r.uri)).toEqual(['outerlayer://guide']);
  });

  it('calls a rate-limited tool without throttling — the self-host rate limiter is a no-op', async () => {
    const call = () =>
      callSelfHostGateway(appId, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_fleet_overview', arguments: {} },
      });

    // observabilityRead's free tier caps at 100/min — twelve calls in a tight
    // loop would trip a real limiter; NoopRateLimiter always allows.
    const results = await Promise.all(Array.from({ length: 12 }, call));
    for (const res of results) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result?: { structuredContent: { data: unknown } }; error?: unknown };
      expect(body.error).toBeUndefined();
      expect(body.result?.structuredContent.data).toBeDefined();
    }
  });

  it('GET /v1/mcp is a 405, matching hosted', async () => {
    const req = new Request('http://self-host.test/v1/mcp', {
      method: 'GET',
      headers: { Authorization: 'Bearer selfhost-no-secret', 'X-Outerlayer-App-Id': appId },
    }) as GatewayRequest;
    req.context = {};
    initLogContext(req, env);
    const gtx = buildSelfHostGtx(env, execCtx);
    const cache = initCache(gtx.cacheL2Store, execCtx, memory);
    const res = await dispatchRequest({ request: req, env, ctx: execCtx, cache, gtx });
    expect(res.status).toBe(405);
  });
});
