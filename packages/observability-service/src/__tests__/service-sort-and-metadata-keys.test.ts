/**
 * Service sort and getDistinctMetadataKeys tests.
 *
 * Tests for sort parameter handling in getTraces and
 * the getDistinctMetadataKeys method.
 */

import { AnalyticsService } from '../service';
import { pageTimeWindow } from '../services/traces';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

describe('AnalyticsService sort parameters', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  function mockQueryResults(rows: Record<string, unknown>[], total: string = '0') {
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rows) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total }]) });
  }

  // ── getTraces I/O preview ────────────────────

  describe('getTraces I/O preview', () => {
    const listRow = {
      id: 't-1',
      name: 'foo',
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-01-01T00:00:02.000Z',
      status: '1',
      cost: '0',
      tokens: '0',
      latency_ms: '0',
      span_count: '3',
      environment: '',
      environment_version: '0',
    };

    // list + count + I/O-preview = 3 query calls
    function mockListThenPreview(previewRows: Record<string, unknown>[]) {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([listRow]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '1' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(previewRows) });
    }

    it('keeps the heavy I/O columns and the removed model aggregate OUT of the hot-path list query', async () => {
      mockQueryResults([]); // empty page → no preview query at all
      await service.getTraces(testCtx, { limit: 10, offset: 0 });

      const listCall = mockQuery.mock.calls[0]![0];
      expect(listCall.query).not.toContain('Input');
      expect(listCall.query).not.toContain('Output');
      expect(listCall.query).not.toMatch(/anyIf\(Model/);
    });

    it('skips the preview query entirely when the page is empty', async () => {
      mockQueryResults([]);
      await service.getTraces(testCtx, { limit: 10, offset: 0 });
      // Only list + count ran — no third (preview) call.
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('reads truncated I/O for only the returned page (TraceId IN + substring + span filter)', async () => {
      mockListThenPreview([
        { trace_id: 't-1', parent_id: '', type: 'SPAN', timestamp: '2024-01-01T00:00:00.000Z', input: 'hello', output: 'world' },
      ]);

      const result = await service.getTraces(testCtx, { limit: 10, offset: 0 });

      const previewCall = mockQuery.mock.calls[2]![0];
      expect(previewCall.query).toContain('substringUTF8(Input, 1, {ioPreviewChars:UInt32})');
      expect(previewCall.query).toContain('substringUTF8(Output, 1, {ioPreviewChars:UInt32})');
      expect(previewCall.query).toContain('TraceId IN {traceIds:Array(String)}');
      expect(previewCall.query).toContain("(ParentSpanId = '' OR Type = 'GENERATION')");
      expect(previewCall.query_params.traceIds).toEqual(['t-1']);
      expect(previewCall.query_params.ioPreviewChars).toBe(160);
      // retentionCutoff and the tenant/app scoping must be parameterized too.
      expect(previewCall.query_params.appId).toBe(verifiedAppId);
      expect(previewCall.query_params.tenantId).toBe('tenant-123');
      expect(previewCall.format).toBe('JSONEachRow');

      expect(result.traces[0]!.inputPreview).toBe('hello');
      expect(result.traces[0]!.outputPreview).toBe('world');
    });

    it('normalizes zoneless ClickHouse start/end to ISO-8601 UTC (so the list is not rendered in the viewer local offset)', async () => {
      // ClickHouse serializes DateTime64 zoneless ('YYYY-MM-DD HH:mm:ss.SSS').
      // The wire contract is ISO-8601 UTC; a raw passthrough makes the dashboard
      // do `new Date(zoneless)` → parsed as LOCAL → list times shifted by the
      // viewer's UTC offset. (Existing tests above mock start already ISO, which
      // masked this.)
      mockQuery
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { ...listRow, start: '2026-06-23 20:44:00.000', end: '2026-06-23 20:44:02.500' },
          ]),
        })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '1' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      const result = await service.getTraces(testCtx, { limit: 10, offset: 0 });

      expect(result.traces[0]!.start).toBe('2026-06-23T20:44:00.000Z');
      expect(result.traces[0]!.end).toBe('2026-06-23T20:44:02.500Z');
    });

    it('bounds the preview scan to the page window: min(start) → max(end), in ClickHouse format', async () => {
      // Two rows with deliberately out-of-order start/end so a min/max swap or
      // an off-by-one in pageTimeWindow changes the bound and fails the assert.
      mockQuery
        .mockResolvedValueOnce({
          json: vi.fn().mockResolvedValue([
            { ...listRow, id: 't-1', start: '2024-03-10T08:00:00.000Z', end: '2024-03-10T08:00:05.000Z' },
            { ...listRow, id: 't-2', start: '2024-03-10T07:00:00.000Z', end: '2024-03-10T09:30:00.000Z' },
          ]),
        })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '2' }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await service.getTraces(testCtx, { limit: 10, offset: 0 });

      const previewCall = mockQuery.mock.calls[2]![0];
      // earliest start across the page, latest end across the page (CH format).
      expect(previewCall.query_params.windowStart).toBe('2024-03-10 07:00:00.000');
      expect(previewCall.query_params.windowEnd).toBe('2024-03-10 09:30:00.000');
      expect(previewCall.query_params.traceIds).toEqual(['t-1', 't-2']);
    });

    it('derives the preview with deriveTraceIO semantics (root input wins, last GENERATION output is the fallback)', async () => {
      mockListThenPreview([
        { trace_id: 't-1', parent_id: '', type: 'SPAN', timestamp: '2024-01-01T00:00:00.000Z', input: 'root-in', output: '' },
        { trace_id: 't-1', parent_id: 's0', type: 'GENERATION', timestamp: '2024-01-01T00:00:01.000Z', input: 'gen-in-1', output: 'gen-out-1' },
        { trace_id: 't-1', parent_id: 's0', type: 'GENERATION', timestamp: '2024-01-01T00:00:02.000Z', input: 'gen-in-2', output: 'gen-out-2' },
      ]);

      const result = await service.getTraces(testCtx, { limit: 10, offset: 0 });

      expect(result.traces[0]!.inputPreview).toBe('root-in');
      expect(result.traces[0]!.outputPreview).toBe('gen-out-2');
    });

    it('degrades to no preview (never throws) when the preview query fails', async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([listRow]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '1' }]) })
        .mockRejectedValueOnce(new Error('clickhouse down'));

      const result = await service.getTraces(testCtx, { limit: 10, offset: 0 });

      expect(result.traces[0]!.id).toBe('t-1');
      expect(result.traces[0]!.inputPreview).toBeUndefined();
      expect(result.traces[0]!.outputPreview).toBeUndefined();
    });
  });

  // ── pageTimeWindow (preview scan bounds) ──────────────────────────

  describe('pageTimeWindow', () => {
    it('returns null for an empty page', () => {
      expect(pageTimeWindow([])).toBeNull();
    });

    it('returns null when no row has a parseable timestamp', () => {
      expect(pageTimeWindow([{ start: 'not-a-date', end: 'nope' }])).toBeNull();
    });

    it('takes the earliest start and latest end across the page, in ClickHouse format', () => {
      const window = pageTimeWindow([
        { start: '2024-03-10T08:00:00.000Z', end: '2024-03-10T08:00:05.000Z' },
        { start: '2024-03-10T07:00:00.000Z', end: '2024-03-10T09:30:00.000Z' },
        { start: '2024-03-10T07:30:00.000Z', end: '2024-03-10T07:45:00.000Z' },
      ]);
      expect(window).toEqual({
        start: '2024-03-10 07:00:00.000',
        end: '2024-03-10 09:30:00.000',
      });
    });

    it('ignores unparseable rows but still bounds from the parseable ones', () => {
      const window = pageTimeWindow([
        { start: 'garbage', end: 'garbage' },
        { start: '2024-03-10T07:00:00.000Z', end: '2024-03-10T08:00:00.000Z' },
      ]);
      expect(window).toEqual({
        start: '2024-03-10 07:00:00.000',
        end: '2024-03-10 08:00:00.000',
      });
    });

    it('accepts ClickHouse-format (space-separated, zoneless) inputs', () => {
      const window = pageTimeWindow([
        { start: '2024-03-10 07:00:00.000', end: '2024-03-10 08:00:00.000' },
      ]);
      expect(window).toEqual({
        start: '2024-03-10 07:00:00.000',
        end: '2024-03-10 08:00:00.000',
      });
    });
  });

  // ── getTraces sort ─────────────────────────────────────────────────

  describe('getTraces sort', () => {
    it('should produce ORDER BY latency_ms DESC when sortBy=latency sortOrder=desc', async () => {
      mockQueryResults([]);

      await service.getTraces(testCtx, {
        limit: 10,
        offset: 0,
        sortBy: 'latency',
        sortOrder: 'desc',
      });

      const listCall = mockQuery.mock.calls[0]![0];
      expect(listCall.query).toContain('ORDER BY latency_ms DESC');
    });

    it('should default to ORDER BY start DESC when no sort params provided', async () => {
      mockQueryResults([]);

      await service.getTraces(testCtx, {
        limit: 10,
        offset: 0,
      });

      const listCall = mockQuery.mock.calls[0]![0];
      expect(listCall.query).toContain('ORDER BY start DESC');
    });

    it('should produce ORDER BY cost ASC when sortBy=cost sortOrder=asc', async () => {
      mockQueryResults([]);

      await service.getTraces(testCtx, {
        limit: 10,
        offset: 0,
        sortBy: 'cost',
        sortOrder: 'asc',
      });

      const listCall = mockQuery.mock.calls[0]![0];
      expect(listCall.query).toContain('ORDER BY cost ASC');
    });

    it('should default sort order to DESC when sortOrder not specified', async () => {
      mockQueryResults([]);

      await service.getTraces(testCtx, {
        limit: 10,
        offset: 0,
        sortBy: 'tokens',
      });

      const listCall = mockQuery.mock.calls[0]![0];
      expect(listCall.query).toContain('ORDER BY tokens DESC');
    });

    // sortBy reaches the ORDER BY clause by interpolation, so a name the map
    // does not own must fall through to the default rather than resolve to
    // something inherited (`constructor` → a function → an unparseable query).
    it.each(['constructor', '__proto__', 'toString', 'nonsense'])(
      'falls back to ORDER BY start DESC for the unmapped sortBy %s',
      async unmapped => {
        mockQueryResults([]);

        await service.getTraces(testCtx, {
          limit: 10,
          offset: 0,
          sortBy: unmapped as never,
        });

        const listCall = mockQuery.mock.calls[0]![0];
        expect(listCall.query).toContain('ORDER BY start DESC');
        expect(listCall.query).not.toContain('function');
      },
    );
  });

});

describe('AnalyticsService.getDistinctMetadataKeys', () => {
  let service: AnalyticsService;
  const verifiedAppId = 'app-123' as VerifiedAppId;
  const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: verifiedAppId, dataRetentionDays: -1 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should return parsed keys from ClickHouse response', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        { key: 'environment' },
        { key: 'version' },
        { key: 'user_type' },
      ]),
    });

    const keys = await service.getDistinctMetadataKeys(testCtx);

    expect(keys).toEqual(['environment', 'version', 'user_type']);
  });

  it('should return empty array when no metadata keys exist', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    const keys = await service.getDistinctMetadataKeys(testCtx);

    expect(keys).toEqual([]);
  });

  it('should pass appId to the query', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    await service.getDistinctMetadataKeys(testCtx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: expect.objectContaining({
          appId: 'app-123',
        }),
      })
    );
  });

  it('should pass retention cutoff to the query', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([]),
    });

    const retentionCtx: TenantContext = { ...testCtx, dataRetentionDays: 30 };
    await service.getDistinctMetadataKeys(retentionCtx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: expect.objectContaining({
          appId: 'app-123',
          retentionCutoff: expect.any(String),
        }),
      })
    );
  });
});
