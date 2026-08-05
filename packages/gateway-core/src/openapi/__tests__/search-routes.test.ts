/**
 * In-process unit tests for the structured-search handlers:
 * POST /v1/spans/search, POST /v1/scores/search,
 *
 * Pins the handler behavior the registration/envelope tests
 * can't see: JSON filters are validated + normalized BEFORE any service or
 * ClickHouse call (400 with `invalid_filter`, never a query), the resolved
 * time window is applied, and responses use the same wire mapping as the
 * GET twins. Pattern mirrors spans-routes.test.ts (mocked ClickHouse) and
 * the service-mocking routes tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifiedAppId } from '@repo/observability-service';
import { createClient } from '@clickhouse/client-web';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    close: mockClose,
  })),
}));

const mockGetScores = vi.fn();

vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => ({
    getScores: mockGetScores,
  })),
}));

import { SearchSpans } from '../routes/spans';
import { SearchScores } from '../routes/scores';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_APP_ID = createVerifiedAppId('app-test-123');
const TEST_TENANT_ID = 'tenant-test-456';

interface CapturedResponse {
  body: unknown;
  status: number;
}

function createMockContext(): { ctx: AppContext; getResponse: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };

  const ctx = {
    // No `apiKeyId` on the user → resolveEnvScope short-circuits to undefined
    // (no env filter, no Supabase call).
    get: vi.fn((key: string) =>
      key === 'user'
        ? { appId: TEST_APP_ID, tenantId: TEST_TENANT_ID, appName: 'Test App' }
        : undefined,
    ),
    env: { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'test' },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      method: 'POST',
      path: '/v1/test',
      url: 'http://localhost/v1/test',
      header: vi.fn(() => undefined),
      param: vi.fn(() => undefined),
    },
  } as unknown as AppContext;

  return { ctx, getResponse: () => captured };
}

function createRouteInstance<T extends new (opts: never) => unknown>(
  RouteClass: T,
  body: Record<string, unknown>,
): { handle: (c: AppContext) => Promise<unknown> } {
  const instance = new (RouteClass as unknown as new (opts: unknown) => {
    getValidatedData: unknown;
    handle: (c: AppContext) => Promise<unknown>;
  })({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  });
  // Body defaults that Zod would apply (limit/offset) — tests pass them in.
  instance.getValidatedData = vi.fn().mockResolvedValue({ body: { limit: 50, offset: 0, ...body } });
  return instance;
}

const WINDOW = { start_date: '2026-06-01T00:00:00.000Z', end_date: '2026-06-08T00:00:00.000Z' };

beforeEach(() => {
  mockQuery.mockReset();
  mockClose.mockClear();
  mockGetScores.mockReset();
});

// ---------------------------------------------------------------------------
// POST /v1/spans/search
// ---------------------------------------------------------------------------

describe('SearchSpans', () => {
  it('compiles filters into the WHERE clause with bound params and the window', async () => {
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) }) // list
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '0' }]) }); // count

    const route = createRouteInstance(SearchSpans, {
      ...WINDOW,
      filters: [
        { field: 'latency_ms', operator: 'between', value: [1000, 5000] },
      ],
    });
    const { ctx, getResponse } = createMockContext();
    await route.handle(ctx);

    // The ClickHouse client config and query settings are asserted because
    // the password fallback and the 30s server-side timeout protect shared
    // infrastructure from an unbounded query.
    expect(vi.mocked(createClient)).toHaveBeenCalledWith({
      url: 'http://localhost:8123',
      password: 'test',
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const listCall = mockQuery.mock.calls[0]![0] as {
      query: string;
      query_params: Record<string, unknown>;
      clickhouse_settings: Record<string, unknown>;
    };
    expect(listCall.clickhouse_settings).toEqual({ max_execution_time: 30 });
    // The WHERE prefix is pinned verbatim: tenant scoping, app scoping, and
    // the resolved window must appear contiguously (a stray empty condition
    // or a dropped base condition both break this).
    expect(listCall.query).toContain(
      'WHERE TenantId = {tenantId:String} AND AppId = {appId:String} ' +
        'AND Timestamp >= {startDate:DateTime64} AND Timestamp <= {endDate:DateTime64} ' +
        'AND Duration BETWEEN {filter_0:Float64} AND {filter_1:Float64}',
    );
    expect(listCall.query_params).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT_ID,
        appId: TEST_APP_ID,
        filter_0: 1000,
        filter_1: 5000,
        startDate: '2026-06-01 00:00:00.000',
        endDate: '2026-06-08 00:00:00.000',
      }),
    );
    // No raw values in SQL — everything is bound.
    expect(listCall.query).not.toContain('1000');

    expect(getResponse().status).toBe(200);
    expect(getResponse().body).toEqual({
      data: [],
      pagination: { total: 0, limit: 50, offset: 0 },
    });
  });

  it('returns total 0 when the count query yields no rows (empty-store path)', async () => {
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) }) // list
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) }); // count: NO rows at all

    const route = createRouteInstance(SearchSpans, { ...WINDOW });
    const { ctx, getResponse } = createMockContext();
    await route.handle(ctx);

    expect(getResponse().status).toBe(200);
    expect(getResponse().body).toEqual({
      data: [],
      pagination: { total: 0, limit: 50, offset: 0 },
    });
  });

  it('rejects a DSL-only/invalid operator combination with 400 and no query', async () => {
    const route = createRouteInstance(SearchSpans, {
      filters: [{ field: 'status', operator: 'between', value: ['OK', 'ERROR'] }],
    });
    const { ctx, getResponse } = createMockContext();
    await route.handle(ctx);

    expect(getResponse().status).toBe(400);
    expect(getResponse().body).toEqual({
      error: expect.objectContaining({
        code: 'invalid_filter',
        message: expect.stringContaining('not valid for status field'),
      }),
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/scores/search
// ---------------------------------------------------------------------------

describe('SearchScores', () => {
  it('passes normalized scores filters (datetimes in ClickHouse format) to getScores', async () => {
    mockGetScores.mockResolvedValue({ scores: [], total: 0, limit: 50, offset: 0 });

    const route = createRouteInstance(SearchScores, {
      ...WINDOW,
      filters: [
        { field: 'name', operator: 'equals', value: 'correctness' },
        { field: 'score', operator: 'between', value: [0.5, 0.9] },
        { field: 'created_at', operator: 'gte', value: '2026-06-02T00:00:00.000Z' },
      ],
    });
    const { ctx, getResponse } = createMockContext();
    await route.handle(ctx);

    expect(mockGetScores).toHaveBeenCalledWith(
      expect.objectContaining({ appId: TEST_APP_ID, tenantId: TEST_TENANT_ID }),
      expect.objectContaining({
        startDate: WINDOW.start_date,
        endDate: WINDOW.end_date,
        filters: [
          { field: 'name', operator: 'equals', value: 'correctness' },
          { field: 'score', operator: 'between', value: ['0.5', '0.9'] },
          { field: 'created_at', operator: 'gte', value: '2026-06-02 00:00:00.000' },
        ],
      }),
    );
    expect(getResponse().body).toEqual({
      data: [],
      pagination: { total: 0, limit: 50, offset: 0 },
    });
  });

  it('rejects trace-side fields with 400 and no service call', async () => {
    const route = createRouteInstance(SearchScores, {
      filters: [{ field: 'model', operator: 'equals', value: 'gpt-4o' }],
    });
    const { ctx, getResponse } = createMockContext();
    await route.handle(ctx);

    expect(getResponse().status).toBe(400);
    expect((getResponse().body as { error: { message: string } }).error.message).toContain(
      'Unknown scores filter field',
    );
    expect(mockGetScores).not.toHaveBeenCalled();
  });
});
