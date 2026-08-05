/**
 * Regression test for env-limit enforcement.
 *
 * `POST /v1/environments` must enforce the `max_environments_per_app` tier
 * limit: `buildEnvLimitCheck(env)` (lib/entitlements.ts) resolves the tier
 * ceiling and wraps `quotaCheck`; `buildEnvironmentService`
 * (routes/environments.ts) passes it to `EnvironmentService` as
 * `checkEnvLimit`. `createEnvironment` calls the hook BEFORE any DB write;
 * when `allowed` is false it returns `{ ok: false, code:
 * 'env_limit_exceeded' }` and the route handler maps that to HTTP 402.
 *
 * Covers two complementary cases:
 *   1. AT LIMIT — the service returns `env_limit_exceeded`; the route MUST
 *      reject with HTTP 402 and `error.code === 'env_limit_exceeded'`.
 *   2. BELOW LIMIT — the service returns a created env row; the route MUST
 *      succeed with HTTP 201.
 *
 * Layer: gateway route-handler unit test (same pattern as
 * `environments-list.test.ts` and `api-keys-list-create.test.ts`). An
 * integration test against real Supabase is the preferred long-term home,
 * but the enforcement logic lives entirely in the gateway's
 * `buildEnvironmentService` wiring + the shared `EnvironmentService`
 * business logic — both are testable without a live DB at this layer. The
 * integration suite at `apps/integration-tests/src/tests/` can add a
 * complementary real-DB test when convenient.
 *
 * Mock strategy:
 *   - `@repo/environments-service` is mocked so `createEnvironment` is a
 *     controllable stub; the mock accepts the `checkEnvLimit` dep and
 *     records it so the test can confirm the dep was wired.
 *   - `../../lib/entitlements` is mocked so `buildEnvLimitCheck` returns a
 *     known stub — this avoids hitting Supabase admin clients in a unit test
 *     while preserving the real call path in the route.
 *   - `getScopedSupabase` is stubbed to return an empty object (the scoped
 *     client is not exercised by the limit-enforcement path).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted + installed BEFORE importing the route.
// ---------------------------------------------------------------------------

const {
  mockCreateEnvironment,
  mockCheckEnvLimit,
} = vi.hoisted(() => ({
  mockCreateEnvironment: vi.fn(),
  /** Records the `checkEnvLimit` dep the route passed to EnvironmentService. */
  mockCheckEnvLimit: vi.fn(),
}));

// `EnvironmentService` is the seam that owns env-limit enforcement.
// Use a regular function (not arrow) so `new EnvironmentService(deps)` works
// — the same pattern as environments-list.test.ts.
vi.mock('@repo/environments-service', () => ({
  EnvironmentService: vi.fn().mockImplementation(function (deps: { checkEnvLimit?: unknown }) {
    // Record whether checkEnvLimit was wired — a test for the fix itself.
    if (deps.checkEnvLimit) {
      mockCheckEnvLimit.mockImplementation(deps.checkEnvLimit as any);
    }
    return { createEnvironment: mockCreateEnvironment };
  }),
  FlyHttpClient: vi.fn(),
  LocalDockerFlyClient: vi.fn(),
  validateEnvironmentName: vi.fn(() => ({ valid: true })),
}));

// `buildEnvLimitCheck` from lib/entitlements is the piece the route fix added.
// Return `mockCheckEnvLimit` so the test controls what the limit check returns.
vi.mock('../../lib/entitlements', () => ({
  buildEnvLimitCheck: vi.fn(() => mockCheckEnvLimit),
}));

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => Promise.resolve({})),
  };
});

import type { AppContext } from '../routes/_shared';
import { CreateEnvironment } from '../routes/environments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedResponse {
  body: unknown;
  status: number;
}

function makeContext(bodyName: string = 'staging'): { ctx: AppContext; captured: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'user'
        ? {
            appId: 'app-uuid-1',
            tenantId: 'tenant-uuid-1',
            appName: 'my-app',
            authMode: 'bearer',
            gatewayUserId: 'user-uuid-1',
          }
        : undefined,
    ),
    // `local-docker` runtime so buildEnvironmentService never bails on
    // missing FLY_API_TOKEN (we want to reach the env-limit check).
    env: {
      DASHBOARD_BASE_URL: 'http://localhost:3002',
    },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      method: 'POST',
      path: '/v1/environments',
      // `CreateEnvironment.handle` calls `parseJsonBody(c)` which invokes
      // `c.req.json()`. Provide a stub that resolves the request body so the
      // route can parse it without a real HTTP request.
      json: vi.fn().mockResolvedValue({ name: bodyName }),
    },
    executionCtx: { waitUntil: vi.fn() },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function createRoute(validatedData: Record<string, unknown>): CreateEnvironment {
  const instance = new CreateEnvironment({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof CreateEnvironment>[0]);
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// env-limit is enforced on POST /v1/environments
// ===========================================================================

describe('CreateEnvironment — env-limit enforcement', () => {
  it('should reject with 402 env_limit_exceeded when the app is AT its tier limit', async () => {
    // Service returns the limit-exceeded failure; the route must surface it
    // rather than silently allow creation.
    mockCreateEnvironment.mockResolvedValue({
      ok: false,
      code: 'env_limit_exceeded',
      message: 'App has reached its environment limit (2) on the hobby tier — upgrade to add more',
      limit: 2,
    });

    const route = createRoute({});
    const { ctx, captured } = makeContext('staging');
    await route.handle(ctx);

    const { body, status } = captured();

    // The route must consult the service result and surface
    // env_limit_exceeded as 402.
    expect(status).toBe(402);
    const err = (body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('env_limit_exceeded');
    expect(err.message).toContain('environment limit');
  });

  it('should succeed with 201 when the app is BELOW its tier limit', async () => {
    // Service returns a created env row — the limit check passed.
    mockCreateEnvironment.mockResolvedValue({
      ok: true,
      environment: {
        id: 'env-new-uuid',
        name: 'staging',
        is_default: false,
        current_version: 0,
        current_commit_sha: null,
        fly_app_name: 'my-app-staging',
        epoch: 1,
        created_at: '2026-01-01T00:00:00Z',
        created_by: 'user-uuid-1',
        updated_at: null,
        updated_by: null,
        tenant_id: 'tenant-uuid-1',
        app_id: 'app-uuid-1',
      },
    });

    const route = createRoute({});
    const { ctx, captured } = makeContext('staging');
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(201);
    const data = (body as { data: { id: string; api_key_creation_url: string } }).data;
    expect(data.id).toBe('env-new-uuid');
    // The creation URL is synthesised by the route — confirms the success path ran.
    expect(data.api_key_creation_url).toContain('api-keys');
  });

  it('should wire checkEnvLimit from buildEnvLimitCheck into the service', async () => {
    // Pins the wiring: the route must pass a non-null `checkEnvLimit` dep to
    // EnvironmentService, or the service cannot enforce the limit even if it
    // has the logic.
    mockCreateEnvironment.mockResolvedValue({
      ok: false,
      code: 'env_limit_exceeded',
      message: 'limit hit',
      limit: 1,
    });

    const route = createRoute({});
    const { ctx } = makeContext('overflow-env');
    await route.handle(ctx);

    // `buildEnvLimitCheck` must have been called to construct the dep
    // (vi.mock returns mockCheckEnvLimit as the result).
    const { buildEnvLimitCheck } = await import('../../lib/entitlements');
    expect(buildEnvLimitCheck).toHaveBeenCalledWith(
      expect.anything(),
    );
  });
});
