/**
 * Unit tests for `ListEnvironments` (GET /v1/environments).
 *
 * Two invariants are pinned here:
 *
 *   1. A genuine service failure MUST surface as HTTP 500, not as a 200 with
 *      `data: []` — a caught-and-swallowed error is indistinguishable from
 *      "app has no environments", which would make the dashboard redirect
 *      users off valid environments.
 *
 *   2. Pagination MUST be pushed into the service (`limit`/`offset`) and the
 *      returned `total` MUST be the exact row count — not the length of the
 *      current page. Fetching ALL rows and `.slice()`ing in JS makes `total`
 *      correct only by accident and breaks under `.range`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — installed BEFORE importing the route so it picks them up.
// ---------------------------------------------------------------------------

const { mockListEnvironments } = vi.hoisted(() => ({
  mockListEnvironments: vi.fn(),
}));

// The route does `new EnvironmentService({...})` then `.listEnvironments(...)`.
// Mock the package so the service is a controllable stub; the other exports
// (FlyHttpClient, etc.) are referenced only by routes not under test here, so
// minimal stand-ins are enough.
//
// Arrow functions cannot be invoked with `new` — use a regular function
// expression so the route's `new EnvironmentService(...)` works through this
// mock (same trap the api-keys test documents for `new Unkey(...)`).
vi.mock('@repo/environments-service', () => ({
  EnvironmentService: vi.fn().mockImplementation(function () {
    return { listEnvironments: mockListEnvironments };
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
import { ListEnvironments } from '../routes/environments';

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
    req: { method: 'GET', path: '/v1/environments' },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function createRoute(validatedData: Record<string, unknown>): ListEnvironments {
  const instance = new ListEnvironments({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof ListEnvironments>[0]);
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

function makeEnvRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `env-${id}`,
    is_default: false,
    current_version: 0,
    current_commit_sha: null,
    fly_app_name: null,
    epoch: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Fix #1 — error propagation
// ===========================================================================

describe('ListEnvironments — service-error handling', () => {
  it('returns 500 (NOT 200 + empty list) when the service throws', async () => {
    mockListEnvironments.mockRejectedValue(
      new Error('listEnvironments(app-uuid-1) failed: connection reset'),
    );

    const route = createRoute({ query: { limit: 25, offset: 0 } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    const { body, status } = captured();
    // A swallowed error must not become 200 + `data: []` — indistinguishable
    // from a genuinely empty app, which would redirect the dashboard off a
    // valid environment. It must surface as a canonical 500 error envelope.
    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe(
      'internal_error',
    );
  });

  it('returns 200 + empty list when the service returns [] without throwing', async () => {
    // The ONLY legitimate empty result: the service resolved cleanly with
    // zero rows. This MUST still be a 200.
    mockListEnvironments.mockResolvedValue({ rows: [], total: 0 });

    const route = createRoute({ query: { limit: 25, offset: 0 } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toEqual([]);
    expect((body as { pagination: { total: number } }).pagination.total).toBe(0);
  });
});

// ===========================================================================
// Fix #2 — pagination is pushed into the service, total is exact
// ===========================================================================

describe('ListEnvironments — pagination', () => {
  it('passes limit/offset to the service and returns the real total for offset > 0', async () => {
    // Page 2 of a 7-row result: the service returns the 2-row page plus the
    // exact total (7), which the handler must surface verbatim — NOT the
    // page length (2).
    mockListEnvironments.mockResolvedValue({
      rows: [makeEnvRow('row-3'), makeEnvRow('row-4')],
      total: 7,
    });

    const route = createRoute({ query: { limit: 2, offset: 2 } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);

    // The handler must delegate paging to the service — not slice in JS.
    expect(mockListEnvironments).toHaveBeenCalledWith('app-uuid-1', {
      limit: 2,
      offset: 2,
    });

    const b = body as {
      data: unknown[];
      pagination: { total: number; limit: number; offset: number };
    };
    expect(b.data).toHaveLength(2);
    expect((b.data[0] as { id: string }).id).toBe('row-3');
    // total is the exact row count, not the current page length.
    expect(b.pagination).toEqual({ total: 7, limit: 2, offset: 2 });
  });

  it('returns 200 + empty data + real total when offset is past the end of the result set', async () => {
    // An offset past the end of the result set must not 500. The service
    // swallows PostgREST's PGRST103 ("Requested range not satisfiable") and
    // re-queries head-only to recover the count; the route surfaces a
    // 200 + empty data + the real total — matching REST pagination
    // convention and the OpenAPI contract.
    mockListEnvironments.mockResolvedValue({ rows: [], total: 1 });

    const route = createRoute({ query: { limit: 25, offset: 2 } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);

    const b = body as {
      data: unknown[];
      pagination: { total: number; limit: number; offset: number };
    };
    expect(b.data).toEqual([]);
    // total reflects the underlying row count — NOT the page length and NOT 0.
    expect(b.pagination).toEqual({ total: 1, limit: 25, offset: 2 });
  });
});
