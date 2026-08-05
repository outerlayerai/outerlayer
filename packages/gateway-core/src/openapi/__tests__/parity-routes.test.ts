/**
 * Parity route handler tests for OpenAPI routes.
 *
 * Tests the .handle() method of key OpenAPI route handlers that were implemented
 * for API parity and dataset curation.
 *
 * These routes use different data-access patterns:
 * - GetScoreNames: analytics service via getService(c)
 * - ListSpans / GetScore: direct ClickHouse client via @clickhouse/client-web
 *
 * (ListDatasets / AppendDatasetRow / GetConfig route + tests removed —
 * `../routes/datasets` and `../routes/config` were already deleted; this
 * file's imports of them were the only thing keeping the dead code
 * discoverable.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifiedAppId } from '@repo/observability-service';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Analytics service mock (used by GetScoreNames)
const mockGetDistinctScoreNames = vi.fn();
const mockService = {
  getDistinctScoreNames: mockGetDistinctScoreNames,
};

vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => mockService),
}));

// ClickHouse client mock (used by ListSpans / GetScore)
const mockQuery = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    insert: vi.fn(),
    command: vi.fn(),
    close: mockClose,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { GetScoreNames, GetScore } from '../routes/scores';
import { ListSpans } from '../routes/spans';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_APP_ID = createVerifiedAppId('app-test-123');
const TEST_TENANT_ID = 'tenant-test-456';

interface CapturedResponse {
  body: unknown;
  status: number;
}

type DataEnvelope<T> = { data: T };
type PaginatedEnvelope = { pagination: { total: number; limit: number; offset: number } };
type ErrorEnvelopeBody = { error: { code: string; message: string } };

function dataOf<T>(body: unknown): T {
  return (body as DataEnvelope<T>).data;
}

function paginationOf(body: unknown): PaginatedEnvelope['pagination'] {
  return (body as PaginatedEnvelope).pagination;
}

function errorOf(body: unknown): ErrorEnvelopeBody['error'] {
  return (body as ErrorEnvelopeBody).error;
}

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
      SUPABASE_API_BASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-key',
    },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    header: vi.fn(),
    req: {
      method: 'GET',
      path: '/v1/test',
      url: 'http://localhost/v1/test',
      header: vi.fn(() => undefined),
      param: vi.fn((key: string) => overrides?.params?.[key]),
      query: vi.fn((key: string) => overrides?.query?.[key]),
    },
  } as unknown as AppContext;

  return { ctx, getResponse: () => captured };
}

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
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// =====================================================================
// GetScoreNames
// =====================================================================
describe('GetScoreNames handler', () => {
  it('should return data array with score names from service', async () => {
    mockGetDistinctScoreNames.mockResolvedValue({
      names: ['accuracy', 'relevance'],
    });
    const route = createRouteInstance(GetScoreNames, {});
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(dataOf(body)).toEqual(['accuracy', 'relevance']);

    // Verify TenantContext (with tenantId) was passed to service, and envScope (undefined — no API-key binding in test context)
    expect(mockGetDistinctScoreNames).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TEST_TENANT_ID, appId: TEST_APP_ID }),
      undefined,
    );
  });

  it('should return 500 when service throws a ClickHouse error', async () => {
    mockGetDistinctScoreNames.mockRejectedValue(new Error('connection refused'));
    const route = createRouteInstance(GetScoreNames, {});
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { status } = getResponse();
    expect(status).toBe(500);
  });
});

// =====================================================================
// ListSpans
// =====================================================================
describe('ListSpans handler', () => {
  function mockClickHouseResults(rows: Array<Record<string, unknown>>, total: number) {
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rows) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: String(total) }]) });
  }

  it('should return paginated spans from ClickHouse', async () => {
    mockClickHouseResults(
      [
        {
          id: 'span-1',
          trace_id: 'trace-1',
          parent_id: '',
          name: 'llm-call',
          status_code: '1',
          status_message: '',
          duration: 150,
          timestamp: '2026-04-16T00:00:00.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: 100,
          output_tokens: 50,
          tokens: 150,
          cost: 0.002,
          span_kind: 'CLIENT',
          service_name: 'my-agent',
          metadata: {},
        },
      ],
      1,
    );
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0 },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    const spans = dataOf<Array<Record<string, unknown>>>(body);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.id).toBe('span-1');
    expect(spans[0]!.status).toBe('OK');
    expect(spans[0]!.model).toBe('gpt-4');
    expect(paginationOf(body)).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it('should return empty data when no spans match', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, type: 'EVENT' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(dataOf(body)).toEqual([]);
    expect(paginationOf(body).total).toBe(0);
  });

  it('should return 500 when ClickHouse query throws', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0 },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { status } = getResponse();
    expect(status).toBe(500);
  });

  // -----------------------------------------------------------------------
  // Filter clauses — each optional query param should bind a SQL clause
  // and matching query_param. Mutation testing showed ConditionalExpression
  // survivors here (L60-100 of spans.ts): the `if (query.X)` guards were
  // never exercised positively, so flipping them to `if (!query.X)` would
  // pass the existing tests.
  // -----------------------------------------------------------------------

  it('binds tenantId + appId from user context (mandatory tenant isolation)', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0 },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('TenantId = {tenantId:String}');
    expect(listCall.query).toContain('AppId = {appId:String}');
    expect(listCall.query_params.tenantId).toBe(TEST_TENANT_ID);
    expect(listCall.query_params.appId).toBe(TEST_APP_ID);
    // Both queries (list + count) must scope by tenant+app. A refactor
    // that dropped tenant isolation on the count query would silently
    // leak cross-tenant counts.
    const countCall = mockQuery.mock.calls[1]![0];
    expect(countCall.query).toContain('TenantId = {tenantId:String}');
    expect(countCall.query).toContain('AppId = {appId:String}');
  });

  it('defaults limit=50, offset=0 when query omits them', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: {},
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query_params.limit).toBe(50);
    expect(listCall.query_params.offset).toBe(0);
    expect(paginationOf(getResponse().body)).toEqual({ total: 0, limit: 50, offset: 0 });
  });

  it('passes explicit limit and offset through to query params + response', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 10, offset: 200 },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    expect(mockQuery.mock.calls[0]![0].query_params.limit).toBe(10);
    expect(mockQuery.mock.calls[0]![0].query_params.offset).toBe(200);
    expect(paginationOf(getResponse().body)).toEqual({ total: 0, limit: 10, offset: 200 });
  });

  it('trace_id filter binds TraceId clause and param', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, trace_id: 'trace-xyz' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('TraceId = {traceId:String}');
    expect(listCall.query_params.traceId).toBe('trace-xyz');
  });

  it('type filter binds Type clause and param', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, type: 'GENERATION' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Type = {type:String}');
    expect(listCall.query_params.type).toBe('GENERATION');
  });

  it('status=OK maps to StatusCode = 1 (numeric ClickHouse code, not the string "OK")', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, status: 'OK' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('StatusCode IN {statusCodes:Array(String)}');
    // mapStatusToCode('OK') → '1' (the canonical ClickHouse numeric code),
    // expanded to include the legacy stored variants so pre-normalization
    // rows still match. A refactor that bound the string 'OK' alone would
    // miss every numeric row.
    expect(listCall.query_params.statusCodes).toEqual(['1', 'STATUS_CODE_OK', 'OK', 'Ok']);
  });

  it('status=ERROR maps to the StatusCode error equivalence set', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, status: 'ERROR' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    expect(mockQuery.mock.calls[0]![0].query_params.statusCodes).toEqual(['2', 'STATUS_CODE_ERROR', 'ERROR', 'Error']);
  });

  it('name filter wraps with %LIKE% (substring match, not exact)', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, name: 'rag' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('SpanName LIKE {name:String}');
    expect(listCall.query_params.name).toBe('%rag%');
  });

  it('model filter wraps with %LIKE%', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, model: 'gpt-4' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Model LIKE {model:String}');
    expect(listCall.query_params.model).toBe('%gpt-4%');
  });

  it('min_duration=0 still binds the clause (!= null check, not truthy)', async () => {
    // The implementation uses `query.min_duration != null` — so the value
    // `0` is a valid filter. A refactor to `if (query.min_duration)` (truthy)
    // would silently drop the filter for min_duration=0, returning spans
    // shorter than 0 ms (none, but the contract is "all spans >= 0").
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, min_duration: 0 },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Duration >= {minDuration:Float64}');
    expect(listCall.query_params.minDuration).toBe(0);
  });

  it('max_duration filter binds Duration <= clause with the supplied value', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, max_duration: 5000 },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Duration <= {maxDuration:Float64}');
    expect(listCall.query_params.maxDuration).toBe(5000);
  });

  it('user_id and session_id filters bind their clauses (trace-grain attribution)', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, user_id: 'user-abc', session_id: 'sess-xyz' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('UserId = {userId:String}');
    expect(listCall.query).toContain('SessionId = {sessionId:String}');
    expect(listCall.query_params.userId).toBe('user-abc');
    expect(listCall.query_params.sessionId).toBe('sess-xyz');
  });

  // -----------------------------------------------------------------------
  // Time-window logic (lines 113-130 of spans.ts).
  // The contract:
  //   - With trace_id and no explicit dates: NO default time window
  //     (spec-052 backcompat — "all spans for this trace, regardless of age")
  //   - Without trace_id: apply default window when start/end unspecified
  //   - Explicit start_date / end_date: always honored
  // -----------------------------------------------------------------------

  it('no trace_id, no explicit dates: applies the default time window (both Timestamp >= and <= clauses)', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0 },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Timestamp >= {startDate:DateTime64}');
    expect(listCall.query).toContain('Timestamp <= {endDate:DateTime64}');
    expect(typeof listCall.query_params.startDate).toBe('string');
    expect(typeof listCall.query_params.endDate).toBe('string');
  });

  it('trace_id WITHOUT explicit dates: does NOT apply the default time window', async () => {
    // The most subtle contract in this handler. Mutants on
    // `applyDefaultWindow = !query.trace_id` survived because no test
    // exercises this "trace_id present, dates absent" branch.
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, trace_id: 'trace-1' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).not.toContain('Timestamp >= {startDate:DateTime64}');
    expect(listCall.query).not.toContain('Timestamp <= {endDate:DateTime64}');
    expect(listCall.query_params).not.toHaveProperty('startDate');
    expect(listCall.query_params).not.toHaveProperty('endDate');
  });

  it('trace_id WITH explicit start_date: applies the explicit start, still no default end window', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, trace_id: 'trace-1', start_date: '2026-01-15T00:00:00.000Z' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query).toContain('Timestamp >= {startDate:DateTime64}');
    expect(listCall.query_params.startDate).toBe('2026-01-15 00:00:00.000');
    // No end_date and trace_id present → no default end clause
    expect(listCall.query).not.toContain('Timestamp <= {endDate:DateTime64}');
    expect(listCall.query_params).not.toHaveProperty('endDate');
  });

  it('explicit end_date is converted via formatISOForClickHouse (T→space, drop Z)', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, end_date: '2026-02-15T23:59:59.999Z' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query_params.endDate).toBe('2026-02-15 23:59:59.999');
  });

  // -----------------------------------------------------------------------
  // Advanced filter string DSL. The handler compiles the expression to
  // AnalyticsFilter[] (see lib/trace-filter-dsl) and passes it to
  // buildFilterWhereClause; a malformed/unsupported filter is a 400 with no
  // query executed.
  // -----------------------------------------------------------------------

  it('advanced filter: a valid DSL expression passes through to buildFilterWhereClause', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, filter: 'model = "gpt-4o"' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    // buildFilterWhereClause produces an `AND ...` suffix referencing
    // filter_0 / filter_1 / ... bindings. If the filter compiled to an empty
    // array, no such binding would appear.
    expect(listCall.query_params).toHaveProperty('filter_0');
    expect(listCall.query_params.filter_0).toBe('gpt-4o');
  });

  it('advanced filter: a metadata.<key> predicate binds the key and value', async () => {
    mockClickHouseResults([], 0);
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, filter: 'metadata.env = "prod"' },
    });
    const { ctx } = createMockContext();

    await route.handle(ctx);

    const listCall = mockQuery.mock.calls[0]![0];
    expect(listCall.query_params.filter_key_1).toBe('env');
    expect(listCall.query_params.filter_0).toBe('prod');
  });

  it('advanced filter: a malformed expression returns 400 and runs no query', async () => {
    // No mockClickHouseResults: the handler 400s before querying, so queuing
    // mockResolvedValueOnce results would leak into the next test.
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, filter: '{not valid' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    expect(getResponse().status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('advanced filter: an unknown field returns 400 and runs no query', async () => {
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0, filter: 'bogus = "x"' },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    expect(getResponse().status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Response shape (lines 229-251). Many ObjectLiteral / ConditionalExpression
  // survivors here in the `(row.x as string) || null` / `Number(x) || 0`
  // fallbacks. One comprehensive toEqual kills all the field-mapping mutants.
  // -----------------------------------------------------------------------

  it('response shape: maps every ClickHouse column to its API field with the correct fallback', async () => {
    // A row with mostly populated fields — exercises the happy-path
    // branches of the `|| null` / `|| 0` / `|| ''` fallbacks.
    mockClickHouseResults(
      [
        {
          id: 'span-1',
          trace_id: 'trace-1',
          parent_id: 'parent-1',
          name: 'llm-call',
          status_code: '1',
          status_message: 'ok message',
          duration: 150,
          timestamp: '2026-04-16T00:00:00.000Z',
          type: 'GENERATION',
          model: 'gpt-4',
          input_tokens: 100,
          output_tokens: 50,
          tokens: 150,
          cost: 0.002,
          span_kind: 'CLIENT',
          service_name: 'my-agent',
          metadata: { env: 'prod' },
        },
      ],
      1,
    );
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0 },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const spans = dataOf<Array<Record<string, unknown>>>(getResponse().body);
    expect(spans).toEqual([
      {
        id: 'span-1',
        trace_id: 'trace-1',
        parent_id: 'parent-1',
        name: 'llm-call',
        status: 'OK',
        status_message: 'ok message',
        duration_ms: 150,
        timestamp: '2026-04-16T00:00:00.000Z',
        type: 'GENERATION',
        model: 'gpt-4',
        input_tokens: 100,
        output_tokens: 50,
        tokens: 150,
        cost: 0.002,
        span_kind: 'CLIENT',
        service_name: 'my-agent',
        metadata: { env: 'prod' },
      },
    ]);
  });

  it('response shape: empty-string row values collapse to the right falsy default per field', async () => {
    // The fallback chain is asymmetric on purpose:
    //   - parent_id → null (optional reference)
    //   - model → null (optional model field)
    //   - status_message, type, span_kind, service_name → ''
    //   - duration, tokens, cost → 0
    //   - metadata → {}
    // Catches a refactor that uniformly defaults to '' or null.
    mockClickHouseResults(
      [
        {
          id: 'span-empty',
          trace_id: 'trace-empty',
          parent_id: '',
          name: 'noop',
          status_code: '0',
          status_message: '',
          duration: '',
          timestamp: '2026-04-16T00:00:00.000Z',
          type: '',
          model: '',
          input_tokens: '',
          output_tokens: '',
          tokens: '',
          cost: '',
          span_kind: '',
          service_name: '',
          metadata: null,
        },
      ],
      1,
    );
    const route = createRouteInstance(ListSpans, {
      query: { limit: 50, offset: 0 },
    });
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const span = dataOf<Array<Record<string, unknown>>>(getResponse().body)[0]!;
    expect(span.parent_id).toBeNull();
    expect(span.model).toBeNull();
    expect(span.status_message).toBe('');
    expect(span.type).toBe('');
    expect(span.span_kind).toBe('');
    expect(span.service_name).toBe('');
    expect(span.duration_ms).toBe(0);
    expect(span.input_tokens).toBe(0);
    expect(span.output_tokens).toBe(0);
    expect(span.tokens).toBe(0);
    expect(span.cost).toBe(0);
    expect(span.metadata).toEqual({});
  });
});

// =====================================================================
// GetScore
// =====================================================================
describe('GetScore handler', () => {
  const validatedData = { params: { scoreId: 'score-abc-123' } };

  function mockClickHouseRows(rows: Array<Record<string, unknown>>) {
    mockQuery.mockResolvedValue({
      json: vi.fn().mockResolvedValue(rows),
    });
  }

  it('should return score data when found', async () => {
    mockClickHouseRows([
      {
        id: 'score-abc-123',
        resource_id: 'span-1',
        name: 'accuracy',
        score: 0.95,
        label: 'good',
        reason: 'High quality',
        source: 'eval',
        user_id: '',
        created_at: '2026-04-16T00:00:00.000Z',
      },
    ]);
    const route = createRouteInstance(GetScore, validatedData);
    const { ctx, getResponse } = createMockContext({ params: { scoreId: 'score-abc-123' } });

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    const score = dataOf<Record<string, unknown>>(body);
    expect(score.id).toBe('score-abc-123');
    expect(score.name).toBe('accuracy');
    expect(score.score).toBe(0.95);
    expect(score.resource_id).toBe('span-1');
  });

  it('should enforce TenantId in the ClickHouse query', async () => {
    // The lookup must scope by TenantId in addition to (Id, AppId) — an
    // app-scoped filter alone is not tenant-safe.
    mockClickHouseRows([]);
    const route = createRouteInstance(GetScore, validatedData);
    const { ctx } = createMockContext({ params: { scoreId: 'score-abc-123' } });

    await route.handle(ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('TenantId = {tenantId:String}'),
        query_params: expect.objectContaining({
          tenantId: TEST_TENANT_ID,
          appId: String(TEST_APP_ID),
          scoreId: 'score-abc-123',
        }),
      }),
    );
  });

  it('should return 404 when score is not found', async () => {
    mockClickHouseRows([]);
    const route = createRouteInstance(GetScore, validatedData);
    const { ctx, getResponse } = createMockContext({ params: { scoreId: 'nonexistent' } });

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(404);
    expect(errorOf(body).code).toBe('score_not_found');
  });

  it('should return 500 when ClickHouse query throws', async () => {
    mockQuery.mockRejectedValue(new Error('connection refused'));
    const route = createRouteInstance(GetScore, validatedData);
    const { ctx, getResponse } = createMockContext({ params: { scoreId: 'score-abc-123' } });

    await route.handle(ctx);

    const { status } = getResponse();
    expect(status).toBe(500);
  });
});
