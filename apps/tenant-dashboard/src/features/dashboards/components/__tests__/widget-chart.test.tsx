// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WidgetChart } from '../widget-chart';
import type { WidgetTimeSeriesResponse } from '../../types';

// Capture the props each render hands to the Chart wrapper so the tests can
// assert on the assembled ApexOptions — the mock stands in for the dynamic
// ApexCharts import (jsdom can't render it), not for this component's logic.
const captured = vi.hoisted(() => ({ calls: [] as any[] }));

const VIZ = {
  categorical: ['#2065D1', '#008300', '#E87BA4', '#EDA100', '#1BAF7A', '#EB6834', '#4A3AA7', '#E34948'],
  ordinal: ['#6499E6', '#2065D1', '#143F86'],
  grid: '#F0F0ED',
  baseline: '#D5D5D0',
};

vi.mock('@/components/chart', () => ({
  __esModule: true,
  default: (props: any) => {
    captured.calls.push(props);
    return <div data-testid="mock-chart" data-type={props.type} />;
  },
  useChart: (opts: any) => opts,
  useChartScheme: () => ({
    viz: VIZ,
    palette: {
      success: { main: '#2E7D32' },
      error: { main: '#D32F2F' },
      background: { paper: '#FFFFFF' },
    },
    mode: 'light',
  }),
}));

function series(names: string[]): WidgetTimeSeriesResponse {
  return {
    type: 'timeSeries',
    series: names.map((name) => ({
      name,
      data: [
        { x: '2026-07-13T00:00:00Z', y: 1 },
        { x: '2026-07-14T00:00:00Z', y: 2 },
      ],
    })),
  };
}

function lastCall() {
  return captured.calls[captured.calls.length - 1];
}

beforeEach(() => {
  captured.calls.length = 0;
});

describe('WidgetChart series colors', () => {
  it('gives a percentile family ordinal steps of ONE hue, fastest to slowest', () => {
    render(
      <WidgetChart
        data={series(['p50', 'p95', 'p99'])}
        visualization="line"
        metric="agent_session_duration_trend"
      />
    );
    // Positional: p50 lightest → p99 darkest. A hue-per-percentile (the old
    // blue/orange/red) must never come back.
    expect(lastCall().options.colors).toEqual(['#6499E6', '#2065D1', '#143F86']);
    expect(lastCall().type).toBe('line');
  });

  it('gives the 4-series autonomy mix categorical slots 1-4 in fixed order, stacked with surface gaps', () => {
    render(
      <WidgetChart
        data={series(['seat', 'shared', 'ci', 'cloud'])}
        visualization="line"
        metric="agent_autonomy_mix_trend"
      />
    );
    const { options, type } = lastCall();
    expect(type).toBe('area');
    expect(options.colors).toEqual(['#2065D1', '#008300', '#E87BA4', '#EDA100']);
    expect(options.chart).toEqual({ stacked: true });
    // Solid bands separated by a 2px surface-colored stroke — never
    // translucent overlaps, never a data-colored outline.
    expect(options.fill).toEqual({ type: 'solid', opacity: 1 });
    expect(options.stroke).toEqual({ width: 2, colors: ['#FFFFFF'] });
    expect(options.legend.onItemHover).toEqual({ highlightDataSeries: false });
  });

  it('dresses outcome series in semantic tokens (status means status, never a slot)', () => {
    render(<WidgetChart data={series(['success', 'error'])} visualization="line" metric="request_count" />);
    const { options, type } = lastCall();
    expect(options.colors).toEqual(['#2E7D32', '#D32F2F']);
    // request_count's preferred form is an area with a flat 10% wash — no
    // gradient fade.
    expect(type).toBe('area');
    expect(options.fill).toEqual({ type: 'solid', opacity: 0.1 });
  });

  it('gives a single-series chart slot 1 only and hides its legend', () => {
    render(<WidgetChart data={series(['cost'])} visualization="line" metric="total_cost" />);
    const { options, type } = lastCall();
    expect(options.colors).toEqual(['#2065D1']);
    expect(options.legend.show).toBe(false);
    // total_cost prefers bars when the stored visualization is the generic
    // line default.
    expect(type).toBe('bar');
  });

  it('shows the legend for a multi-series chart and shares the tooltip', () => {
    render(
      <WidgetChart
        data={series(['p50', 'p95'])}
        visualization="line"
        metric="cost_per_session_trend"
      />
    );
    const { options } = lastCall();
    expect(options.legend.show).toBe(true);
    expect(options.tooltip.shared).toBe(true);
    expect(options.colors).toEqual(['#6499E6', '#2065D1']);
  });

  it('respects an explicit area/bar visualization over the metric preference', () => {
    render(<WidgetChart data={series(['cost'])} visualization="area" metric="total_cost" />);
    expect(lastCall().type).toBe('area');
  });

  it('keeps the y-axis zeroed with unit-aware labels', () => {
    render(<WidgetChart data={series(['cost'])} visualization="line" metric="total_cost" />);
    const { options } = lastCall();
    expect(options.yaxis.min).toBe(0);
    expect(options.yaxis.forceNiceScale).toBe(true);
    expect(options.yaxis.labels.formatter(12.5)).toBe('$12.50');
  });

  // The full metric → (colors, preferred form) contract, one row per mapped
  // metric. Positional toEqual so a swapped slot, a dropped ramp step, or a
  // silently re-hued series fails here.
  it.each([
    ['unique_users', 1, ['#2065D1'], 'bar'],
    ['avg_latency', 1, ['#2065D1'], 'area'],
    ['p50_latency', 1, ['#6499E6'], 'area'],
    ['p95_latency', 1, ['#2065D1'], 'area'],
    ['p99_latency', 1, ['#143F86'], 'area'],
    ['agent_turn_count_trend', 1, ['#2065D1'], 'line'],
    ['active_actor_trend', 1, ['#2065D1'], 'bar'],
    ['agent_pr_cycle_time_trend', 2, ['#6499E6', '#2065D1'], 'line'],
    ['agent_interventions_trend', 1, ['#2065D1'], 'line'],
    ['pr_size_trend', 1, ['#2065D1'], 'line'],
    ['agent_shipped_autonomy_trend', 4, ['#2065D1', '#008300', '#E87BA4', '#EDA100'], 'area'],
  ] as const)('%s wears %j as a %s', (metric, seriesCount, colors, type) => {
    const names = Array.from({ length: seriesCount }, (_, i) => `s${i + 1}`);
    render(<WidgetChart data={series(names)} visualization="line" metric={metric} />);
    expect(lastCall().options.colors).toEqual([...colors]);
    expect(lastCall().type).toBe(type);
  });

  it('renders the empty state instead of a chart when there are no series', () => {
    render(
      <WidgetChart
        data={{ type: 'timeSeries', series: [] } as unknown as WidgetTimeSeriesResponse}
        visualization="line"
        metric="total_cost"
      />
    );
    expect(screen.getByText('No data available')).toBeInTheDocument();
    expect(captured.calls).toEqual([]);
  });
});
