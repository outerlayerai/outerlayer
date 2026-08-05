/**
 * Behavioral coverage for the scores/score-analytics SQL builders in
 * queries.ts. These builders gate on optional `sessionId` / `source` /
 * `envClause` inputs to splice WHERE fragments and params. An unexercised
 * branch here ships silently — a wrong fragment, dropped param, or inverted
 * condition still returns rows. Each test pins one branch.
 */

import { describe, it, expect } from 'vitest';
import {
  SCORES_LIST_QUERY,
  SCORES_COUNT_QUERY,
  buildScoresListQuery,
  buildScoresCountQuery,
  buildScoreHistogramQuery,
  buildScoreCategoryCountsQuery,
  buildScoreTrendQuery,
  type ScoreAnalyticsInput,
} from '../queries';

const BASE: ScoreAnalyticsInput = {
  appId: 'app-1',
  tenantId: 'tenant-1',
  startDate: '2026-01-01 00:00:00.000',
  endDate: '2026-01-31 23:59:59.999',
  retentionCutoff: '2025-01-01 00:00:00.000',
  name: 'correctness',
};

describe('buildScoresListQuery', () => {
  it('returns the unmodified SCORES_LIST_QUERY when neither sessionId nor envClause is set', () => {
    expect(buildScoresListQuery({})).toBe(SCORES_LIST_QUERY);
  });

  it('splices the session filter (and diverges from the base query) when sessionId is set', () => {
    const q = buildScoresListQuery({ sessionId: 'sess-1' });
    expect(q).not.toBe(SCORES_LIST_QUERY);
    expect(q).toContain('SessionId = {sessionId:String}');
    expect(q).toContain('ORDER BY CreatedAt DESC');
  });

  it('splices the env clause when only envClause is set', () => {
    const q = buildScoresListQuery({ envClause: "AND Environment = 'prod'" });
    expect(q).not.toBe(SCORES_LIST_QUERY);
    expect(q).toContain("AND Environment = 'prod'");
    expect(q).not.toContain('SessionId = {sessionId:String}');
  });

  it('splices both fragments when sessionId and envClause are set', () => {
    const q = buildScoresListQuery({ sessionId: 'sess-1', envClause: "AND Environment = 'prod'" });
    expect(q).toContain('SessionId = {sessionId:String}');
    expect(q).toContain("AND Environment = 'prod'");
  });
});

describe('buildScoresCountQuery', () => {
  it('returns the unmodified SCORES_COUNT_QUERY when neither sessionId nor envClause is set', () => {
    expect(buildScoresCountQuery({})).toBe(SCORES_COUNT_QUERY);
  });

  it('splices the session filter when sessionId is set', () => {
    const q = buildScoresCountQuery({ sessionId: 'sess-1' });
    expect(q).not.toBe(SCORES_COUNT_QUERY);
    expect(q).toContain('SessionId = {sessionId:String}');
    expect(q).toContain('count(*) as total');
  });

  it('splices the env clause when only envClause is set', () => {
    const q = buildScoresCountQuery({ envClause: "AND Environment = 'prod'" });
    expect(q).not.toBe(SCORES_COUNT_QUERY);
    expect(q).toContain("AND Environment = 'prod'");
    expect(q).not.toContain('SessionId = {sessionId:String}');
  });
});

describe('buildScoreHistogramQuery', () => {
  const histInput = { ...BASE, minScore: 0, maxScore: 1, bucketWidth: 0.1 };

  it('includes the Source filter + source param when source is set', () => {
    const { query, params } = buildScoreHistogramQuery({ ...histInput, source: 'human' });
    expect(query).toContain('AND Source = {source:String}');
    expect(params.source).toBe('human');
  });

  it('omits the Source filter + source param when source is absent', () => {
    const { query, params } = buildScoreHistogramQuery(histInput);
    expect(query).not.toContain('AND Source = {source:String}');
    expect(params).not.toHaveProperty('source');
  });

  it('splices the env clause when set', () => {
    const { query } = buildScoreHistogramQuery({ ...histInput, envClause: "AND Environment = 'prod'" });
    expect(query).toContain("AND Environment = 'prod'");
  });
});

describe('buildScoreCategoryCountsQuery', () => {
  it('includes the Source filter + source param when source is set', () => {
    const { query, params } = buildScoreCategoryCountsQuery({ ...BASE, source: 'llm' });
    expect(query).toContain('AND Source = {source:String}');
    expect(params.source).toBe('llm');
  });

  it('omits the Source filter + source param when source is absent', () => {
    const { query, params } = buildScoreCategoryCountsQuery(BASE);
    expect(query).not.toContain('AND Source = {source:String}');
    expect(params).not.toHaveProperty('source');
  });
});

describe('buildScoreTrendQuery', () => {
  it('interpolates the groupExpr and includes the Source filter when source is set', () => {
    const { query, params } = buildScoreTrendQuery({ ...BASE, source: 'human' }, 'toStartOfHour(CreatedAt)');
    expect(query).toContain('toStartOfHour(CreatedAt) AS timestamp');
    expect(query).toContain('AND Source = {source:String}');
    expect(params.source).toBe('human');
  });

  it('omits the Source filter + source param when source is absent', () => {
    const { query, params } = buildScoreTrendQuery(BASE, 'toStartOfDay(CreatedAt)');
    expect(query).toContain('toStartOfDay(CreatedAt) AS timestamp');
    expect(query).not.toContain('AND Source = {source:String}');
    expect(params).not.toHaveProperty('source');
  });
});
