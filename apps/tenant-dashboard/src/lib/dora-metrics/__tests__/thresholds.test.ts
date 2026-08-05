// ---------------------------------------------------------------------------
// DORA Metrics - Threshold Classification Tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
  classifyPerformanceLevel,
  DORA_THRESHOLDS,
  PERFORMANCE_LEVEL_COLORS,
  DORA_METRIC_CONFIGS,
} from '../thresholds';
import type { DoraMetricType, PerformanceLevel } from '../types';

// ---------------------------------------------------------------------------
// classifyPerformanceLevel
// ---------------------------------------------------------------------------

describe('classifyPerformanceLevel', () => {
  // -------------------------------------------------------------------------
  // deployment_frequency (higher is better)
  // -------------------------------------------------------------------------

  describe('deployment_frequency (higher is better)', () => {
    it('should return elite when value is well above 1 deploy/day', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 2.0)).toBe('elite');
    });

    it('should return elite when value is exactly 1 deploy/day', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 1.0)).toBe('elite');
    });

    it('should return high when value is between weekly and daily', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 0.5)).toBe('high');
    });

    it('should return high when value is exactly 1/7 (weekly)', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 1 / 7)).toBe('high');
    });

    it('should return medium when value is between monthly and weekly', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 0.05)).toBe('medium');
    });

    it('should return medium when value is exactly 1/30 (monthly)', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 1 / 30)).toBe('medium');
    });

    it('should return low when value is below monthly', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 0.01)).toBe('low');
    });

    it('should return low when value is 0', () => {
      expect(classifyPerformanceLevel('deployment_frequency', 0)).toBe('low');
    });
  });

  // -------------------------------------------------------------------------
  // lead_time (lower is better)
  // -------------------------------------------------------------------------

  describe('lead_time (lower is better)', () => {
    it('should return elite when value is under 1 hour', () => {
      expect(classifyPerformanceLevel('lead_time', 0.5)).toBe('elite');
    });

    it('should return high when value is between 1 and 24 hours', () => {
      expect(classifyPerformanceLevel('lead_time', 12)).toBe('high');
    });

    it('should return high when value is exactly 1 hour', () => {
      // value >= elite threshold (1), so not elite; value < high threshold (24), so high
      expect(classifyPerformanceLevel('lead_time', 1)).toBe('high');
    });

    it('should return medium when value is between 24 hours and 168 hours', () => {
      expect(classifyPerformanceLevel('lead_time', 72)).toBe('medium');
    });

    it('should return medium when value is exactly 24 hours', () => {
      expect(classifyPerformanceLevel('lead_time', 24)).toBe('medium');
    });

    it('should return low when value is 168 hours or more', () => {
      expect(classifyPerformanceLevel('lead_time', 200)).toBe('low');
    });

    it('should return low when value is exactly 168 hours', () => {
      expect(classifyPerformanceLevel('lead_time', 168)).toBe('low');
    });

    it('should return elite when value is 0', () => {
      expect(classifyPerformanceLevel('lead_time', 0)).toBe('elite');
    });
  });

  // -------------------------------------------------------------------------
  // change_failure_rate (lower is better)
  // -------------------------------------------------------------------------

  describe('change_failure_rate (lower is better)', () => {
    it('should return elite when value is well below 15%', () => {
      expect(classifyPerformanceLevel('change_failure_rate', 5)).toBe('elite');
    });

    it('should return elite when value is just below 15%', () => {
      expect(classifyPerformanceLevel('change_failure_rate', 14.99)).toBe('elite');
    });

    it('should return medium when value is exactly 15%', () => {
      // elite and high thresholds are both 15; value < 15 is elite/high,
      // value === 15 is NOT < 15, so it falls through to medium (< 30)
      expect(classifyPerformanceLevel('change_failure_rate', 15)).toBe('medium');
    });

    it('should return medium when value is between 15% and 30%', () => {
      expect(classifyPerformanceLevel('change_failure_rate', 20)).toBe('medium');
    });

    it('should return medium when value is just below 30%', () => {
      expect(classifyPerformanceLevel('change_failure_rate', 29.99)).toBe('medium');
    });

    it('should return low when value is above 30%', () => {
      expect(classifyPerformanceLevel('change_failure_rate', 50)).toBe('low');
    });

    it('should return low when value is exactly 30%', () => {
      // value < 30 check fails for value === 30
      expect(classifyPerformanceLevel('change_failure_rate', 30)).toBe('low');
    });

    it('should return elite when value is 0%', () => {
      expect(classifyPerformanceLevel('change_failure_rate', 0)).toBe('elite');
    });
  });

  // -------------------------------------------------------------------------
  // mttr (lower is better)
  // -------------------------------------------------------------------------

  describe('mttr (lower is better)', () => {
    it('should return elite when value is under 1 hour', () => {
      expect(classifyPerformanceLevel('mttr', 0.5)).toBe('elite');
    });

    it('should return high when value is between 1 and 24 hours', () => {
      expect(classifyPerformanceLevel('mttr', 12)).toBe('high');
    });

    it('should return high when value is exactly 1 hour', () => {
      expect(classifyPerformanceLevel('mttr', 1)).toBe('high');
    });

    it('should return medium when value is between 24 and 168 hours', () => {
      expect(classifyPerformanceLevel('mttr', 100)).toBe('medium');
    });

    it('should return medium when value is exactly 24 hours', () => {
      expect(classifyPerformanceLevel('mttr', 24)).toBe('medium');
    });

    it('should return low when value is 168 hours or more', () => {
      expect(classifyPerformanceLevel('mttr', 200)).toBe('low');
    });

    it('should return low when value is exactly 168 hours', () => {
      expect(classifyPerformanceLevel('mttr', 168)).toBe('low');
    });

    it('should return elite when value is 0', () => {
      expect(classifyPerformanceLevel('mttr', 0)).toBe('elite');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return low when value is NaN', () => {
      expect(classifyPerformanceLevel('deployment_frequency', NaN)).toBe('low');
    });

    it('should return low when value is NaN for lower-is-better metric', () => {
      expect(classifyPerformanceLevel('lead_time', NaN)).toBe('low');
    });

    it('should return low when deployment_frequency value is negative', () => {
      expect(classifyPerformanceLevel('deployment_frequency', -1)).toBe('low');
    });

    it('should return elite when lead_time value is negative', () => {
      // Negative is less than all thresholds, so passes elite check (value < 1)
      expect(classifyPerformanceLevel('lead_time', -1)).toBe('elite');
    });

    it('should return elite when mttr value is very small positive', () => {
      expect(classifyPerformanceLevel('mttr', 0.001)).toBe('elite');
    });

    it('should return low when deployment_frequency value is very small positive', () => {
      // 0.001 < 1/30 (~0.033), so low
      expect(classifyPerformanceLevel('deployment_frequency', 0.001)).toBe('low');
    });

    const allMetricTypes: DoraMetricType[] = [
      'deployment_frequency',
      'lead_time',
      'change_failure_rate',
      'mttr',
    ];

    it.each(allMetricTypes)(
      'should return a valid PerformanceLevel for %s with value 0',
      (metricType) => {
        const result = classifyPerformanceLevel(metricType, 0);
        expect(['elite', 'high', 'medium', 'low']).toContain(result);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// DORA_THRESHOLDS
// ---------------------------------------------------------------------------

describe('DORA_THRESHOLDS', () => {
  const expectedMetrics: DoraMetricType[] = [
    'deployment_frequency',
    'lead_time',
    'change_failure_rate',
    'mttr',
  ];

  it('should define thresholds for all four DORA metrics', () => {
    const keys = Object.keys(DORA_THRESHOLDS);
    expect(keys).toHaveLength(4);
    for (const metric of expectedMetrics) {
      expect(DORA_THRESHOLDS).toHaveProperty(metric);
    }
  });

  it.each(expectedMetrics)(
    'should have elite, high, and medium thresholds for %s',
    (metric) => {
      const thresholds = DORA_THRESHOLDS[metric];
      expect(thresholds).toHaveProperty('elite');
      expect(thresholds).toHaveProperty('high');
      expect(thresholds).toHaveProperty('medium');
      expect(thresholds).toHaveProperty('higherIsBetter');
      expect(typeof thresholds.elite).toBe('number');
      expect(typeof thresholds.high).toBe('number');
      expect(typeof thresholds.medium).toBe('number');
      expect(typeof thresholds.higherIsBetter).toBe('boolean');
    },
  );

  it('should mark only deployment_frequency as higherIsBetter', () => {
    expect(DORA_THRESHOLDS.deployment_frequency.higherIsBetter).toBe(true);
    expect(DORA_THRESHOLDS.lead_time.higherIsBetter).toBe(false);
    expect(DORA_THRESHOLDS.change_failure_rate.higherIsBetter).toBe(false);
    expect(DORA_THRESHOLDS.mttr.higherIsBetter).toBe(false);
  });

  it('should have elite >= high >= medium for higherIsBetter metric', () => {
    const df = DORA_THRESHOLDS.deployment_frequency;
    expect(df.elite).toBeGreaterThanOrEqual(df.high);
    expect(df.high).toBeGreaterThanOrEqual(df.medium);
  });

  it('should have elite <= high <= medium for lowerIsBetter metrics', () => {
    for (const metric of ['lead_time', 'mttr'] as DoraMetricType[]) {
      const t = DORA_THRESHOLDS[metric];
      expect(t.elite).toBeLessThanOrEqual(t.high);
      expect(t.high).toBeLessThanOrEqual(t.medium);
    }
  });
});

// ---------------------------------------------------------------------------
// PERFORMANCE_LEVEL_COLORS
// ---------------------------------------------------------------------------

describe('PERFORMANCE_LEVEL_COLORS', () => {
  const expectedLevels: PerformanceLevel[] = ['elite', 'high', 'medium', 'low'];

  it('should define colors for all four performance levels', () => {
    for (const level of expectedLevels) {
      expect(PERFORMANCE_LEVEL_COLORS).toHaveProperty(level);
    }
  });

  it.each(expectedLevels)(
    'should have a valid hex color string for %s',
    (level) => {
      const color = PERFORMANCE_LEVEL_COLORS[level];
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    },
  );
});

// ---------------------------------------------------------------------------
// DORA_METRIC_CONFIGS
// ---------------------------------------------------------------------------

describe('DORA_METRIC_CONFIGS', () => {
  it('should contain exactly 4 metric configurations', () => {
    expect(DORA_METRIC_CONFIGS).toHaveLength(4);
  });

  it('should include all four DORA metric keys', () => {
    const keys = DORA_METRIC_CONFIGS.map((c) => c.key);
    expect(keys).toContain('deployment_frequency');
    expect(keys).toContain('lead_time');
    expect(keys).toContain('change_failure_rate');
    expect(keys).toContain('mttr');
  });

  it.each(DORA_METRIC_CONFIGS)(
    'should have required fields for $key',
    (config) => {
      expect(typeof config.key).toBe('string');
      expect(typeof config.title).toBe('string');
      expect(config.title.length).toBeGreaterThan(0);
      expect(typeof config.unit).toBe('string');
      expect(config.unit.length).toBeGreaterThan(0);
      expect(typeof config.formatValue).toBe('function');
      expect(typeof config.higherIsBetter).toBe('boolean');
    },
  );

  // -------------------------------------------------------------------------
  // formatValue tests per metric
  // -------------------------------------------------------------------------

  describe('formatValue', () => {
    function findConfig(key: DoraMetricType) {
      const config = DORA_METRIC_CONFIGS.find((c) => c.key === key);
      if (!config) throw new Error(`Config not found for ${key}`);
      return config;
    }

    describe('deployment_frequency', () => {
      it('should format value with one decimal place', () => {
        const config = findConfig('deployment_frequency');
        expect(config.formatValue(2.345)).toBe('2.3');
      });

      it('should format zero as 0.0', () => {
        const config = findConfig('deployment_frequency');
        expect(config.formatValue(0)).toBe('0.0');
      });

      it('should format integer as N.0', () => {
        const config = findConfig('deployment_frequency');
        expect(config.formatValue(3)).toBe('3.0');
      });
    });

    describe('lead_time (duration format)', () => {
      it('should format sub-hour values as minutes', () => {
        const config = findConfig('lead_time');
        expect(config.formatValue(0.5)).toBe('30m');
      });

      it('should format values between 1 and 24 as hours', () => {
        const config = findConfig('lead_time');
        expect(config.formatValue(12)).toBe('12.0h');
      });

      it('should format values >= 24 as days', () => {
        const config = findConfig('lead_time');
        expect(config.formatValue(48)).toBe('2.0d');
      });

      it('should format 0 hours as 0m', () => {
        const config = findConfig('lead_time');
        expect(config.formatValue(0)).toBe('0m');
      });

      it('should format exactly 1 hour as 1.0h', () => {
        const config = findConfig('lead_time');
        expect(config.formatValue(1)).toBe('1.0h');
      });

      it('should format exactly 24 hours as 1.0d', () => {
        const config = findConfig('lead_time');
        expect(config.formatValue(24)).toBe('1.0d');
      });
    });

    describe('change_failure_rate', () => {
      it('should format value as percentage with one decimal', () => {
        const config = findConfig('change_failure_rate');
        expect(config.formatValue(15.5)).toBe('15.5%');
      });

      it('should format zero as 0.0%', () => {
        const config = findConfig('change_failure_rate');
        expect(config.formatValue(0)).toBe('0.0%');
      });

      it('should format 100 as 100.0%', () => {
        const config = findConfig('change_failure_rate');
        expect(config.formatValue(100)).toBe('100.0%');
      });
    });

    describe('mttr (duration format)', () => {
      it('should format sub-hour values as minutes', () => {
        const config = findConfig('mttr');
        expect(config.formatValue(0.5)).toBe('30m');
      });

      it('should format values between 1 and 24 as hours', () => {
        const config = findConfig('mttr');
        expect(config.formatValue(12)).toBe('12.0h');
      });

      it('should format values >= 24 as days', () => {
        const config = findConfig('mttr');
        expect(config.formatValue(72)).toBe('3.0d');
      });

      it('should format 0 as 0m', () => {
        const config = findConfig('mttr');
        expect(config.formatValue(0)).toBe('0m');
      });
    });
  });
});
