import { describe, expect, test } from 'vitest';
import {
  METRICS_BREAKDOWN_DIMENSIONS,
  ModelStatsQuerySchema,
  FleetOverviewQuerySchema,
  CompareWindowsQuerySchema,
  MetricsBreakdownQuerySchema,
  MetricsBreakdownResponseSchema,
  MetricsTrendsQuerySchema,
  MetricsTrendsResponseSchema,
  PrOutcomesResponseSchema,
} from '../schemas/metrics';

describe('MetricsBreakdownQuerySchema', () => {
  test('requires dimension and rejects a value outside the closed vocabulary', () => {
    expect(MetricsBreakdownQuerySchema.safeParse({}).success).toBe(false);
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'actor' }).success).toBe(false);
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'branch' }).success).toBe(true);
  });

  // proves AC-052-15
  test('never allows an actor dimension — the privacy invariant closes the vocabulary', () => {
    expect(METRICS_BREAKDOWN_DIMENSIONS).not.toContain('actor');
  });

  test('defaults limit to 10 and rejects a limit above 50', () => {
    expect(MetricsBreakdownQuerySchema.parse({ dimension: 'tool' }).limit).toBe(10);
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'tool', limit: 51 }).success).toBe(false);
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'tool', limit: 50 }).success).toBe(true);
  });

  // A far-future `to` reaches ClickHouse's DateTime range and throws there
  // instead of failing input validation — rejected here at the schema
  // instead, the same way spans/scores' date filters already are.
  test('rejects a from/to outside ClickHouse\'s representable date range', () => {
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'tool', to: '4000-01-01' }).success).toBe(false);
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'tool', from: '1900-01-01' }).success).toBe(false);
    expect(MetricsBreakdownQuerySchema.safeParse({ dimension: 'tool', from: '2026-01-01', to: '2026-02-01' }).success).toBe(true);
  });
});

describe('MetricsBreakdownResponseSchema', () => {
  test('accepts a tool-dimension row carrying requests instead of sessions/costUsd', () => {
    const result = MetricsBreakdownResponseSchema.safeParse({
      data: { dimension: 'tool', items: [{ key: 'bash', requests: 20, toolErrorRate: 0.1 }] },
    });
    expect(result.success).toBe(true);
  });

  test('accepts a branch-dimension row carrying sessions + costUsd', () => {
    const result = MetricsBreakdownResponseSchema.safeParse({
      data: { dimension: 'branch', items: [{ key: 'main', sessions: 8, costUsd: 12.5, toolErrorRate: 0 }] },
    });
    expect(result.success).toBe(true);
  });

  test('rejects a non-numeric costUsd', () => {
    const result = MetricsBreakdownResponseSchema.safeParse({
      data: { dimension: 'branch', items: [{ key: 'main', costUsd: 'a lot' }] },
    });
    expect(result.success).toBe(false);
  });
});

describe('MetricsTrendsQuerySchema', () => {
  test('accepts an empty query (both bounds default at the route)', () => {
    expect(MetricsTrendsQuerySchema.safeParse({}).success).toBe(true);
  });

  test('rejects a non-date from/to', () => {
    expect(MetricsTrendsQuerySchema.safeParse({ from: 'not-a-date' }).success).toBe(false);
  });

  test('rejects a from/to outside ClickHouse\'s representable date range', () => {
    expect(MetricsTrendsQuerySchema.safeParse({ from: '2000-01-01', to: '4000-01-01' }).success).toBe(false);
  });
});

describe('ModelStatsQuerySchema', () => {
  test('rejects a from/to outside ClickHouse\'s representable date range', () => {
    expect(ModelStatsQuerySchema.safeParse({ from: '2000-01-01', to: '4000-01-01' }).success).toBe(false);
    expect(ModelStatsQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-07' }).success).toBe(true);
  });
});

describe('FleetOverviewQuerySchema', () => {
  test('rejects a from/to outside ClickHouse\'s representable date range', () => {
    expect(FleetOverviewQuerySchema.safeParse({ from: '2000-01-01', to: '4000-01-01' }).success).toBe(false);
    expect(FleetOverviewQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success).toBe(true);
  });
});

describe('CompareWindowsQuerySchema', () => {
  test('rejects a from/to outside ClickHouse\'s representable date range on either window', () => {
    const validWindow = { aFrom: '2026-01-01', aTo: '2026-01-07', bFrom: '2026-02-01', bTo: '2026-02-07' };
    expect(CompareWindowsQuerySchema.safeParse(validWindow).success).toBe(true);
    expect(CompareWindowsQuerySchema.safeParse({ ...validWindow, aFrom: '4000-01-01' }).success).toBe(false);
    expect(CompareWindowsQuerySchema.safeParse({ ...validWindow, bTo: '4000-01-01' }).success).toBe(false);
  });
});

describe('MetricsTrendsResponseSchema', () => {
  test('accepts a well-formed daily point', () => {
    const result = MetricsTrendsResponseSchema.safeParse({
      data: { points: [{ date: '2026-08-01', sessions: 5, costUsd: 10.5, toolErrorRate: 0.1, cleanSessionRate: 0.8 }] },
    });
    expect(result.success).toBe(true);
  });

  test('rejects a point missing cleanSessionRate', () => {
    const result = MetricsTrendsResponseSchema.safeParse({
      data: { points: [{ date: '2026-08-01', sessions: 5, costUsd: 10.5, toolErrorRate: 0.1 }] },
    });
    expect(result.success).toBe(false);
  });
});

describe('PrOutcomesResponseSchema', () => {
  test('accepts the attribution set merged with per-item cost', () => {
    const result = PrOutcomesResponseSchema.safeParse({
      data: {
        branches: ['main'],
        prNumbers: [42],
        steeredPrNumbers: [],
        items: [{ repo: 'org/app', branch: 'main', prNumber: 42, steered: false, costUsd: 3.5 }],
      },
    });
    expect(result.success).toBe(true);
  });

  test('rejects an item missing costUsd', () => {
    const result = PrOutcomesResponseSchema.safeParse({
      data: {
        branches: [],
        prNumbers: [],
        steeredPrNumbers: [],
        items: [{ repo: 'org/app', branch: 'main', prNumber: 42, steered: false }],
      },
    });
    expect(result.success).toBe(false);
  });
});
