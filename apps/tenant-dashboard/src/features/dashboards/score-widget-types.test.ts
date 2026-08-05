/**
 * Unit Tests for Score Widget Types
 *
 * Tests that score metrics are properly registered in the widget type system.
 */

vi.mock('server-only', () => ({}));

import {
  BUILT_IN_METRICS,
  METRIC_LABELS,
  ALL_METRIC_IDS,
  SCORE_METRICS,
  isScoreMetric,
} from './types';

// ============================================================================
// Score Metrics Registration
// ============================================================================

describe('Score metrics in BUILT_IN_METRICS', () => {
  it('should include score_summary when checked', () => {
    expect(BUILT_IN_METRICS).toContain('score_summary');
  });

  it('should include score_histogram when checked', () => {
    expect(BUILT_IN_METRICS).toContain('score_histogram');
  });

  it('should include score_trend when checked', () => {
    expect(BUILT_IN_METRICS).toContain('score_trend');
  });

  it('should include score_comparison when checked', () => {
    expect(BUILT_IN_METRICS).toContain('score_comparison');
  });
});

// ============================================================================
// Score Metric Labels
// ============================================================================

describe('Score metric labels', () => {
  it('should have a label for score_summary when looked up', () => {
    expect(METRIC_LABELS['score_summary']).toBe('Score Summary');
  });

  it('should have a label for score_histogram when looked up', () => {
    expect(METRIC_LABELS['score_histogram']).toBe('Score Distribution');
  });

  it('should have a label for score_trend when looked up', () => {
    expect(METRIC_LABELS['score_trend']).toBe('Score Trend');
  });

  it('should have a label for score_comparison when looked up', () => {
    expect(METRIC_LABELS['score_comparison']).toBe('Score Comparison');
  });
});

// ============================================================================
// ALL_METRIC_IDS includes score metrics
// ============================================================================

describe('ALL_METRIC_IDS includes score metrics', () => {
  it('should contain all 4 score metrics when checked', () => {
    expect(ALL_METRIC_IDS).toContain('score_summary');
    expect(ALL_METRIC_IDS).toContain('score_histogram');
    expect(ALL_METRIC_IDS).toContain('score_trend');
    expect(ALL_METRIC_IDS).toContain('score_comparison');
  });
});

// ============================================================================
// SCORE_METRICS constant
// ============================================================================

describe('SCORE_METRICS', () => {
  it('should contain exactly 4 score metric IDs when counted', () => {
    expect(SCORE_METRICS).toHaveLength(4);
  });

  it('should contain score_summary, score_histogram, score_trend, score_comparison', () => {
    expect(SCORE_METRICS).toContain('score_summary');
    expect(SCORE_METRICS).toContain('score_histogram');
    expect(SCORE_METRICS).toContain('score_trend');
    expect(SCORE_METRICS).toContain('score_comparison');
  });
});

// ============================================================================
// isScoreMetric
// ============================================================================

describe('isScoreMetric', () => {
  it('should return true when given score_summary', () => {
    expect(isScoreMetric('score_summary')).toBe(true);
  });

  it('should return true when given score_histogram', () => {
    expect(isScoreMetric('score_histogram')).toBe(true);
  });

  it('should return true when given score_trend', () => {
    expect(isScoreMetric('score_trend')).toBe(true);
  });

  it('should return true when given score_comparison', () => {
    expect(isScoreMetric('score_comparison')).toBe(true);
  });

  it('should return false when given request_count', () => {
    expect(isScoreMetric('request_count')).toBe(false);
  });

  it('should return false when given an empty string', () => {
    expect(isScoreMetric('')).toBe(false);
  });

  it('should return false when given a derived metric ID', () => {
    expect(isScoreMetric('cost_per_request')).toBe(false);
  });
});
