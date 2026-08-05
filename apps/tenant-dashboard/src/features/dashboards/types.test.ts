/**
 * Unit Tests for Dashboard Types & Constants
 *
 * Tests for type guards, derived metrics, and exported constants.
 */

vi.mock('server-only', () => ({}));

import {
  isDerivedMetric,
  getDerivedMetric,
  DERIVED_METRICS,
  ALL_METRIC_IDS,
  BUILT_IN_METRICS,
  METRIC_LABELS,
  MAX_DASHBOARDS_PER_APP,
  MAX_WIDGETS_PER_DASHBOARD,
  MAX_WIDGET_TITLE_LENGTH,
  VISUALIZATION_TYPES,
  PROMOTED_FILTER_FIELDS,
  isMetadataField,
  getMetadataKey,
} from './types';

// ============================================================================
// isDerivedMetric
// ============================================================================

describe('isDerivedMetric', () => {
  it('should return true when given a derived metric ID like cost_per_request', () => {
    expect(isDerivedMetric('cost_per_request')).toBe(true);
  });

  it('should return true when given any derived metric ID', () => {
    const derivedIds = DERIVED_METRICS.map((m) => m.id);
    for (const id of derivedIds) {
      expect(isDerivedMetric(id)).toBe(true);
    }
  });

  it('should return false when given a built-in metric ID like request_count', () => {
    expect(isDerivedMetric('request_count')).toBe(false);
  });

  it('should return false when given an empty string', () => {
    expect(isDerivedMetric('')).toBe(false);
  });

  it('should return false when given an unknown metric ID', () => {
    expect(isDerivedMetric('nonexistent_metric')).toBe(false);
  });
});

// ============================================================================
// getDerivedMetric
// ============================================================================

describe('getDerivedMetric', () => {
  it('should return the DerivedMetric object when given a valid derived metric ID', () => {
    const result = getDerivedMetric('cost_per_request');
    expect(result!.id).toBe('cost_per_request');
    expect(result!.name).toBe('Cost per Request');
    expect(result!.numerator).toBe('total_cost');
    expect(result!.denominator).toBe('request_count');
  });

  it('should return undefined when given an invalid metric ID', () => {
    expect(getDerivedMetric('nonexistent')).toBeUndefined();
  });

  it('should return undefined when given a built-in metric ID', () => {
    expect(getDerivedMetric('request_count')).toBeUndefined();
  });

  it('should return a metric with all required fields when given any derived metric ID', () => {
    for (const metric of DERIVED_METRICS) {
      const result = getDerivedMetric(metric.id);
      // The looked-up metric must be the one requested (id round-trips).
      expect(result!.id).toBe(metric.id);
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('numerator');
      expect(result).toHaveProperty('denominator');
      expect(result).toHaveProperty('description');
    }
  });
});

// ============================================================================
// DERIVED_METRICS
// ============================================================================

describe('DERIVED_METRICS', () => {
  it('should contain exactly 10 derived metrics when counted', () => {
    expect(DERIVED_METRICS).toHaveLength(10);
  });

  it('should have required fields on every item when inspected', () => {
    for (const metric of DERIVED_METRICS) {
      expect(typeof metric.id).toBe('string');
      expect(metric.id.length).toBeGreaterThan(0);
      expect(typeof metric.name).toBe('string');
      expect(metric.name.length).toBeGreaterThan(0);
      expect(typeof metric.numerator).toBe('string');
      expect(typeof metric.denominator).toBe('string');
    }
  });

  it('should have unique IDs when all derived metric IDs are compared', () => {
    const ids = DERIVED_METRICS.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should reference only built-in metrics as numerator and denominator when validated', () => {
    const builtInSet = new Set<string>(BUILT_IN_METRICS);
    for (const metric of DERIVED_METRICS) {
      expect(builtInSet.has(metric.numerator)).toBe(true);
      expect(builtInSet.has(metric.denominator)).toBe(true);
    }
  });

  it('should include a description string on every item when inspected', () => {
    for (const metric of DERIVED_METRICS) {
      expect(typeof metric.description).toBe('string');
      expect(metric.description.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// ALL_METRIC_IDS
// ============================================================================

describe('ALL_METRIC_IDS', () => {
  it('should contain all built-in metric IDs when checked', () => {
    for (const id of BUILT_IN_METRICS) {
      expect(ALL_METRIC_IDS).toContain(id);
    }
  });

  it('should contain all derived metric IDs when checked', () => {
    for (const metric of DERIVED_METRICS) {
      expect(ALL_METRIC_IDS).toContain(metric.id);
    }
  });

  it('should have total length equal to built-in plus derived count when summed', () => {
    expect(ALL_METRIC_IDS.length).toBe(
      BUILT_IN_METRICS.length + DERIVED_METRICS.length,
    );
  });

  it('should have no duplicate IDs when checked', () => {
    const uniqueIds = new Set(ALL_METRIC_IDS);
    expect(uniqueIds.size).toBe(ALL_METRIC_IDS.length);
  });
});

// ============================================================================
// BUILT_IN_METRICS
// ============================================================================

describe('BUILT_IN_METRICS', () => {
  it('should contain request_count when checked', () => {
    expect(BUILT_IN_METRICS).toContain('request_count');
  });

  it('should contain all expected core metrics when checked', () => {
    const expected = [
      'request_count',
      'total_cost',
      'avg_cost',
      'total_tokens',
      'avg_tokens',
      'unique_users',
      'error_count',
      'error_rate',
      'avg_latency',
      'p50_latency',
      'p95_latency',
      'p99_latency',
      'top_models',
    ];
    for (const metric of expected) {
      expect(BUILT_IN_METRICS).toContain(metric);
    }
  });
});

// ============================================================================
// METRIC_LABELS
// ============================================================================

describe('METRIC_LABELS', () => {
  it('should have a label for every built-in metric when all IDs are checked', () => {
    for (const id of BUILT_IN_METRICS) {
      const label = METRIC_LABELS[id];
      expect(typeof label).toBe('string');
      expect((label as string).length).toBeGreaterThan(0);
    }
  });

  it('should map request_count to "Request Count" when looked up', () => {
    expect(METRIC_LABELS['request_count']).toBe('Request Count');
  });

  it('should map error_rate to "Error Rate (%)" when looked up', () => {
    expect(METRIC_LABELS['error_rate']).toBe('Error Rate (%)');
  });
});

// ============================================================================
// Constants
// ============================================================================

describe('Constants', () => {
  it('should set MAX_DASHBOARDS_PER_APP to 10 when checked', () => {
    expect(MAX_DASHBOARDS_PER_APP).toBe(10);
  });

  it('should set MAX_WIDGETS_PER_DASHBOARD to 25 when checked', () => {
    expect(MAX_WIDGETS_PER_DASHBOARD).toBe(25);
  });

  it('should set MAX_WIDGET_TITLE_LENGTH to 100 when checked', () => {
    expect(MAX_WIDGET_TITLE_LENGTH).toBe(100);
  });
});

// ============================================================================
// isMetadataField & getMetadataKey
// ============================================================================

describe('isMetadataField', () => {
  it('should return true when field starts with "metadata."', () => {
    expect(isMetadataField('metadata.environment')).toBe(true);
  });

  it('should return false when field is a promoted filter like "model"', () => {
    expect(isMetadataField('model')).toBe(false);
  });
});

describe('getMetadataKey', () => {
  it('should extract the key portion when given a "metadata." prefixed field', () => {
    expect(getMetadataKey('metadata.customer_tier')).toBe('customer_tier');
  });
});

// ============================================================================
// VISUALIZATION_TYPES
// ============================================================================

describe('VISUALIZATION_TYPES', () => {
  it('should contain line, bar, area, and stat when checked', () => {
    expect(VISUALIZATION_TYPES).toContain('line');
    expect(VISUALIZATION_TYPES).toContain('bar');
    expect(VISUALIZATION_TYPES).toContain('area');
    expect(VISUALIZATION_TYPES).toContain('stat');
  });

  it('should contain exactly 4 visualization types when counted', () => {
    expect(VISUALIZATION_TYPES).toHaveLength(4);
  });
});

// ============================================================================
// PROMOTED_FILTER_FIELDS
// ============================================================================

describe('PROMOTED_FILTER_FIELDS', () => {
  it('should contain model, user_id, and status when checked', () => {
    expect(PROMOTED_FILTER_FIELDS).toContain('model');
    expect(PROMOTED_FILTER_FIELDS).toContain('user_id');
    expect(PROMOTED_FILTER_FIELDS).toContain('status');
  });
});
