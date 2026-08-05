/**
 * In-process unit tests for the GetSpan handler (GET /v1/spans/:spanId).
 *
 * The gateway-http suite proves this endpoint end-to-end against a live
 * wrangler + ClickHouse, but that runs in a separate process and produces no
 * vitest coverage for the handler source. These tests exercise the handler
 * in-process (with a mocked ClickHouse client) so the query construction,
 * row mapping, 404 path, and error path are all covered and pinned.
 *
 * Pattern mirrors migrated-routes.test.ts (direct `createClient` routes).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifiedAppId } from '@repo/observability-service';
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

// _shared.getService → analytics-factory; return null so nothing blows up on
// import. GetSpan uses the direct ClickHouse client, not the service.
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
}

function createMockContext(params: Record<string, string>): {
  ctx: AppContext;
  getResponse: () => CapturedResponse;
} {
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
      method: 'GET',
      path: '/v1/spans/span-1',
      url: 'http://localhost/v1/spans/span-1',
      header: vi.fn(() => undefined),
      param: vi.fn((k: string) => params[k]),
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

/** A full otel_traces row as the SELECT aliases it (snake_case). */
function chRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'span-1',
    trace_id: 'trace-1',
    parent_id: 'parent-1',
    name: 'llm-call',
    status_code: '2', // → ERROR
    status_message: 'boom',
    duration: 1234,
    timestamp: '2026-01-15 10:00:00.000',
    type: 'GENERATION',
    model: 'gpt-4o',
    input_tokens: 11,
    output_tokens: 22,
    tokens: 33,
    cost: 0.125,
    span_kind: 'client',
    service_name: 'api',
    metadata: { env: 'prod' },
    input: 'INPUT_PAYLOAD',
    output: 'OUTPUT_PAYLOAD',
    output_object: '{"answer":42}',
    tool_calls: '[{"name":"search"}]',
    ...overrides,
  };
}

function resolveQueryWith(rows: Record<string, unknown>[]): void {
  mockQuery.mockResolvedValue({ json: vi.fn().mockResolvedValue(rows) });
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { GetSpan } from '../routes/spans';

async function run(route: { handle: (c: AppContext) => Promise<Response> }, ctx: AppContext) {
  await route.handle(ctx);
}

describe('GetSpan handler (GET /v1/spans/:spanId)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the full span (metadata + I/O) and scopes the query by tenant/app/span', async () => {
    resolveQueryWith([chRow()]);
    const { ctx, getResponse } = createMockContext({ spanId: 'span-1' });
    await run(createRouteInstance(GetSpan, { params: { spanId: 'span-1' } }), ctx);

    const resp = getResponse();
    expect(resp.status).toBe(200);
    expect((resp.body as { data: unknown }).data).toEqual({
      id: 'span-1',
      trace_id: 'trace-1',
      parent_id: 'parent-1',
      name: 'llm-call',
      status: 'ERROR',
      status_message: 'boom',
      duration_ms: 1234,
      timestamp: '2026-01-15T10:00:00.000Z',
      type: 'GENERATION',
      model: 'gpt-4o',
      input_tokens: 11,
      output_tokens: 22,
      tokens: 33,
      cost: 0.125,
      span_kind: 'client',
      service_name: 'api',
      metadata: { env: 'prod' },
      input: 'INPUT_PAYLOAD',
      output: 'OUTPUT_PAYLOAD',
      output_object: '{"answer":42}',
      tool_calls: '[{"name":"search"}]',
    });

    // Tenant scoping + I/O selection are pinned on the actual query sent.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]![0] as { query: string; query_params: unknown };
    expect(call.query_params).toEqual({
      tenantId: TEST_TENANT_ID,
      appId: TEST_APP_ID,
      spanId: 'span-1',
    });
    expect(call.query).toContain('SpanId = {spanId:String}');
    expect(call.query).toContain('TenantId = {tenantId:String}');
    expect(call.query).toContain('AppId = {appId:String}');
    expect(call.query).toContain('IsDeleted = 0');
    // The I/O columns must be selected (the whole point of the full-span shape).
    for (const col of ['Input AS input', 'Output AS output', 'OutputObject AS output_object', 'ToolCalls AS tool_calls']) {
      expect(call.query).toContain(col);
    }
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('maps empty optional columns to null/empty (parent_id, model, I/O objects)', async () => {
    resolveQueryWith([
      chRow({ parent_id: '', model: '', output_object: '', tool_calls: '' }),
    ]);
    const { ctx, getResponse } = createMockContext({ spanId: 'span-1' });
    await run(createRouteInstance(GetSpan, { params: { spanId: 'span-1' } }), ctx);

    const data = (getResponse().body as { data: Record<string, unknown> }).data;
    expect(data.parent_id).toBeNull();
    expect(data.model).toBeNull();
    expect(data.output_object).toBeNull();
    expect(data.tool_calls).toBeNull();
  });

  it('404s with span_not_found when no row matches', async () => {
    resolveQueryWith([]);
    const { ctx, getResponse } = createMockContext({ spanId: 'missing' });
    await run(createRouteInstance(GetSpan, { params: { spanId: 'missing' } }), ctx);

    const resp = getResponse();
    expect(resp.status).toBe(404);
    expect((resp.body as { error: { code: string; message: string } }).error).toEqual({
      code: 'span_not_found',
      message: 'Span not found',
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('maps a ClickHouse query failure to a 500 and still closes the client', async () => {
    mockQuery.mockRejectedValue(new Error('clickhouse down'));
    const { ctx, getResponse } = createMockContext({ spanId: 'span-1' });
    await run(createRouteInstance(GetSpan, { params: { spanId: 'span-1' } }), ctx);

    expect(getResponse().status).toBe(500);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
