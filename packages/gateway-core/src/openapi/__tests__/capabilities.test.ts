/**
 * Route handler tests for GET /v1/capabilities.
 *
 * Verifies the `endpoints` map is derived from the route registry rather
 * than hand-maintained: a capability is `true` iff at least one route
 * under its prefix is registered, with `traces`/`datasets` pinned false
 * (nothing is registered under either).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetRegisteredRoutePaths } = vi.hoisted(() => ({
  mockGetRegisteredRoutePaths: vi.fn<() => readonly string[]>(),
}));

vi.mock('../../lib/permissions', () => ({
  getRegisteredRoutePaths: mockGetRegisteredRoutePaths,
}));

// ---------------------------------------------------------------------------
// Import route class (after mocks are hoisted)
// ---------------------------------------------------------------------------

import { GetCapabilities } from '../routes/capabilities';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedResponse {
  body: unknown;
  status: number;
}

function createMockContext(): { ctx: AppContext; getResponse: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };

  const ctx = {
    req: { url: 'https://gateway.example.com/v1/capabilities' },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
  } as unknown as AppContext;

  return { ctx, getResponse: () => captured };
}

function createRouteInstance(): GetCapabilities {
  const instance = new (GetCapabilities as unknown as new (opts: unknown) => GetCapabilities)({
    router: {},
    raiseUnknownParameters: false,
    route: '/v1/capabilities',
    urlParams: [],
  });
  (instance as unknown as { getValidatedData: ReturnType<typeof vi.fn> }).getValidatedData =
    vi.fn().mockResolvedValue({});
  return instance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GetCapabilities handler', () => {
  it('derives the exact endpoints map from registered route paths', async () => {
    mockGetRegisteredRoutePaths.mockReturnValue([
      '/v1/spans',
      '/v1/spans/:spanId',
      '/v1/spans/search',
      '/v1/blobs',
      '/v1/scores',
      '/v1/scores/:scoreId',
      '/v1/api-keys',
    ]);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(body).toEqual({
      target: 'cloud',
      url: 'https://gateway.example.com',
      endpoints: {
        traces: false,
        spans: true,
        sessions: false,
        scores: true,
        score_analytics: true,
        metrics: false,
        experiments: false,
        datasets: false,
        prompts: false,
        runs: false,
        topics: false,
      },
    });
  });

  it('reports sessions, metrics, and topics true once routes exist under their prefixes', async () => {
    mockGetRegisteredRoutePaths.mockReturnValue([
      '/v1/sessions',
      '/v1/sessions/:traceId',
      '/v1/metrics/models',
      '/v1/metrics/overview',
      '/v1/topics',
    ]);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body } = getResponse();
    expect(body).toEqual({
      target: 'cloud',
      url: 'https://gateway.example.com',
      endpoints: {
        traces: false,
        spans: false,
        sessions: true,
        scores: false,
        score_analytics: true,
        metrics: true,
        experiments: false,
        datasets: false,
        prompts: false,
        runs: false,
        topics: true,
      },
    });
  });

  it('reports every derived capability false when no matching routes are registered', async () => {
    mockGetRegisteredRoutePaths.mockReturnValue(['/v1/api-keys', '/v1/pricing']);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body } = getResponse();
    expect(body).toEqual({
      target: 'cloud',
      url: 'https://gateway.example.com',
      endpoints: {
        traces: false,
        spans: false,
        sessions: false,
        scores: false,
        score_analytics: true,
        metrics: false,
        experiments: false,
        datasets: false,
        prompts: false,
        runs: false,
        topics: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Schema documentation test
// ---------------------------------------------------------------------------

describe('GetCapabilities OpenAPI schema', () => {
  it('declares Capabilities tag and public (no auth) characteristics', () => {
    const route = createRouteInstance();
    const schema = route.schema as {
      tags: string[];
      security: unknown[];
      responses: Record<string, unknown>;
    };

    expect(schema.tags).toContain('Capabilities');
    expect(schema.security).toEqual([]);
    expect(schema.responses).toHaveProperty('200');
  });
});
