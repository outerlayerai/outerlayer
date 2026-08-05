/**
 * Score analytics service unit tests.
 *
 * Tests detectScoreType, getScoreHistogram, getScoreTrend, and getScoreComparison
 * with a mocked ClickHouse client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsService } from '../service';
import type { TenantContext, VerifiedAppId } from '../tenant-context';

const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as any;

const APP_ID = 'app-test-scores' as VerifiedAppId;
const testCtx: TenantContext = { userId: 'test-user', tenantId: 'tenant-123', appId: APP_ID, dataRetentionDays: -1 };
const DATE_RANGE = {
  start: '2026-01-01T00:00:00Z',
  end: '2026-01-31T23:59:59Z',
};

function mockJsonResponse<T>(data: T) {
  return { json: vi.fn().mockResolvedValue(data) };
}

describe('AnalyticsService.detectScoreType', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should return numeric when no labels exist', async () => {
    mockQuery.mockResolvedValue(mockJsonResponse([]));

    const result = await service.detectScoreType(testCtx, 'accuracy');

    expect(result).toBe('numeric');
  });

  it('should return boolean when labels are true and false', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ label: 'true' }, { label: 'false' }])
    );

    const result = await service.detectScoreType(testCtx, 'is_correct');

    expect(result).toBe('boolean');
  });

  it('should return boolean when only true label exists', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ label: 'true' }])
    );

    const result = await service.detectScoreType(testCtx, 'is_correct');

    expect(result).toBe('boolean');
  });

  it('should return boolean when labels have mixed case', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ label: 'True' }, { label: 'FALSE' }])
    );

    const result = await service.detectScoreType(testCtx, 'is_correct');

    expect(result).toBe('boolean');
  });

  it('should return categorical when labels are non-boolean strings', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ label: 'good' }, { label: 'bad' }, { label: 'neutral' }])
    );

    const result = await service.detectScoreType(testCtx, 'sentiment');

    expect(result).toBe('categorical');
  });

  it('should return categorical when labels mix boolean and non-boolean', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ label: 'true' }, { label: 'false' }, { label: 'maybe' }])
    );

    const result = await service.detectScoreType(testCtx, 'answer_quality');

    expect(result).toBe('categorical');
  });

  it('should return categorical when a single non-boolean label exists', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ label: 'positive' }])
    );

    const result = await service.detectScoreType(testCtx, 'tone');

    expect(result).toBe('categorical');
  });

  it('should pass dataRetentionDays to query params', async () => {
    mockQuery.mockResolvedValue(mockJsonResponse([]));

    await service.detectScoreType(testCtx, 'accuracy');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0]![0];
    expect(callArgs.query_params.appId).toBe(APP_ID);
    expect(callArgs.query_params.name).toBe('accuracy');
  });
});

describe('AnalyticsService.getScoreHistogram', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should return category counts when score type is categorical', async () => {
    // First call: detectScoreType returns categorical labels
    mockQuery
      .mockResolvedValueOnce(
        mockJsonResponse([{ label: 'good' }, { label: 'bad' }])
      )
      // Second call: category counts query
      .mockResolvedValueOnce(
        mockJsonResponse([
          { label: 'good', count: '42' },
          { label: 'bad', count: '18' },
        ])
      );

    const result = await service.getScoreHistogram(testCtx, 'quality', DATE_RANGE);

    expect(result.name).toBe('quality');
    expect(result.type).toBe('categorical');
    expect(result.buckets).toEqual([]);
    expect(result.categories).toEqual([
      { label: 'good', count: 42 },
      { label: 'bad', count: 18 },
    ]);
  });

  it('should return category counts when score type is boolean', async () => {
    mockQuery
      .mockResolvedValueOnce(
        mockJsonResponse([{ label: 'true' }, { label: 'false' }])
      )
      .mockResolvedValueOnce(
        mockJsonResponse([
          { label: 'true', count: '100' },
          { label: 'false', count: '50' },
        ])
      );

    const result = await service.getScoreHistogram(testCtx, 'is_correct', DATE_RANGE);

    expect(result.name).toBe('is_correct');
    expect(result.type).toBe('boolean');
    expect(result.buckets).toEqual([]);
    expect(result.categories).toEqual([
      { label: 'true', count: 100 },
      { label: 'false', count: 50 },
    ]);
  });

  it('should return histogram buckets when score type is numeric', async () => {
    mockQuery
      // detectScoreType: no labels -> numeric
      .mockResolvedValueOnce(mockJsonResponse([]))
      // aggregations query: min/max
      .mockResolvedValueOnce(
        mockJsonResponse([{ name: 'accuracy', min_score: '0', max_score: '1' }])
      )
      // histogram bucket query
      .mockResolvedValueOnce(
        mockJsonResponse([
          { bucket: '0', count: '5' },
          { bucket: '0.1', count: '10' },
          { bucket: '0.2', count: '15' },
        ])
      );

    const result = await service.getScoreHistogram(testCtx, 'accuracy', DATE_RANGE);

    expect(result.name).toBe('accuracy');
    expect(result.type).toBe('numeric');
    expect(result.categories).toEqual([]);
    expect(result.buckets).toEqual([
      { bucket: 0, count: 5 },
      { bucket: 0.1, count: 10 },
      { bucket: 0.2, count: 15 },
    ]);
  });

  it('should return empty buckets when numeric score has no aggregation data', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([]))
      // aggregations query returns no match for this score name
      .mockResolvedValueOnce(
        mockJsonResponse([{ name: 'other_score', min_score: '0', max_score: '10' }])
      );

    const result = await service.getScoreHistogram(testCtx, 'missing_score', DATE_RANGE);

    expect(result.name).toBe('missing_score');
    expect(result.type).toBe('numeric');
    expect(result.buckets).toEqual([]);
    expect(result.categories).toEqual([]);
  });

  it('should return empty buckets when aggregation returns empty array', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const result = await service.getScoreHistogram(testCtx, 'no_data', DATE_RANGE);

    expect(result.name).toBe('no_data');
    expect(result.type).toBe('numeric');
    expect(result.buckets).toEqual([]);
    expect(result.categories).toEqual([]);
  });

  it('should handle numeric scores where min equals max', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(
        mockJsonResponse([{ name: 'constant', min_score: '5', max_score: '5' }])
      )
      .mockResolvedValueOnce(
        mockJsonResponse([{ bucket: '5', count: '20' }])
      );

    const result = await service.getScoreHistogram(testCtx, 'constant', DATE_RANGE);

    expect(result.type).toBe('numeric');
    expect(result.buckets).toEqual([{ bucket: 5, count: 20 }]);
  });
});

describe('AnalyticsService.getScoreTrend', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should return trend points with correct structure for day interval', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([
        { timestamp: '2026-01-01 00:00:00', avgScore: '0.85', count: '100' },
        { timestamp: '2026-01-02 00:00:00', avgScore: '0.90', count: '120' },
      ])
    );

    const result = await service.getScoreTrend(testCtx, 'accuracy', 'day', DATE_RANGE);

    expect(result.name).toBe('accuracy');
    expect(result.interval).toBe('day');
    // Zero-fill adds entries for the full date range; verify data points are present
    const dataPoints = result.points.filter((p) => p.count > 0);
    expect(dataPoints).toHaveLength(2);
    expect(dataPoints[0]!.avgScore).toBeCloseTo(0.85);
    expect(dataPoints[0]!.count).toBe(100);
    expect(dataPoints[1]!.avgScore).toBeCloseTo(0.90);
    expect(dataPoints[1]!.count).toBe(120);
  });

  it('normalizes the zoneless ClickHouse bucket timestamp to ISO-8601 UTC', async () => {
    // Without this the data point keeps its zoneless 'YYYY-MM-DD HH:mm:ss' form,
    // which the trend chart `new Date()`-parses as LOCAL — so it sits at the
    // wrong x-offset next to the ISO zero-fill points.
    mockQuery.mockResolvedValue(
      mockJsonResponse([{ timestamp: '2026-01-01 00:00:00', avgScore: '0.85', count: '100' }])
    );

    const result = await service.getScoreTrend(testCtx, 'accuracy', 'day', DATE_RANGE);

    const dataPoint = result.points.find((p) => p.count > 0)!;
    expect(dataPoint.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('should return trend points for hour interval', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([
        { timestamp: '2026-01-01 10:00:00', avgScore: '0.75', count: '50' },
      ])
    );

    const result = await service.getScoreTrend(testCtx, 'accuracy', 'hour', DATE_RANGE);

    expect(result.name).toBe('accuracy');
    expect(result.interval).toBe('hour');
    const dataPoints = result.points.filter((p) => p.count > 0);
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0]!.avgScore).toBe(0.75);
    expect(dataPoints[0]!.count).toBe(50);
  });

  it('should return trend points for week interval', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([
        { timestamp: '2026-01-06 00:00:00', avgScore: '0.82', count: '500' },
        { timestamp: '2026-01-13 00:00:00', avgScore: '0.88', count: '480' },
      ])
    );

    const result = await service.getScoreTrend(testCtx, 'accuracy', 'week', DATE_RANGE);

    expect(result.interval).toBe('week');
    const dataPoints = result.points.filter((p) => p.count > 0);
    expect(dataPoints).toHaveLength(2);
  });

  it('should return empty points when no data exists', async () => {
    mockQuery.mockResolvedValue(mockJsonResponse([]));

    const result = await service.getScoreTrend(testCtx, 'empty_score', 'day', DATE_RANGE);

    expect(result.name).toBe('empty_score');
    expect(result.interval).toBe('day');
    expect(result.points).toEqual([]);
  });

  it('should convert string values to numbers in trend points', async () => {
    mockQuery.mockResolvedValue(
      mockJsonResponse([
        { timestamp: '2026-01-01 00:00:00', avgScore: '3.14159', count: '999' },
      ])
    );

    const result = await service.getScoreTrend(testCtx, 'precision_score', 'day', DATE_RANGE);

    const dataPoints = result.points.filter((p) => p.count > 0);
    expect(dataPoints).toHaveLength(1);
    expect(typeof dataPoints[0]!.avgScore).toBe('number');
    expect(typeof dataPoints[0]!.count).toBe('number');
    expect(dataPoints[0]!.avgScore).toBeCloseTo(3.14159);
    expect(dataPoints[0]!.count).toBe(999);
  });
});

describe('AnalyticsService.getScoreComparison', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AnalyticsService(mockClient);
  });

  it('should return confusion matrix data for two boolean scores', async () => {
    mockQuery
      // detectScoreType for nameA
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]))
      // detectScoreType for nameB
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]))
      // matrix query
      .mockResolvedValueOnce(
        mockJsonResponse([
          { labelA: 'true', labelB: 'true', count: '80' },
          { labelA: 'true', labelB: 'false', count: '10' },
          { labelA: 'false', labelB: 'true', count: '5' },
          { labelA: 'false', labelB: 'false', count: '15' },
        ])
      )
      // matched count query
      .mockResolvedValueOnce(
        mockJsonResponse([{ totalMatched: '110', totalA: '120', totalB: '115' }])
      );

    const result = await service.getScoreComparison(
      testCtx, 'human_eval', 'ai_eval', DATE_RANGE
    );

    expect(result.nameA).toBe('human_eval');
    expect(result.nameB).toBe('ai_eval');
    expect(result.type).toBe('boolean');
    expect(result.matrix).toEqual([
      { labelA: 'true', labelB: 'true', count: 80 },
      { labelA: 'true', labelB: 'false', count: 10 },
      { labelA: 'false', labelB: 'true', count: 5 },
      { labelA: 'false', labelB: 'false', count: 15 },
    ]);
    expect(result.totalMatched).toBe(110);
    expect(result.totalA).toBe(120);
    expect(result.totalB).toBe(115);
  });

  it('should return confusion matrix data for two categorical scores', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'good' }, { label: 'bad' }]))
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'good' }, { label: 'bad' }]))
      .mockResolvedValueOnce(
        mockJsonResponse([
          { labelA: 'good', labelB: 'good', count: '50' },
          { labelA: 'bad', labelB: 'bad', count: '30' },
        ])
      )
      .mockResolvedValueOnce(
        mockJsonResponse([{ totalMatched: '80', totalA: '90', totalB: '85' }])
      );

    const result = await service.getScoreComparison(
      testCtx, 'reviewer1', 'reviewer2', DATE_RANGE
    );

    expect(result.type).toBe('categorical');
    expect(result.matrix).toHaveLength(2);
  });

  it('should throw when first score is numeric', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([]))  // numeric
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]));

    await expect(
      service.getScoreComparison(testCtx, 'numeric_score', 'bool_score', DATE_RANGE)
    ).rejects.toThrow('Score type mismatch: cannot compare numeric scores in confusion matrix');
  });

  it('should throw when second score is numeric', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]))
      .mockResolvedValueOnce(mockJsonResponse([]));  // numeric

    await expect(
      service.getScoreComparison(testCtx, 'bool_score', 'numeric_score', DATE_RANGE)
    ).rejects.toThrow('Score type mismatch: cannot compare numeric scores in confusion matrix');
  });

  it('should throw when both scores are numeric', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    await expect(
      service.getScoreComparison(testCtx, 'score_a', 'score_b', DATE_RANGE)
    ).rejects.toThrow('Score type mismatch: cannot compare numeric scores in confusion matrix');
  });

  it('should throw when score types differ between boolean and categorical', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]))
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'good' }, { label: 'bad' }]));

    await expect(
      service.getScoreComparison(testCtx, 'bool_score', 'cat_score', DATE_RANGE)
    ).rejects.toThrow('Score type mismatch: cannot compare boolean and categorical scores');
  });

  it('should handle empty matched count data gracefully', async () => {
    mockQuery
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]))
      .mockResolvedValueOnce(mockJsonResponse([{ label: 'true' }, { label: 'false' }]))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));  // empty count

    const result = await service.getScoreComparison(
      testCtx, 'score_a', 'score_b', DATE_RANGE
    );

    expect(result.matrix).toEqual([]);
    expect(result.totalMatched).toBe(0);
    expect(result.totalA).toBe(0);
    expect(result.totalB).toBe(0);
  });
});
