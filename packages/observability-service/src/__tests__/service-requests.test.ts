/**
 * Service Requests Tests
 *
 * Each test targets a specific bug class. No test relies on JavaScript
 * semantics — every assertion would fail under a plausible-looking
 * change to the production code.
 *
 * Mock ordering reminder: `mockResolvedValueOnce` chains match the
 * synchronous start order of `client.query()` calls inside Promise.all.
 *   getRequests: [list, count]
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';
import type { RequestsParams } from '../types';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as unknown as { query: typeof mockQuery };

const verifiedAppId = 'app-123' as VerifiedAppId;
const testCtx: TenantContext = {
  userId: 'test-user',
  tenantId: 'tenant-123',
  appId: verifiedAppId,
  dataRetentionDays: -1,
};

/**
 * `RequestsParams` lists `limit` and `offset` as required (it extends
 * `PaginationParams`, not `Partial<PaginationParams>`), but the service
 * implementation has runtime defaults (`params.limit ?? 50`,
 * `params.offset ?? 0`) for callers that arrive via untyped paths
 * (e.g. raw JSON bodies). This helper lets tests express "pagination
 * not the focus here" while satisfying the type checker.
 */
function reqParams(overrides: Partial<RequestsParams> = {}): RequestsParams {
  return overrides as RequestsParams;
}

function rawRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'span-1',
    tenant_id: 'tenant-123',
    app_id: 'app-123',
    cost: '0.0024',
    prompt_tokens: '125',
    completion_tokens: '87',
    latency_ms: '450',
    model_used: 'gpt-4o',
    status: 'OK',
    input: 'hello',
    output: 'world',
    output_object: '',
    ts: '2024-06-01T10:00:00.000Z',
    user_id: 'user-1',
    trace_id: 'trace-1',
    status_message: '',
    props: '{}',
    ...overrides,
  };
}

function mockListAndCount(rows: Array<Record<string, unknown>>, total = String(rows.length)): void {
  mockQuery
    .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rows) })
    .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total }]) });
}

describe('AnalyticsService.getRequests', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new AnalyticsService(mockClient as any);
  });

  it('transforms raw row fields with full field-rename and toNumber on numeric strings', async () => {
    mockListAndCount([rawRequest()], '1');

    const result = await service.getRequests(testCtx, reqParams());

    // Full toEqual on the response. Catches:
    //   - any of the 13 snake_case → camelCase rename typos
    //     (tenant_id → tenantId, prompt_tokens → promptTokens, etc.)
    //   - broken `toNumber` on cost / *Tokens / latency_ms
    //   - broken parseInt on `total`
    //   - missing/extra fields
    //   - default pagination drift (50/0)
    expect(result).toEqual({
      requests: [
        {
          id: 'span-1',
          tenantId: 'tenant-123',
          appId: 'app-123',
          cost: 0.0024,
          promptTokens: 125,
          completionTokens: 87,
          latencyMs: 450,
          modelUsed: 'gpt-4o',
          status: 'OK',
          input: 'hello',
          output: 'world',
          ts: '2024-06-01T10:00:00.000Z',
          userId: 'user-1',
          traceId: 'trace-1',
          statusMessage: '',
          props: '{}',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('output field follows the precedence chain: output → output_object → null', async () => {
    // The triple-fallback `raw.output || raw.output_object || null` has
    // three distinct branches. A refactor that reversed the precedence
    // (output_object before output) or removed the null fallback would
    // ship the wrong field — a real user-visible bug.
    mockListAndCount([
      // 1. Both present → must pick `output`.
      rawRequest({ id: 'r-both', output: 'real-output', output_object: '{"obj":1}' }),
      // 2. output empty, output_object present → must pick output_object.
      rawRequest({ id: 'r-object', output: '', output_object: '{"only":"object"}' }),
      // 3. Both empty → must be null (not '', not undefined).
      rawRequest({ id: 'r-neither', output: '', output_object: '' }),
    ], '3');

    const result = await service.getRequests(testCtx, reqParams());

    expect(result.requests.map((r) => ({ id: r.id, output: r.output }))).toEqual([
      { id: 'r-both', output: 'real-output' },
      { id: 'r-object', output: '{"only":"object"}' },
      { id: 'r-neither', output: null },
    ]);
  });

  it('status defaults to "OK" when the raw status is empty (locks in product decision)', async () => {
    // The `raw.status || 'OK'` fallback is a product decision: empty
    // status from ClickHouse maps to a successful request, not an unknown
    // or error state. A refactor that changed this to `'UNKNOWN'` or
    // dropped the fallback would change user-visible UI labels.
    mockListAndCount([rawRequest({ status: '' })], '1');

    const result = await service.getRequests(testCtx, reqParams());

    expect(result.requests[0]!.status).toBe('OK');
  });

  it('pagination contract: defaults to {50, 0} when omitted, passes through explicit values', async () => {
    // Default branch.
    mockListAndCount([], '0');
    const defaults = await service.getRequests(testCtx, reqParams());
    const defaultListCall = mockQuery.mock.calls[0]![0];
    expect(defaults.limit).toBe(50);
    expect(defaults.offset).toBe(0);
    expect(defaultListCall.query_params.limit).toBe(50);
    expect(defaultListCall.query_params.offset).toBe(0);

    // Explicit branch.
    vi.clearAllMocks();
    mockListAndCount([], '0');
    const explicit = await service.getRequests(testCtx, reqParams({ limit: 25, offset: 200 }));
    const explicitListCall = mockQuery.mock.calls[0]![0];
    expect(explicit.limit).toBe(25);
    expect(explicit.offset).toBe(200);
    expect(explicitListCall.query_params.limit).toBe(25);
    expect(explicitListCall.query_params.offset).toBe(200);
  });

  it('propagates dates, retentionCutoff (DateTime64), and filters to BOTH list and count queries', async () => {
    // Pagination-drift bug class: if list and count receive different
    // bounds, the displayed window won't match the paginated total.
    //
    // Filter integration: filters must hit BOTH queries so the count
    // accurately reflects the filtered list.
    //
    // retentionCutoff format: must be DateTime64 ('YYYY-MM-DD HH:mm:ss.SSS'),
    // not Date — confusing the two produces a runtime ClickHouse parse error.
    mockListAndCount([], '0');

    await service.getRequests(testCtx, reqParams({
      startDate: '2024-01-15T00:00:00.000Z',
      endDate: '2024-02-15T23:59:59.999Z',
      filters: [
        { field: 'model', operator: 'equals', value: 'gpt-4o' },
        { field: 'latency_ms', operator: 'gt', value: '100' },
      ],
    }));

    const listCall = mockQuery.mock.calls[0]![0];
    const countCall = mockQuery.mock.calls[1]![0];

    for (const call of [listCall, countCall]) {
      // Dates: formatISOForClickHouse(T→space, drop Z).
      expect(call.query_params.startDate).toBe('2024-01-15 00:00:00.000');
      expect(call.query_params.endDate).toBe('2024-02-15 23:59:59.999');

      // retentionCutoff: DateTime64 shape for dataRetentionDays=-1
      // (the 1970 epoch with full time component).
      expect(call.query_params.retentionCutoff).toBe('1970-01-01 00:00:00.000');

      // Filter clauses present in the SQL, params bound under
      // `filter_0` / `filter_1` (the convention from buildFilterWhereClause).
      expect(call.query).toContain('Model = {filter_0:String}');
      expect(call.query).toContain('Duration > {filter_1:Float64}');
      expect(call.query_params.filter_0).toBe('gpt-4o');
      expect(call.query_params.filter_1).toBe(100);
    }

    // Sanity: the listQuery is the one that paginates (LIMIT/OFFSET),
    // the countQuery does not. If a refactor moved LIMIT into the count
    // query, the totals would be capped at the page size.
    expect(listCall.query).toContain('LIMIT {limit:UInt32}');
    expect(countCall.query).not.toContain('LIMIT');
  });
});
