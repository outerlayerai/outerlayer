'use client';

/**
 * WidgetChart Component
 *
 * Renders line, bar, or area charts for widget time-series data in the
 * product chart language: straight 2px lines, flat washes, hairline grid,
 * mono unit-aware axes. Series colors come from the validated viz palette —
 * categorical slots in fixed order, ordinal one-hue steps for percentile
 * families, semantic tokens for series that mean good/bad.
 */

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Palette } from '@mui/material/styles';
import type { VizScheme } from '@repo/design-tokens';
import Chart, { useChart, useChartScheme } from '@/components/chart';
import { fCurrency, fShortenNumber } from '@/utils/format-number';
import type { WidgetTimeSeriesResponse, VisualizationType } from '../types';

interface WidgetChartProps {
  data: WidgetTimeSeriesResponse;
  visualization: VisualizationType;
  metric?: string;
  height?: number;
}

/**
 * Per-metric series colors.
 *  - Single-series charts wear categorical slot 1 (brand blue) only.
 *  - Percentile trends (p50/p95[/p99]) are an ordered family of ONE measure,
 *    so they take ordinal lightness steps of the brand blue, fastest→slowest —
 *    never a hue-per-percentile, which dresses the tail as an alarm.
 *  - The autonomy mixes are 4 nominal series → categorical slots 1–4 in the
 *    fixed order.
 *  - request_count series MEAN clean/errored, so they wear semantic tokens.
 */
const METRIC_COLORS: Record<string, (viz: VizScheme, palette: Palette) => string[]> = {
  request_count: (_, p) => [p.success.main, p.error.main],
  total_cost: (v) => [v.categorical[0]!],
  unique_users: (v) => [v.categorical[0]!],
  avg_latency: (v) => [v.categorical[0]!],
  p50_latency: (v) => [v.ordinal[0]!],
  p95_latency: (v) => [v.ordinal[1]!],
  p99_latency: (v) => [v.ordinal[2]!],
  cost_per_session_trend: (v) => [v.ordinal[0]!, v.ordinal[1]!],
  agent_session_duration_trend: (v) => [...v.ordinal],
  agent_turn_count_trend: (v) => [v.categorical[0]!],
  active_actor_trend: (v) => [v.categorical[0]!],
  agent_pr_cycle_time_trend: (v) => [v.ordinal[0]!, v.ordinal[1]!],
  agent_interventions_trend: (v) => [v.categorical[0]!],
  // Three DIFFERENT measures (error, denial, steered) on one 0–100% axis —
  // nominal series, so categorical hues, not an ordinal family.
  agent_trajectory_signals_trend: (v) => v.categorical.slice(0, 3),
  pr_size_trend: (v) => [v.categorical[0]!],
  // Assisted → Autonomous, human-heavy first so the base band is the most
  // supervised work and the delegated kinds visibly grow on top of it.
  agent_shipped_autonomy_trend: (v) => v.categorical.slice(0, 4),
  // Series order is fixed by the route (seat, shared, ci, cloud) — human-run
  // work leads as the base band, delegated kinds stack on top of it.
  agent_autonomy_mix_trend: (v) => v.categorical.slice(0, 4),
};

/**
 * Preferred chart type per metric — used as a fallback when the stored
 * visualization is the generic 'line' default (i.e. widgets created before
 * the template was updated).
 */
const METRIC_CHART_TYPE: Record<string, 'area' | 'bar' | 'line'> = {
  request_count: 'area',
  total_cost: 'bar',
  unique_users: 'bar',
  avg_latency: 'area',
  p50_latency: 'area',
  p95_latency: 'area',
  p99_latency: 'area',
  cost_per_session_trend: 'line',
  agent_session_duration_trend: 'line',
  agent_turn_count_trend: 'line',
  active_actor_trend: 'bar',
  agent_pr_cycle_time_trend: 'line',
  agent_interventions_trend: 'line',
  agent_trajectory_signals_trend: 'line',
  pr_size_trend: 'line',
  agent_autonomy_mix_trend: 'area',
  agent_shipped_autonomy_trend: 'area',
};

/**
 * Metrics whose multi-series area chart stacks into a composition view —
 * the whole point of the autonomy mix is the share of the total each worker
 * kind holds, which overlapping translucent areas can't show.
 */
const STACKED_METRICS = new Set(['agent_autonomy_mix_trend', 'agent_shipped_autonomy_trend']);

/**
 * Value formatter by metric type, shared by the hover tooltip and the
 * y-axis labels — a chart without a labeled y-axis shows shape with no
 * magnitude, which is useless the moment it's screenshotted or glanced at
 * without a mouse. `axis` variant is compact (tick labels); `tooltip` keeps
 * full precision (e.g. sub-cent per-request costs).
 */
export function getValueFormatter(
  metric: string | undefined,
  variant: 'tooltip' | 'axis'
): (value: number) => string {
  if (metric) {
    if (metric === 'total_cost' || metric === 'avg_cost' || metric === 'cost_per_session_trend') {
      return variant === 'tooltip'
        ? (value: number) => fCurrency(value, 6)
        : (value: number) => fCurrency(value, 2);
    }
    if (metric === 'avg_latency' || metric === 'agent_session_duration_trend' || metric.endsWith('_latency')) {
      return (value: number) => `${fShortenNumber(value / 1000)}s`;
    }
    if (metric === 'agent_pr_cycle_time_trend') {
      return (value: number) => `${fShortenNumber(value)}h`;
    }
    if (metric === 'error_rate' || metric === 'agent_trajectory_signals_trend' || metric.endsWith('_rate')) {
      return (value: number) => `${fShortenNumber(value)}%`;
    }
  }
  // Counts and anything unmapped: compact numbers beat no numbers.
  return (value: number) => fShortenNumber(value);
}

function resolveChartType(visualization: VisualizationType, metric?: string): 'area' | 'bar' | 'line' {
  // If explicitly set to area or bar, respect it
  if (visualization === 'area') return 'area';
  if (visualization === 'bar') return 'bar';
  // 'line' is the generic default, so infer the real type from the metric
  if (visualization === 'line' && metric && metric in METRIC_CHART_TYPE) {
    return METRIC_CHART_TYPE[metric]!;
  }
  return 'line';
}

export function WidgetChart({ data, visualization, metric, height = 250 }: WidgetChartProps) {
  const { palette, viz } = useChartScheme();

  const chartType = resolveChartType(visualization, metric);
  const isArea = chartType === 'area';
  const isMultiSeries = data.series.length > 1;
  const isStacked = Boolean(metric && STACKED_METRICS.has(metric));

  const colorFn = metric ? METRIC_COLORS[metric] : undefined;
  const colors = colorFn ? colorFn(viz, palette) : undefined;

  const tooltipFormatter = getValueFormatter(metric, 'tooltip');
  const axisFormatter = getValueFormatter(metric, 'axis');

  const options = useChart({
    ...(colors ? { colors } : {}),
    ...(isStacked
      ? {
          chart: { stacked: true },
          // A composition wants solid bands separated by a surface-colored
          // stroke (the 2px gap does the separating — never a data-colored
          // outline, never translucent overlaps).
          fill: { type: 'solid', opacity: 1 },
          stroke: { width: 2, colors: [palette.background.paper] },
        }
      : {}),
    xaxis: {
      type: 'datetime',
      labels: {
        datetimeUTC: false,
      },
    },
    // The y-axis is VISIBLE with unit-aware labels ($/s/h/%). min: 0 keeps
    // rate/cost/latency baselines honest instead of Apex auto-zooming into
    // the range.
    yaxis: {
      min: 0,
      forceNiceScale: true,
      labels: { formatter: axisFormatter },
    },
    tooltip: {
      x: { show: true },
      shared: isMultiSeries,
      y: { formatter: tooltipFormatter },
    },
    ...(isArea && !isStacked
      ? {
          // Flat ~10% wash of the series hue — a wash, never a gradient fade.
          fill: { type: 'solid', opacity: 0.1 },
        }
      : {}),
    legend: {
      show: isMultiSeries,
      // On STACKED areas, Apex's legend-hover highlight dims the other
      // series and re-renders the hovered band's fill over the whole stack —
      // hovering "Cloud" painted the entire chart purple. The shared
      // crosshair tooltip is the hover layer; the dimming adds nothing.
      ...(isStacked ? { onItemHover: { highlightDataSeries: false } } : {}),
    },
  });

  if (!data.series || data.series.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height,
        }}
      >
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          No data available
        </Typography>
      </Box>
    );
  }

  const series = data.series.map((s) => ({
    name: s.name,
    data: s.data.map((point) => ({ x: point.x, y: point.y })),
  }));

  return <Chart type={chartType} series={series} options={options} height={height} />;
}
