/**
 * Service Scores Tests
 *
 * Covers methods on ScoresService that had no existing behavioral tests:
 *   - getScoreScatter (entire method — 2 error branches + happy path)
 *   - getScores (resource vs filtered list branches)
 *   - getScoresBySpanIds (empty-array early return + grouping)
 *   - transformScore edge cases (clickHouseToISO, source cast, userId fallback)
 *
 * Histograms, trends, type detection, and comparisons live in
 * score-analytics-service.test.ts and are NOT duplicated here.
 *
 * Mock ordering reminder: each `mockResolvedValueOnce` chained matches the
 * synchronous start order of `client.query()` calls inside Promise.all.
 */

import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

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

function rawScoreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'score-1',
    resource_id: 'trace-1',
    name: 'accuracy',
    score: '0.85',
    label: 'good',
    reason: 'matches',
    source: 'eval',
    user_id: 'user-1',
    created_at: '2024-06-01 10:00:00.000',
    ...overrides,
  };
}

/**
 * Mocks the two-query response for `detectScoreType` calls in
 * `getScoreScatter` (which fires detectScoreType for nameA and nameB in
 * parallel). Each label set determines the inferred type:
 *   []                 → 'numeric'
 *   ['true', 'false']  → 'boolean'
 *   ['good', 'bad']    → 'categorical'
 */
function mockDetectTypePair(labelsA: string[], labelsB: string[]): void {
  mockQuery
    .mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue(labelsA.map((l) => ({ label: l }))),
    })
    .mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue(labelsB.map((l) => ({ label: l }))),
    });
}

describe('AnalyticsService.getScoreScatter', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new AnalyticsService(mockClient as any);
  });

  it('throws with a descriptive error when nameA is not numeric', async () => {
    // nameA detected as boolean (labels true/false), nameB numeric (no labels).
    mockDetectTypePair(['true', 'false'], []);

    await expect(
      service.getScoreScatter(testCtx, 'is-helpful', 'precision', {
        start: '2024-01-15',
        end: '2024-01-22',
      }),
    ).rejects.toThrow(
      'Score "is-helpful" is boolean, not numeric. Scatter plot requires two numeric scores.',
    );

    // Only the two detectScoreType calls should have fired — the scatter
    // query itself must NOT run when types are wrong.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('throws when nameB is not numeric (even if nameA is fine)', async () => {
    mockDetectTypePair([], ['good', 'bad']);

    await expect(
      service.getScoreScatter(testCtx, 'precision', 'category', {
        start: '2024-01-15',
        end: '2024-01-22',
      }),
    ).rejects.toThrow(
      'Score "category" is categorical, not numeric. Scatter plot requires two numeric scores.',
    );
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('transforms scatter points and counts when both scores are numeric', async () => {
    mockDetectTypePair([], []); // both numeric

    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          { scoreA: '0.9', scoreB: '0.7' },
          { scoreA: '0.4', scoreB: '0.5' },
        ]),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ totalMatched: '2', totalA: '5', totalB: '4' }]),
      });

    const result = await service.getScoreScatter(testCtx, 'precision', 'recall', {
      start: '2024-01-15',
      end: '2024-01-22',
    });

    // Full toEqual catches: string→number conversion on scoreA/scoreB,
    // count field renames, missing/extra points, swapped totalA/totalB.
    expect(result).toEqual({
      nameA: 'precision',
      nameB: 'recall',
      points: [
        { scoreA: 0.9, scoreB: 0.7 },
        { scoreA: 0.4, scoreB: 0.5 },
      ],
      totalMatched: 2,
      totalA: 5,
      totalB: 4,
    });

    // 2 detectType calls + 2 scatter queries = 4 total.
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});

describe('AnalyticsService.getScores', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new AnalyticsService(mockClient as any);
  });

  it('resource-lookup branch: uses SCORES_BY_RESOURCE_QUERY with resourceId, not date range', async () => {
    // When `resourceId` is provided, getScores must take the resource-lookup
    // branch — a totally different query shape that filters by
    // `ResourceId IN (...)` instead of by date.
    mockQuery
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '0' }]) });

    await service.getScores(testCtx, { resourceId: 'trace-xyz' });

    const listCall = mockQuery.mock.calls[0]![0];
    // Resource query must bind resourceId, NOT start/end/retentionCutoff
    // (those belong to the date-filtered branch).
    expect(listCall.query_params.resourceId).toBe('trace-xyz');
    expect(listCall.query_params).not.toHaveProperty('startDate');
    expect(listCall.query_params).not.toHaveProperty('retentionCutoff');
  });

  it('filtered-list branch: applies date range, session filter, pagination, and transforms rows', async () => {
    // No resourceId → date-filtered branch. Tests the SQL params and
    // the full transform shape simultaneously.
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([rawScoreRow()]),
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([{ total: '1' }]),
      });

    const result = await service.getScores(testCtx, {
      startDate: '2024-01-15T00:00:00.000Z',
      endDate: '2024-02-15T23:59:59.999Z',
      sessionId: 'session-abc',
      limit: 25,
      offset: 50,
    });

    expect(result).toEqual({
      scores: [
        {
          id: 'score-1',
          resourceId: 'trace-1',
          name: 'accuracy',
          score: 0.85,
          label: 'good',
          reason: 'matches',
          source: 'eval',
          userId: 'user-1',
          createdAt: '2024-06-01T10:00:00.000Z',
        },
      ],
      total: 1,
      limit: 25,
      offset: 50,
    });

    const listCall = mockQuery.mock.calls[0]![0];
    const countCall = mockQuery.mock.calls[1]![0];

    // Date range formatted via formatISOForClickHouse (T→space, drop Z).
    expect(listCall.query_params.startDate).toBe('2024-01-15 00:00:00.000');
    expect(listCall.query_params.endDate).toBe('2024-02-15 23:59:59.999');
    // sessionId bound — catches a refactor that drops the session filter
    // from one of the two queries (would cause count/list to disagree).
    expect(listCall.query_params.sessionId).toBe('session-abc');
    expect(countCall.query_params.sessionId).toBe('session-abc');
    // retentionCutoff in DateTime64 format (1970 sentinel for -1).
    expect(listCall.query_params.retentionCutoff).toBe('1970-01-01 00:00:00.000');
  });
});

describe('AnalyticsService.getScoresBySpanIds', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new AnalyticsService(mockClient as any);
  });

  it('returns {} and fires NO query when spanIds is empty', async () => {
    const result = await service.getScoresBySpanIds(testCtx, []);

    // Empty result and — critically — no ClickHouse query. The implementation
    // has an explicit early-return; this catches a refactor that drops it
    // (which would cause every empty-spans call to hit the DB unnecessarily,
    // and worse, with a `WHERE ResourceId IN ()` clause that's invalid SQL).
    expect(result).toEqual({});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('groups scores by resource_id into a map, with multiple scores per resource preserved', async () => {
    // Three scores spanning two resources. The transform must group by
    // resource_id (NOT by name or id), and preserve insertion order
    // within each group.
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        rawScoreRow({ id: 's-1', resource_id: 'span-A', name: 'accuracy', score: '0.9' }),
        rawScoreRow({ id: 's-2', resource_id: 'span-A', name: 'helpfulness', score: '0.8' }),
        rawScoreRow({ id: 's-3', resource_id: 'span-B', name: 'accuracy', score: '0.5' }),
      ]),
    });

    const result = await service.getScoresBySpanIds(testCtx, ['span-A', 'span-B']);

    // Catches: wrong grouping key (e.g. `score.id` instead of
    // `score.resourceId`), dropped scores when multiple share a resource,
    // and order changes within a group.
    expect(Object.keys(result).sort()).toEqual(['span-A', 'span-B']);
    expect(result['span-A']!.map((s) => s.name)).toEqual(['accuracy', 'helpfulness']);
    expect(result['span-A']!.map((s) => s.score)).toEqual([0.9, 0.8]);
    expect(result['span-B']!.map((s) => ({ name: s.name, score: s.score }))).toEqual([
      { name: 'accuracy', score: 0.5 },
    ]);

    // The spanIds array must be bound as `resourceIds` (plural), not
    // interpolated. Catches SQL injection regressions.
    const call = mockQuery.mock.calls[0]![0];
    expect(call.query_params.resourceIds).toEqual(['span-A', 'span-B']);
  });
});

describe('AnalyticsService transformScore (via getScores)', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new AnalyticsService(mockClient as any);
  });

  it('converts ClickHouse datetime to ISO 8601, defaults empty strings, leaves userId undefined when blank', async () => {
    // ClickHouse returns 'YYYY-MM-DD HH:mm:ss.SSS' (space, no zone).
    // The raw ClickHouse format is a schema conformance failure against the
    // published spec — it must round-trip to ISO with `T` and `Z`.
    //
    // Also covers the userId fallback: empty raw value becomes
    // `undefined` (not '') so the response matches the `userId?: string`
    // optional-field contract.
    mockQuery
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue([
          rawScoreRow({
            id: 's-edge',
            label: '',
            reason: '',
            user_id: '',
            source: 'annotation',
            created_at: '2024-12-31 23:59:59.999',
          }),
        ]),
      })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ total: '1' }]) });

    const result = await service.getScores(testCtx, {});

    expect(result.scores[0]).toEqual({
      id: 's-edge',
      resourceId: 'trace-1',
      name: 'accuracy',
      score: 0.85,
      label: '',
      reason: '',
      source: 'annotation', // source passes through as-is — the read cast must not coerce or default it
      userId: undefined, // not '' — protects the optional-field contract
      createdAt: '2024-12-31T23:59:59.999Z',
    });
  });
});

describe('AnalyticsService.getScoreAggregations', () => {
  let service: AnalyticsService;
  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient as any);
  });

  it('selects DataType in the query and surfaces it on each aggregation', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        { name: 'accuracy', avg_score: '0.8', count: '10', min_score: '0', max_score: '1', data_type: 'boolean' },
      ]),
    });

    const result = await service.getScoreAggregations(testCtx, {
      start: '2024-06-01',
      end: '2024-06-02',
    });

    expect(mockQuery.mock.calls[0]![0].query).toContain('any(DataType) as data_type');
    expect(result.aggregations[0]).toEqual({
      name: 'accuracy',
      avgScore: 0.8,
      count: 10,
      minScore: 0,
      maxScore: 1,
      dataType: 'boolean',
    });
  });

  it('defaults dataType to "" for legacy rows missing DataType', async () => {
    mockQuery.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue([
        { name: 'legacy', avg_score: '3', count: '5', min_score: '1', max_score: '5' },
      ]),
    });

    const result = await service.getScoreAggregations(testCtx, {
      start: '2024-06-01',
      end: '2024-06-02',
    });

    expect(result.aggregations[0]!.dataType).toBe('');
  });
});
