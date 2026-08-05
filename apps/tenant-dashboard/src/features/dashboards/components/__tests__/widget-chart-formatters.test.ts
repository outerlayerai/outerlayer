// @vitest-environment jsdom
/**
 * getValueFormatter — the unit-aware value formatter shared by chart
 * tooltips and (as of the readability fix) the now-visible y-axis labels.
 * A chart whose y-axis shows "20" for dollars, milliseconds and hours alike
 * is not labeled; these pin the unit per metric family and the
 * compact-vs-precise split between axis ticks and tooltips.
 */
import { describe, it, expect, vi } from 'vitest';

// The chart module imports the ApexCharts wrapper at module level, which is
// browser-only — mock the seam; the formatter under test is pure.
vi.mock('@/components/chart', () => ({
  default: () => null,
  useChart: (opts: unknown) => opts,
}));

import { getValueFormatter } from '../widget-chart';

describe('getValueFormatter', () => {
  it('formats cost metrics as dollars — compact on the axis, full precision in the tooltip', () => {
    expect(getValueFormatter('cost_per_session_trend', 'axis')(12.3)).toBe('$12.30');
    expect(getValueFormatter('total_cost', 'tooltip')(0.000123)).toBe('$0.000123');
  });

  it('formats latency and session-duration metrics as seconds (input is ms)', () => {
    expect(getValueFormatter('p95_latency', 'axis')(1500)).toBe('1.50s');
    expect(getValueFormatter('agent_session_duration_trend', 'axis')(90_000)).toBe('90s');
  });

  it('formats the PR cycle-time trend in hours', () => {
    expect(getValueFormatter('agent_pr_cycle_time_trend', 'axis')(36)).toBe('36h');
  });

  it('formats rate metrics as percentages', () => {
    expect(getValueFormatter('error_rate', 'axis')(4.1)).toBe('4.10%');
  });

  it('falls back to compact numbers for counts and unknown metrics — never a bare unformatted axis', () => {
    expect(getValueFormatter('active_actor_trend', 'axis')(1200)).toBe('1.20k');
    expect(getValueFormatter(undefined, 'axis')(1200)).toBe('1.20k');
  });
});
