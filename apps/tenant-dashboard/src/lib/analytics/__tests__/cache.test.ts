/**
 * parseDateRange tests
 *
 * Covers preset → DateRange conversion. The '24h' case carries a hidden
 * contract: MetricsService treats `start === end` as a signal to switch to hourly
 * granularity (services/metrics.ts: useHourlyGranularity), so '24h' must
 * map to today/today, not a multi-day window.
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
}));

vi.mock('../service', () => ({
  getAnalyticsService: () => null,
}));

import { parseDateRange } from '../cache';

describe('parseDateRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T15:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps "24h" to today/today so MetricsService picks hourly granularity', () => {
    const range = parseDateRange('24h');
    expect(range).toEqual({ start: '2026-04-29', end: '2026-04-29' });
    // start === end is the contract MetricsService relies on for hourly bucketing
    expect(range.start).toBe(range.end);
  });

  it('maps "today" to today/today', () => {
    expect(parseDateRange('today')).toEqual({ start: '2026-04-29', end: '2026-04-29' });
  });

  it('maps "yesterday" to yesterday/yesterday', () => {
    expect(parseDateRange('yesterday')).toEqual({ start: '2026-04-28', end: '2026-04-28' });
  });

  it('maps "7d" to seven-days-ago/today', () => {
    expect(parseDateRange('7d')).toEqual({ start: '2026-04-22', end: '2026-04-29' });
  });

  it('maps "30d" to thirty-days-ago/today', () => {
    expect(parseDateRange('30d')).toEqual({ start: '2026-03-30', end: '2026-04-29' });
  });

  it('maps "90d" to ninety-days-ago/today', () => {
    expect(parseDateRange('90d')).toEqual({ start: '2026-01-29', end: '2026-04-29' });
  });

  it('passes through "custom" with provided start/end', () => {
    expect(parseDateRange('custom', '2026-01-01', '2026-01-15')).toEqual({
      start: '2026-01-01',
      end: '2026-01-15',
    });
  });

  it('falls back to today/today for unknown presets', () => {
    expect(parseDateRange('bogus')).toEqual({ start: '2026-04-29', end: '2026-04-29' });
  });
});
