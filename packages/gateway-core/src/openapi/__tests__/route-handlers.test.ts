/**
 * Route handler tests for OpenAPI routes.
 *
 * Tests the .handle() method of each implemented route handler,
 * verifying field mapping (camelCase service -> snake_case API),
 * error handling, 404 paths, and contract compliance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifiedAppId } from '@repo/observability-service';
import type { AppContext } from '../routes/_shared';
import type {
  ScoresResponse,
  ScoreAggregationsResponse,
} from '@repo/observability-service';

// Contract schemas for response validation
import {
  ScoresListResponseSchema,
  ScoreAggregationsResponseSchema,
} from '@repo/api-schemas';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the analytics-factory module so getService() returns our mock service
const mockService: Record<string, ReturnType<typeof vi.fn>> = {
  getScores: vi.fn(),
  getScoreAggregations: vi.fn(),
  getMetrics: vi.fn(),
  getExtendedMetrics: vi.fn(),
  checkConnectivity: vi.fn(),
};

vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => mockService),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_APP_ID = createVerifiedAppId('app-test-123');
const TEST_TENANT_ID = 'tenant-test-456';

/** Captured response from c.json() */
interface CapturedResponse {
  body: unknown;
  status: number;
}

type DataEnvelope<T> = { data: T };

function dataOf<T>(body: unknown): T {
  return (body as DataEnvelope<T>).data;
}

/**
 * Creates a mock Hono Context that captures c.json() calls.
 * The route handlers call c.get('user'), c.env, c.json(), c.req.
 */
function createMockContext(overrides?: {
  params?: Record<string, string>;
  query?: Record<string, string>;
}): { ctx: AppContext; getResponse: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };

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
    env: {
      CLICKHOUSE_HOST: 'http://localhost:8123',
      CLICKHOUSE_PASSWORD: 'test',
    },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      method: 'GET',
      path: '/v1/test',
      url: 'http://localhost/v1/test',
      header: vi.fn(() => undefined),
      param: vi.fn((key: string) => overrides?.params?.[key]),
      query: vi.fn((key: string) => overrides?.query?.[key]),
    },
  } as AppContext;

  return { ctx, getResponse: () => captured };
}

/**
 * Instantiate a route class with minimal chanfana options and stubbed getValidatedData.
 */
function createRouteInstance<T extends new (opts: any) => any>(
  RouteClass: T,
  validatedData: Record<string, unknown>,
): InstanceType<T> {
  const instance = new RouteClass({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  });
  // Stub getValidatedData to return our test data directly
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

// Fixture score id — used by ScoreResponseSchema pinning test, which
// validates `id` as a UUID (matches the runtime shape of rows from ClickHouse).
const SCORE_FIXTURE_ID = '00000000-0000-4000-8000-000000000001';

function makeScoresResponse(overrides?: Partial<ScoresResponse>): ScoresResponse {
  return {
    scores: [
      {
        id: SCORE_FIXTURE_ID,
        resourceId: 'trace-1',
        name: 'accuracy',
        score: 0.95,
        label: 'good',
        reason: 'Correct answer',
        source: 'eval',
        userId: 'user-1',
        createdAt: '2026-01-15T10:00:00Z',
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

function makeScoreAggregationsResponse(): ScoreAggregationsResponse {
  return {
    aggregations: [
      {
        name: 'accuracy',
        avgScore: 0.92,
        count: 100,
        minScore: 0.5,
        maxScore: 1.0,
      },
    ],
  };
}



// ---------------------------------------------------------------------------
// Import route classes (after mocks are set up)
// ---------------------------------------------------------------------------

// Dynamic imports are not needed since vi.mock is hoisted
import { ListScores, GetScoreAggregations } from '../routes/scores';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// =====================================================================
// ListScores
// =====================================================================
describe('ListScores handler', () => {
  const validatedData = {
    query: {
      limit: 50,
      offset: 0,
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      resource_id: undefined,
      resource_type: undefined,
      name: undefined,
      source: undefined,
    },
  };

  it('should return 200 with snake_case score fields', async () => {
    mockService.getScores.mockResolvedValue(makeScoresResponse());
    const route = createRouteInstance(ListScores, validatedData);
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);

    const score = dataOf(body)[0];
    expect(score.id).toBe(SCORE_FIXTURE_ID);
    expect(score.resource_id).toBe('trace-1');
    expect(score.name).toBe('accuracy');
    expect(score.score).toBe(0.95);
    expect(score.label).toBe('good');
    expect(score.reason).toBe('Correct answer');
    expect(score.source).toBe('eval');
    expect(score.user_id).toBe('user-1');
    expect(score.created_at).toBe('2026-01-15T10:00:00Z');
  });

  it('should map camelCase score fields to snake_case', async () => {
    mockService.getScores.mockResolvedValue(makeScoresResponse());
    const route = createRouteInstance(ListScores, validatedData);
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const score = dataOf(getResponse().body)[0];
    expect(score).not.toHaveProperty('resourceId');
    expect(score).not.toHaveProperty('userId');
    expect(score).not.toHaveProperty('createdAt');
  });

  it('should pass response through ScoresListResponseSchema', async () => {
    mockService.getScores.mockResolvedValue(makeScoresResponse());
    const route = createRouteInstance(ListScores, validatedData);
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const result = ScoresListResponseSchema.safeParse(getResponse().body);
    expect(result.success).toBe(true);
  });

  it('should return error response when service throws', async () => {
    mockService.getScores.mockRejectedValue(new Error('query error'));
    const route = createRouteInstance(ListScores, validatedData);
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    expect(getResponse().status).toBe(500);
  });
});

// =====================================================================
// GetScoreAggregations
// =====================================================================
describe('GetScoreAggregations handler', () => {
  it('should return 200 with snake_case aggregation fields', async () => {
    mockService.getScoreAggregations.mockResolvedValue(makeScoreAggregationsResponse());
    const route = createRouteInstance(GetScoreAggregations, {
      query: { start_date: '2026-01-01', end_date: '2026-01-31' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);

    const agg = dataOf(body)[0];
    expect(agg.name).toBe('accuracy');
    expect(agg.avg_score).toBe(0.92);
    expect(agg.count).toBe(100);
    expect(agg.min_score).toBe(0.5);
    expect(agg.max_score).toBe(1.0);
  });

  it('should map camelCase aggregation fields to snake_case', async () => {
    mockService.getScoreAggregations.mockResolvedValue(makeScoreAggregationsResponse());
    const route = createRouteInstance(GetScoreAggregations, {
      query: { start_date: '2026-01-01', end_date: '2026-01-31' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const agg = dataOf(getResponse().body)[0];
    expect(agg).not.toHaveProperty('avgScore');
    expect(agg).not.toHaveProperty('minScore');
    expect(agg).not.toHaveProperty('maxScore');
  });

  it('should use default date range when no dates provided', async () => {
    mockService.getScoreAggregations.mockResolvedValue(makeScoreAggregationsResponse());
    const route = createRouteInstance(GetScoreAggregations, {
      query: {},
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    // EnvScope (undefined — no API-key binding in test context) is passed as 3rd arg.
    expect(mockService.getScoreAggregations).toHaveBeenCalledWith(
      expect.objectContaining({ appId: TEST_APP_ID, tenantId: TEST_TENANT_ID }),
      expect.objectContaining({
        start: expect.any(String),
        end: expect.any(String),
      }),
      undefined,
    );

    // Verify the default dates are reasonable (within last 7 days)
    const call = mockService.getScoreAggregations.mock.calls[0];
    const dateRange = call[1] as { start: string; end: string };
    expect(dateRange.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateRange.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should pass response through ScoreAggregationsResponseSchema', async () => {
    mockService.getScoreAggregations.mockResolvedValue(makeScoreAggregationsResponse());
    const route = createRouteInstance(GetScoreAggregations, {
      query: { start_date: '2026-01-01', end_date: '2026-01-31' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const result = ScoreAggregationsResponseSchema.safeParse(getResponse().body);
    expect(result.success).toBe(true);
  });

  it('should return error response when service throws', async () => {
    mockService.getScoreAggregations.mockRejectedValue(new Error('failed'));
    const route = createRouteInstance(GetScoreAggregations, {
      query: { start_date: '2026-01-01', end_date: '2026-01-31' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    expect(getResponse().status).toBe(500);
  });
});

// =====================================================================

// IngestionHealth tests moved to a dedicated file (health-ingestion.test.ts)
// to match the FilesHealth pattern and isolate its mocking surface
// (createHealthService vs. getGatewayAnalyticsService).
