/**
 * Tests for routes migrated from the legacy dispatch table to the OpenAPI framework.
 *
 * Covers:
 *   - CreateScore (POST /v1/scores)
 *   - HealthCheck (GET /health)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVerifiedAppId } from '@repo/observability-service';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn().mockResolvedValue(undefined);

vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    insert: mockInsert,
    command: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock the analytics-factory so _shared.getService doesn't blow up if
// any shared code attempts to use it during import.
vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_APP_ID = createVerifiedAppId('app-test-123');
const TEST_TENANT_ID = 'tenant-test-456';

interface CapturedResponse {
  body: unknown;
  status: number;
  headers: Record<string, string>;
}

function createMockContext(overrides?: {
  env?: Record<string, unknown>;
  body?: unknown;
}): { ctx: AppContext; getResponse: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200, headers: {} };

  const ctx = {
    get: vi.fn((key: string) => {
      if (key === 'user') {
        return {
          appId: TEST_APP_ID,
          tenantId: TEST_TENANT_ID,
          appName: 'Test App',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          branchId: '',
        };
      }
      return undefined;
    }),
    env: overrides?.env ?? {
      CLICKHOUSE_HOST: 'http://localhost:8123',
      CLICKHOUSE_PASSWORD: 'test',
    },
    json: vi.fn((body: unknown, status?: number, headers?: Record<string, string>) => {
      captured = { body, status: status ?? 200, headers: headers ?? {} };
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
      });
    }),
    req: {
      method: 'POST',
      path: '/v1/scores',
      url: 'http://localhost/v1/scores',
      header: vi.fn(() => undefined),
      json: vi.fn().mockResolvedValue(overrides?.body ?? {}),
    },
  } as unknown as AppContext;

  return { ctx, getResponse: () => captured };
}

function createRouteInstance<T extends new (opts: any) => any>(
  RouteClass: T,
): InstanceType<T> {
  const instance = new RouteClass({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  });
  // Stub getValidatedData since CreateScore does its own parsing
  instance.getValidatedData = vi.fn().mockResolvedValue({});
  return instance;
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CreateScore, CreateScoresBatch } from '../routes/scores';
import { HealthCheck } from '../routes/health';
import { setRequiredEnvKeys } from '../required-env';

// ---------------------------------------------------------------------------
// CreateScore
// ---------------------------------------------------------------------------

describe('CreateScore handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a score with snake_case resource_id', async () => {
    const body = {
      resource_id: 'trace-abc',
      name: 'accuracy',
      score: 0.95,
      label: 'good',
      reason: 'Correct answer',
      source: 'experiment',
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(201);
    expect((resp.body as Record<string, unknown>).message).toBe('Score created successfully');

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.table).toBe('scores');
    // The id returned to the caller is the same generated Id persisted to
    // ClickHouse — not a placeholder or a second, divergent UUID.
    expect((resp.body as Record<string, unknown>).id).toBe(insertCall.values[0].Id);
    expect(insertCall.values[0].ResourceId).toBe('trace-abc');
    expect(insertCall.values[0].Name).toBe('accuracy');
    expect(insertCall.values[0].Score).toBe(0.95);
    expect(insertCall.values[0].TenantId).toBe(TEST_TENANT_ID);
    expect(insertCall.values[0].AppId).toBe(TEST_APP_ID);
    expect(insertCall.values[0].Source).toBe('experiment');
  });

  it('should create a score with legacy camelCase resourceId', async () => {
    const body = {
      resourceId: 'trace-legacy',
      name: 'quality',
      score: 0.8,
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(201);

    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values[0].ResourceId).toBe('trace-legacy');
    expect(insertCall.values[0].Source).toBe('api'); // default for an omitted source
  });

  it('should prefer resource_id over resourceId when both are provided', async () => {
    const body = {
      resource_id: 'snake-wins',
      resourceId: 'camel-loses',
      name: 'test',
      score: 1.0,
    };

    const { ctx } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values[0].ResourceId).toBe('snake-wins');
  });

  it('should return 400 when resource_id is missing', async () => {
    const body = {
      name: 'test',
      score: 1.0,
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(400);
  });

  it('should return 400 for invalid dataType', async () => {
    const body = {
      resource_id: 'trace-1',
      name: 'test',
      score: 1.0,
      dataType: 'invalid-type',
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(400);
    expect((resp.body as { error: { message: string } }).error.message).toContain('dataType');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('should accept valid dataType values', async () => {
    for (const dt of ['boolean', 'numeric', 'categorical', '']) {
      vi.clearAllMocks();
      const body = {
        resource_id: 'trace-1',
        name: 'test',
        score: 1.0,
        dataType: dt,
      };

      const { ctx, getResponse } = createMockContext({ body });
      const route = createRouteInstance(CreateScore);
      await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

      const resp = getResponse();
      expect(resp.status).toBe(201);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    }
  });

  it('should pass legacy type and dataType fields through to ClickHouse', async () => {
    const body = {
      resource_id: 'trace-1',
      name: 'test',
      score: 1.0,
      type: 'manual',
      dataType: 'boolean',
    };

    const { ctx } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values[0].Type).toBe('manual');
    expect(insertCall.values[0].DataType).toBe('boolean');
  });

  it("should default source to 'api' when not provided", async () => {
    const body = {
      resource_id: 'trace-1',
      name: 'test',
      score: 1.0,
    };

    const { ctx } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values[0].Source).toBe('api');
  });

  it('should default empty strings for missing optional fields', async () => {
    const body = {
      resource_id: 'trace-1',
      name: 'test',
      score: 1.0,
    };

    const { ctx } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values[0].Label).toBe('');
    expect(insertCall.values[0].Reason).toBe('');
    expect(insertCall.values[0].Type).toBe('');
    expect(insertCall.values[0].DataType).toBe('');
  });

  it('should generate a UUID for the score id', async () => {
    const body = {
      resource_id: 'trace-1',
      name: 'test',
      score: 1.0,
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScore);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    const id = (resp.body as Record<string, string>).id;
    // UUID v4 pattern
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Same ID should be passed to ClickHouse
    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values[0].Id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// CreateScoresBatch
// ---------------------------------------------------------------------------

describe('CreateScoresBatch handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts all items in one ClickHouse batch and returns 201 when every item is valid', async () => {
    const body = {
      scores: [
        { resource_id: 'trace-a', name: 'quality', score: 0.9, client_id: 'row-1' },
        { resourceId: 'trace-b', name: 'relevance', score: 0.8 }, // legacy camelCase
      ],
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScoresBatch);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(201);
    const respBody = resp.body as {
      data: {
        results: Array<{ status: string; id?: string; client_id?: string }>;
        summary: { total: number; succeeded: number; failed: number };
      };
    };
    expect(respBody.data.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(respBody.data.results[0]!.status).toBe('success');
    expect(respBody.data.results[0]!.client_id).toBe('row-1');
    expect(respBody.data.results[1]!.status).toBe('success');
    expect(respBody.data.results[1]!.client_id).toBeUndefined();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values).toHaveLength(2);
    expect(insertCall.values[0].ResourceId).toBe('trace-a');
    expect(insertCall.values[1].ResourceId).toBe('trace-b');
  });

  it('returns 207 with per-item errors when some items fail validation', async () => {
    const body = {
      scores: [
        { resource_id: 'trace-a', name: 'q', score: 0.9 },
        { name: 'missing-resource', score: 0.1 }, // no resource_id
        { resource_id: 'trace-c', name: 'bad-dt', score: 0.5, dataType: 'bogus' },
      ],
    };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScoresBatch);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(207);
    const respBody = resp.body as {
      data: {
        results: Array<{ status: string; error?: { code: string } }>;
        summary: { total: number; succeeded: number; failed: number };
      };
    };
    expect(respBody.data.summary).toEqual({ total: 3, succeeded: 1, failed: 2 });
    expect(respBody.data.results[0]!.status).toBe('success');
    expect(respBody.data.results[1]!.status).toBe('error');
    expect(respBody.data.results[1]!.error!.code).toBe('missing_required_field');
    expect(respBody.data.results[2]!.error!.code).toBe('invalid_field_value');

    // Only the one valid item should have been inserted
    const insertCall = mockInsert.mock.calls[0]![0];
    expect(insertCall.values).toHaveLength(1);
    expect(insertCall.values[0].ResourceId).toBe('trace-a');
  });

  it('returns 400 and never touches ClickHouse when every item fails validation', async () => {
    const body = { scores: [{ name: 'no-resource', score: 1 }] };

    const { ctx, getResponse } = createMockContext({ body });
    const route = createRouteInstance(CreateScoresBatch);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    expect(getResponse().status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 413 when batch exceeds MAX_SCORES_BATCH_SIZE', async () => {
    const scores = Array.from({ length: 1001 }, (_, i) => ({
      resource_id: `t-${i}`,
      name: 'n',
      score: 0,
    }));

    const { ctx, getResponse } = createMockContext({ body: { scores } });
    const route = createRouteInstance(CreateScoresBatch);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    expect(getResponse().status).toBe(413);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 when envelope is malformed (missing scores array)', async () => {
    const { ctx, getResponse } = createMockContext({ body: { not_scores: [] } });
    const route = createRouteInstance(CreateScoresBatch);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    expect(getResponse().status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 when scores array is empty', async () => {
    const { ctx, getResponse } = createMockContext({ body: { scores: [] } });
    const route = createRouteInstance(CreateScoresBatch);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    expect(getResponse().status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HealthCheck
// ---------------------------------------------------------------------------

describe('HealthCheck handler', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /**
   * Everything the handler logged this test, joined. The missing variable names
   * live here rather than in the response body, so this is where the
   * "did it detect the right keys" assertions look.
   */
  const healthLog = () => errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  // Entrypoint-declared required keys are process-global (openapi/required-env).
  // Reset after every test so a test that declares extras can't leak them into
  // the next (the Node-case tests below assert healthy with ZERO extras).
  afterEach(() => {
    setRequiredEnvKeys([]);
  });

  // The six runtime-agnostic keys `/health` checks via the picked sub-schema —
  // the ONLY keys both the hosted Worker and the Node self-host runtime need.
  const makeAgnosticEnv = (): Record<string, unknown> => ({
    CLICKHOUSE_HOST: 'http://localhost:8123',
    SUPABASE_API_BASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: 'c'.repeat(32),
    SUPABASE_PUBLISHABLE_KEY: 'anon-key',
    NODE_ENV: 'development',
  });

  // A fully-populated env that passes EnvSchema. Tests clone this and drop
  // individual keys to prove which vars are required vs optional.
  const makeValidEnv = (): Record<string, unknown> => ({
    UNKEY_API_KEY: 'test-key',
    CLICKHOUSE_HOST: 'http://localhost:8123',
    CLICKHOUSE_PASSWORD: 'test',
    STRIPE_SPAN_METER_KEY: 'meter-key',
    STRIPE_STORAGE_METER_KEY: 'storage-key',
    STRIPE_STORAGE_METER_ID: 'storage-id',
    STRIPE_SECRET_KEY: 'sk_test_123',
    CLOUDFLARE_ZONE_ID: 'zone-id',
    CLOUDFLARE_API_KEY: 'cf-key',
    CLOUDFLARE_CACHE_DOMAIN: 'cache.example.com',
    SUPABASE_API_BASE_URL: 'http://localhost:54321',
    SUPABASE_SECRET_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: 'c'.repeat(32),
    SUPABASE_PUBLISHABLE_KEY: 'anon-key',
    DASHBOARD_BASE_URL: 'http://localhost:3000',
    GITHUB_APP_ID: 'app-id',
    GITHUB_APP_PRIVATE_KEY: 'private-key',
    OAUTH_STATE_SECRET: 'd'.repeat(32),
    TOKEN_ENCRYPTION_KEY: 'a'.repeat(32),
    NODE_ENV: 'development',
    BETTERSTACK_LOGS_TOKEN: 'logs-token',
    BETTERSTACK_INGESTING_URL: 'http://ingest.example.com',
    BETTERSTACK_ERRORS_DSN: 'errors-dsn',
    // Environments & Promotion: Fly token is required so a staging deploy
    // missing it fails `/health` instead of breaking at first env action.
    FLY_API_TOKEN: 'fly-api-token-test',
    APP_CONNECTION: {},
  });

  it('should return healthy when all env vars are configured', async () => {
    const validEnv = makeValidEnv();

    const { ctx, getResponse } = createMockContext({ env: validEnv });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(200);
    expect((resp.body as Record<string, unknown>).status).toBe('healthy');
    const healthyTs = (resp.body as Record<string, unknown>).timestamp as string;
    // A valid ISO-8601 string round-trips through Date unchanged.
    expect(new Date(healthyTs).toISOString()).toBe(healthyTs);
    expect(resp.headers['Cache-Control']).toBe('public, max-age=10, s-maxage=10');
  });

  it('stays healthy when the optional BetterStack log vars are absent', async () => {
    // Self-host: a deploy with no logs vendor must still boot and pass /health.
    // The logger falls back to console-only when these are unset
    // (services/logger.ts), so they are optional, not required.
    const env = makeValidEnv();
    delete env.BETTERSTACK_LOGS_TOKEN;
    delete env.BETTERSTACK_INGESTING_URL;

    const { ctx, getResponse } = createMockContext({ env });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(200);
    expect((resp.body as Record<string, unknown>).status).toBe('healthy');
  });

  it('validates declared entrypoint keys by FORMAT, not just presence (malformed value fails /health)', async () => {
    // Strictness parity with the pre-split full EnvSchema check: an entrypoint
    // extra that is PRESENT but invalid must still fail /health, not slip
    // through a truthiness check. DASHBOARD_BASE_URL is `z.string().url()`.
    setRequiredEnvKeys(['DASHBOARD_BASE_URL']);

    // Present + valid → healthy (proves the check isn't just always-failing).
    {
      const { ctx, getResponse } = createMockContext({
        env: { ...makeAgnosticEnv(), DASHBOARD_BASE_URL: 'https://app.example.com' },
      });
      await (createRouteInstance(HealthCheck) as unknown as {
        handle: (c: AppContext) => Promise<Response>;
      }).handle(ctx);
      expect((getResponse().body as Record<string, unknown>).status).toBe('healthy');
    }

    // Present but malformed (a non-URL) → unhealthy, and the key is named.
    {
      const { ctx, getResponse } = createMockContext({
        env: { ...makeAgnosticEnv(), DASHBOARD_BASE_URL: 'not-a-url' },
      });
      await (createRouteInstance(HealthCheck) as unknown as {
        handle: (c: AppContext) => Promise<Response>;
      }).handle(ctx);
      const resp = getResponse();
      expect(resp.status).toBe(500);
      expect(healthLog()).toContain('DASHBOARD_BASE_URL');
    }
  });

  it('should return unhealthy with missing vars when env is incomplete', async () => {
    // Provide an empty env to trigger validation failures
    const { ctx, getResponse } = createMockContext({ env: {} });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(500);
    expect((resp.body as Record<string, unknown>).status).toBe('unhealthy');
    expect((resp.body as Record<string, unknown>).error).toBe('Missing environment variables');
    // A count, never the names — this route is unauthenticated.
    expect((resp.body as Record<string, unknown>).missing_count).toBeGreaterThan(0);
    expect((resp.body as Record<string, unknown>).missing).toBeUndefined();
    expect((resp.body as Record<string, unknown>).configure_at).toBeUndefined();
    // The operator detail goes to the logs instead.
    expect(healthLog()).toContain('Cloudflare Dashboard');
    const unhealthyTs = (resp.body as Record<string, unknown>).timestamp as string;
    expect(new Date(unhealthyTs).toISOString()).toBe(unhealthyTs);
    expect(resp.headers['Cache-Control']).toBe('no-store');
  });

  it('should log specific missing variable names without putting them on the wire', async () => {
    // Provide partial env: only UNKEY_API_KEY, rest missing
    const { ctx, getResponse } = createMockContext({
      env: { UNKEY_API_KEY: 'test' },
    });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    const logged = healthLog();
    expect(logged).toContain('CLICKHOUSE_HOST');
    // Should NOT list UNKEY_API_KEY since it was provided
    expect(logged).not.toContain('UNKEY_API_KEY');
    // Optional vars (BetterStack log shipping) are never reported missing.
    expect(logged).not.toContain('BETTERSTACK_LOGS_TOKEN');
    expect(logged).not.toContain('BETTERSTACK_INGESTING_URL');
    // None of those names reach the caller.
    expect(JSON.stringify(resp.body)).not.toContain('CLICKHOUSE_HOST');
    // STRIPE_* are gated by a superRefine that runs only after the base object
    // parses; this near-empty env aborts that base parse, so STRIPE isn't
    // evaluated here. The billing-on/off Stripe behavior is covered by the two
    // dedicated tests below (full env minus STRIPE), which is the real
    // "operator forgot one secret" scenario.
  });

  // STRIPE_* required-ness is a property of the entrypoint: the Worker always
  // runs Stripe, the node self-host root never does. The shared EnvSchema
  // treats STRIPE_* as optional; the Worker instead DECLARES them via
  // setRequiredEnvKeys and /health enforces that declaration.
  const STRIPE_REQUIRED = [
    'STRIPE_SECRET_KEY',
    'STRIPE_SPAN_METER_KEY',
    'STRIPE_STORAGE_METER_KEY',
    'STRIPE_STORAGE_METER_ID',
  ];

  it('flags entrypoint-declared required env (the Worker Stripe secrets) as unhealthy', async () => {
    // The hosted Worker declares STRIPE_* via setRequiredEnvKeys (apps/gateway
    // src/index.ts). /health must fold those into `missing` even though the
    // shared EnvSchema treats them as optional — a mutation that ignored the
    // entrypoint-declared keys would return 200 and fail this.
    setRequiredEnvKeys(STRIPE_REQUIRED);
    try {
      const env = makeValidEnv();
      for (const key of STRIPE_REQUIRED) delete env[key];

      const { ctx, getResponse } = createMockContext({ env });
      const route = createRouteInstance(HealthCheck);
      await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

      const resp = getResponse();
      expect(resp.status).toBe(500);
      for (const key of STRIPE_REQUIRED) expect(healthLog()).toContain(key);
    } finally {
      setRequiredEnvKeys([]);
    }
  });

  it('stays healthy when the entrypoint-declared required env is present', async () => {
    // makeValidEnv() carries all four Stripe secrets, so declaring them required
    // still yields 200 — proving the check passes when they are set (not that it
    // always fails).
    setRequiredEnvKeys(STRIPE_REQUIRED);
    try {
      const { ctx, getResponse } = createMockContext({ env: makeValidEnv() });
      const route = createRouteInstance(HealthCheck);
      await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);
      expect(getResponse().status).toBe(200);
    } finally {
      setRequiredEnvKeys([]);
    }
  });

  it('is healthy for the Node self-host case: only the six agnostic keys, no entrypoint extras', async () => {
    // The Node runtime declares NO entrypoint-required keys (afterEach keeps the
    // list empty) and has none of the hosted-only secrets (Unkey, Cloudflare,
    // Fly, GitHub, Stripe, OTel, …). With just the six agnostic keys it
    // MUST report healthy — a `/health` that still checked the full EnvSchema
    // would 500 here with every hosted-only key in `missing`.
    const { ctx, getResponse } = createMockContext({ env: makeAgnosticEnv() });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(200);
    expect((resp.body as Record<string, unknown>).status).toBe('healthy');
    // `missing_count` only exists on the unhealthy body — proving there was none.
    expect((resp.body as Record<string, unknown>).missing_count).toBeUndefined();
  });

  it('reports a missing agnostic key regardless of entrypoint declarations', async () => {
    // Drop one agnostic key (SUPABASE_PUBLISHABLE_KEY). It is required for BOTH runtimes,
    // via the picked sub-schema, so it must surface in `missing` even with no
    // entrypoint extras declared.
    const env = makeAgnosticEnv();
    delete env.SUPABASE_PUBLISHABLE_KEY;

    const { ctx, getResponse } = createMockContext({ env });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(500);
    expect((resp.body as Record<string, unknown>).missing_count).toBe(1);
    expect(healthLog()).toContain('SUPABASE_PUBLISHABLE_KEY');
  });

  it('unions entrypoint extras onto the agnostic base (the Worker case)', async () => {
    // The agnostic keys are all present, but the entrypoint declares a hosted-only
    // extra (FLY_API_TOKEN) that is absent — so /health is unhealthy and reports
    // exactly that one extra. This is the hosted-Worker contract: agnostic base OK,
    // an entrypoint-required key missing still fails.
    setRequiredEnvKeys(['FLY_API_TOKEN']);
    const { ctx, getResponse } = createMockContext({ env: makeAgnosticEnv() });
    const route = createRouteInstance(HealthCheck);
    await (route as unknown as { handle: (c: AppContext) => Promise<Response> }).handle(ctx);

    const resp = getResponse();
    expect(resp.status).toBe(500);
    expect((resp.body as Record<string, unknown>).missing_count).toBe(1);
    expect(healthLog()).toContain('FLY_API_TOKEN');
  });
});
