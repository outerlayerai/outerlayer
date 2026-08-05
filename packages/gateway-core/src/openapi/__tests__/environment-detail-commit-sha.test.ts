/**
 * Regression tests for `GetEnvironment` (GET /v1/environments/:id) — the
 * `current_commit_sha` wire field.
 *
 * The bug class: if the env wire shape carries no pinned-commit field, the
 * dashboard's pinned-env chip renders "commit: unknown" with no other symptom.
 * `current_commit_sha` is a denormalized column on `environment`, advanced by
 * `advanceCommitPointers` on git link/push/resync, and the route projects it
 * straight through onto the wire shape (no join).
 *
 * These tests lock the contract:
 *   1. A pinned env (`current_commit_sha` populated) returns the real SHA.
 *   2. An unpinned env (`current_commit_sha` null) returns
 *      `current_commit_sha: null` — never `undefined`, never "unknown".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — installed BEFORE importing the route so it picks them up.
// ---------------------------------------------------------------------------

const { mockGetEnvironment, mockComputeCascade, mockGetInFlightSaga } =
  vi.hoisted(() => ({
    mockGetEnvironment: vi.fn(),
    mockComputeCascade: vi.fn(),
    mockGetInFlightSaga: vi.fn(),
  }));

// The route does `new EnvironmentService({...})` then calls `.getEnvironment`,
// `.computeCascade` and `.getInFlightSaga`. A regular function expression is
// required so the route's `new EnvironmentService(...)` works through the mock.
vi.mock('@repo/environments-service', () => ({
  EnvironmentService: vi.fn().mockImplementation(function () {
    return {
      getEnvironment: mockGetEnvironment,
      computeCascade: mockComputeCascade,
      getInFlightSaga: mockGetInFlightSaga,
    };
  }),
  FlyHttpClient: vi.fn(),
  LocalDockerFlyClient: vi.fn(),
  validateEnvironmentName: vi.fn(() => ({ valid: true })),
}));

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => Promise.resolve({})),
  };
});

import type { AppContext } from '../routes/_shared';
import { GetEnvironment } from '../routes/environments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedResponse {
  body: unknown;
  status: number;
}

function makeContext(): { ctx: AppContext; captured: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'user'
        ? { appId: 'app-uuid-1', tenantId: 'tenant-uuid-1' }
        : undefined,
    ),
    env: {},
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: { method: 'GET', path: '/v1/environments/env-1' },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function createRoute(validatedData: Record<string, unknown>): GetEnvironment {
  const instance = new GetEnvironment({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof GetEnvironment>[0]);
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

/** A flattened `environment` row as the shared service returns it. */
function makeServiceEnv(overrides: Record<string, unknown> = {}) {
  return {
    id: 'env-uuid-1',
    tenant_id: 'tenant-uuid-1',
    app_id: 'app-uuid-1',
    name: 'staging',
    is_default: false,
    current_version: 0,
    current_commit_sha: null,
    fly_app_name: null,
    epoch: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: null,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

const EMPTY_CASCADE = {
  api_keys_revoked: 0,
  alerts_deleted: 0,
  deployments_deleted: 0,
  snapshot_rows_deleted: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeCascade.mockResolvedValue(EMPTY_CASCADE);
  mockGetInFlightSaga.mockResolvedValue(null);
});

// ===========================================================================
// current_commit_sha regression coverage
// ===========================================================================

describe('GetEnvironment — current_commit_sha', () => {
  it('returns the real commit SHA for a pinned env', async () => {
    const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    mockGetEnvironment.mockResolvedValue(
      makeServiceEnv({
        current_version: 3,
        current_commit_sha: sha,
      }),
    );

    const route = createRoute({ params: { id: 'env-uuid-1' } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect((body as { data: { current_commit_sha: string } }).data
      .current_commit_sha).toBe(sha);
  });

  it('returns current_commit_sha: null (not undefined) for an unpinned env', async () => {
    // A never-deployed env has no pinned deployment — the field must be an
    // explicit null so the dashboard chip renders no link rather than crashing
    // or showing "unknown".
    mockGetEnvironment.mockResolvedValue(
      makeServiceEnv({ current_version: 0, current_commit_sha: null }),
    );

    const route = createRoute({ params: { id: 'env-uuid-1' } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.current_commit_sha).toBeNull();
    expect('current_commit_sha' in data).toBe(true);
  });
});
