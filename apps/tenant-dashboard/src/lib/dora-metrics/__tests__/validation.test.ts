// ---------------------------------------------------------------------------
// resolveTimeRange - Unit Tests
//
// This function had no direct tests (service tests mock it), which let a
// 24-hour blind spot ship: the window must NOT end at the start of the
// current UTC day, or everything that happened today is hidden (caught by
// the local e2e — a deploy ingested minutes earlier was invisible). These
// tests pin the window invariants for real.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  doraMetricsQuerySchema,
  doraRankingsQuerySchema,
  resolveTimeRange,
} from '../validation';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('resolveTimeRange', () => {
  it('includes the current moment — an event ingested right now falls inside [start, end)', () => {
    const now = Date.now();
    for (const range of ['7d', '30d', '90d'] as const) {
      const { start, end } = resolveTimeRange(range);
      expect(start.getTime()).toBeLessThanOrEqual(now);
      expect(end.getTime()).toBeGreaterThan(now);
    }
  });

  it('ends at the start of the next UTC day', () => {
    const { end } = resolveTimeRange('7d');
    expect(end.getUTCHours()).toBe(0);
    expect(end.getUTCMinutes()).toBe(0);
    expect(end.getUTCSeconds()).toBe(0);
    // Next UTC midnight, computed independently
    const now = new Date();
    const nextUtcMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    expect(end.getTime()).toBe(nextUtcMidnight);
  });

  it('spans exactly N days with an adjacent equal-length previous window', () => {
    for (const [range, days] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const { start, end, previousStart, previousEnd } = resolveTimeRange(range);
      expect(end.getTime() - start.getTime()).toBe(days * MS_PER_DAY);
      expect(previousEnd.getTime()).toBe(start.getTime());
      expect(previousEnd.getTime() - previousStart.getTime()).toBe(days * MS_PER_DAY);
    }
  });

  it('throws on an unknown range', () => {
    expect(() => resolveTimeRange('14d')).toThrow('Invalid time range');
  });
});

// ---------------------------------------------------------------------------
// Query schema validation
//
// Each enum/refine carries a custom `{ message }` config object. An
// ObjectLiteral mutant empties that config to `{}`, which drops the custom
// message and falls back to zod's default. Asserting the exact custom message
// on invalid input (and that valid input parses to the exact shape) kills
// those mutants.
// ---------------------------------------------------------------------------

describe('doraMetricsQuerySchema', () => {
  it('defaults timeRange to 30d when omitted', () => {
    const result = doraMetricsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ timeRange: '30d' });
  });

  it('parses a valid timeRange + service-name appId to the exact shape', () => {
    const result = doraMetricsQuerySchema.safeParse({ timeRange: '7d', appId: 'my-service_1' });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({ timeRange: '7d', appId: 'my-service_1' });
  });

  it('accepts a null appId (nullable) distinctly from an omitted one', () => {
    const withNull = doraMetricsQuerySchema.safeParse({ appId: null });
    expect(withNull.success).toBe(true);
    expect(withNull.data).toStrictEqual({ timeRange: '30d', appId: null });
  });

  // Kills the ObjectLiteral mutant on the timeRange enum `{ message }`.
  it('rejects an invalid timeRange with the custom message', () => {
    const result = doraMetricsQuerySchema.safeParse({ timeRange: '14d' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['timeRange']);
    expect(result.error?.issues[0]?.message).toBe('timeRange must be one of 7d, 30d, 90d');
  });

  // Kills the ObjectLiteral mutant on the appId refine `{ message }`.
  it('rejects an appId with disallowed characters with the custom message', () => {
    const result = doraMetricsQuerySchema.safeParse({ appId: 'bad name!' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['appId']);
    expect(result.error?.issues[0]?.message).toBe(
      'appId must be a valid service name (alphanumeric, hyphens, underscores)',
    );
  });
});

describe('doraRankingsQuerySchema', () => {
  it('applies all three defaults when omitted', () => {
    const result = doraRankingsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({
      timeRange: '30d',
      sortBy: 'deploymentFrequency',
      sortOrder: 'desc',
    });
  });

  it('parses valid overrides to the exact shape', () => {
    const result = doraRankingsQuerySchema.safeParse({
      timeRange: '90d',
      sortBy: 'leadTime',
      sortOrder: 'asc',
    });
    expect(result.success).toBe(true);
    expect(result.data).toStrictEqual({
      timeRange: '90d',
      sortBy: 'leadTime',
      sortOrder: 'asc',
    });
  });

  // Kills the ObjectLiteral mutant on the rankings timeRange enum `{ message }`.
  it('rejects an invalid timeRange with the custom message', () => {
    const result = doraRankingsQuerySchema.safeParse({ timeRange: '14d' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['timeRange']);
    expect(result.error?.issues[0]?.message).toBe('timeRange must be one of 7d, 30d, 90d');
  });

  // Kills the ObjectLiteral mutant on the sortBy enum `{ message }`.
  it('rejects an invalid sortBy with the custom message', () => {
    const result = doraRankingsQuerySchema.safeParse({ sortBy: 'notAField' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['sortBy']);
    expect(result.error?.issues[0]?.message).toBe(
      'sortBy must be one of deploymentFrequency, leadTime, changeFailureRate, mttr',
    );
  });

  // Kills the ObjectLiteral mutant on the sortOrder enum `{ message }`.
  it('rejects an invalid sortOrder with the custom message', () => {
    const result = doraRankingsQuerySchema.safeParse({ sortOrder: 'sideways' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['sortOrder']);
    expect(result.error?.issues[0]?.message).toBe('sortOrder must be one of asc, desc');
  });
});
