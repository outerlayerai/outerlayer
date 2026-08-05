'use client';

// ---------------------------------------------------------------------------
// DoraTrendCharts Component
//
// Renders four area charts in a 2x2 grid showing DORA metric trends over
// time. Uses the project's Chart wrapper + useChart hook for consistent
// theme styling.
// ---------------------------------------------------------------------------

import type { ApexOptions } from 'apexcharts';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardHeader from '@mui/material/CardHeader';
import Grid from '@mui/material/Grid';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

import Chart, { useChart } from '@/components/chart';
import { useDoraTrends } from '@/hooks/dora-metrics/use-dora-trends';
import { DORA_METRIC_CONFIGS } from '@/lib/dora-metrics/thresholds';
import type { DoraTimeRange, DoraTrendsResponse, TrendSeries } from '@/lib/dora-metrics/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps from DORA_METRIC_CONFIGS key to the trends response field name. */
const TREND_KEYS: Record<string, keyof DoraTrendsResponse['trends']> = {
  deployment_frequency: 'deploymentFrequency',
  lead_time: 'leadTime',
  change_failure_rate: 'changeFailureRate',
  mttr: 'mttr',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TrendChartCardProps {
  title: string;
  subheader: string;
  trendSeries: TrendSeries;
  formatValue: (value: number) => string;
}

/**
 * Round a trend value for Y-axis tick labels. ApexCharts otherwise renders the
 * raw float straight from the data (e.g. 1.2983552777777778 produces ticks like
 * "1.5000000000000000"); cap at 2 decimals and drop trailing zeros so labels
 * read "1.3", "7.69", "0.4".
 */
export function formatTrendAxisValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 100) / 100);
}

/**
 * Returns the non-null points that have NO adjacent non-null neighbour.
 *
 * An area/line series needs two adjacent points to draw a visible segment, and
 * ApexCharts suppresses `markers.size` for a lone point with nulls on both
 * sides — so a single MTTR incident in the window renders as a blank "noop"
 * chart even though `markers.size: 4` is set (it works for the dense DF/CFR
 * series, which is why those charts show fine). These isolated points are
 * re-rendered by {@link TrendChartCard} as a dedicated scatter overlay series
 * (scatter markers always render), labelled with the metric value. Dense series
 * have no isolated points, so they keep the plain single-area rendering.
 */
export function isolatedTrendPoints(
  series: { x: string; y: number | null }[],
): { x: string; y: number }[] {
  const isolated: { x: string; y: number }[] = [];
  series.forEach((point, i) => {
    if (point.y == null) return;
    const prev = series[i - 1];
    const next = series[i + 1];
    const prevEmpty = !prev || prev.y == null;
    const nextEmpty = !next || next.y == null;
    if (prevEmpty && nextEmpty) {
      isolated.push({ x: point.x, y: point.y });
    }
  });
  return isolated;
}

/** One day / one week in milliseconds — the two trend bucket widths. */
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

interface TrendChartSeries {
  name: string;
  type: 'area' | 'scatter';
  data: { x: string; y: number | null }[];
}

interface TrendChartConfig {
  chartType: 'area' | 'line';
  series: TrendChartSeries[];
  /** Options before the `useChart` theme merge. */
  options: ApexOptions;
}

/**
 * Build the ApexCharts inputs for one trend metric. Pure (no theme/hooks) so the
 * sparse-vs-dense branching is unit-testable without rendering ApexCharts.
 *
 * A point with nulls on both sides can't be drawn by an area/line series, and
 * ApexCharts suppresses markers.size for it — so a sparse metric (e.g. a single
 * MTTR incident in the window) renders as a blank chart. Those isolated points
 * are overlaid as a SCATTER series (scatter markers always render) and labelled
 * with their value, so "one data point" reads as data, not emptiness. When the
 * lone point lands on the final bucket it sits flush against the right frame and
 * is trivially missed, so the x-axis max is nudged out ¾ of a bucket to inset
 * it. Dense series (DF/CFR/lead-time — zero-filled and fully connected) have no
 * isolated points and keep the plain single-area rendering untouched.
 */
export function buildTrendChartConfig(
  title: string,
  trendSeries: TrendSeries,
  formatValue: (value: number) => string,
  primary: string,
): TrendChartConfig {
  const seriesData = trendSeries.series.map((point) => ({ x: point.x, y: point.y }));

  const isolated = isolatedTrendPoints(trendSeries.series);
  const hasIsolated = isolated.length > 0;

  const lastPoint = trendSeries.series[trendSeries.series.length - 1];
  const lastIsolated =
    hasIsolated && lastPoint != null && isolated.some((p) => p.x === lastPoint.x);
  const bucketMs = trendSeries.granularity === 'week' ? WEEK_MS : DAY_MS;
  const xMax = lastIsolated ? new Date(lastPoint.x).getTime() + bucketMs * 0.75 : undefined;

  const chartType: 'area' | 'line' = hasIsolated ? 'line' : 'area';
  const series: TrendChartSeries[] = hasIsolated
    ? [
        { name: title, type: 'area', data: seriesData },
        { name: `${title} (points)`, type: 'scatter', data: isolated },
      ]
    : [{ name: title, type: 'area', data: seriesData }];

  const options: ApexOptions = {
    chart: { type: chartType, sparkline: { enabled: false } },
    // Both series must be the primary colour; otherwise the scatter overlay
    // (series index 1) inherits useChart's 2nd palette colour (warning/orange).
    ...(hasIsolated ? { colors: [primary, primary] } : {}),
    stroke: { curve: 'smooth', width: hasIsolated ? [2, 0] : 2 },
    fill: {
      type: hasIsolated ? ['gradient', 'solid'] : 'gradient',
      gradient: { opacityFrom: 0.5, opacityTo: 0.1 },
    },
    dataLabels: hasIsolated
      ? {
          // Label only the scatter overlay (series 1), formatted with the
          // metric's own unit-aware formatter ("1.3h", "11.1%", …).
          enabled: true,
          enabledOnSeries: [1],
          formatter: (val) => (typeof val === 'number' ? formatValue(val) : ''),
          offsetY: -8,
          background: { enabled: false },
          style: { colors: [primary], fontSize: '12px', fontWeight: 700 },
        }
      : { enabled: false },
    xaxis: {
      type: 'datetime',
      ...(xMax != null ? { max: xMax } : {}),
      labels: { datetimeUTC: false },
    },
    yaxis: { min: 0, labels: { formatter: formatTrendAxisValue } },
    markers: {
      // Dense series: size-4 dots on every point. Sparse: area keeps 4, the
      // scatter overlay renders prominent size-6 markers for the lone points.
      size: hasIsolated ? [4, 6] : 4,
      strokeWidth: 2,
    },
    ...(hasIsolated ? { grid: { padding: { right: 16 } } } : {}),
    tooltip: { x: { format: 'MMM dd, yyyy' } },
    legend: { show: false },
  };

  return { chartType, series, options };
}

function TrendChartCard({ title, subheader, trendSeries, formatValue }: TrendChartCardProps) {
  const theme = useTheme();
  const { chartType, series, options } = buildTrendChartConfig(
    title,
    trendSeries,
    formatValue,
    theme.palette.primary.main,
  );
  const chartOptions = useChart(options);

  return (
    <Card>
      <CardHeader title={title} subheader={subheader} />
      <Box sx={{ p: 3, pt: 0 }}>
        <Chart type={chartType} height={260} series={series} options={chartOptions} />
      </Box>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading Skeleton
// ---------------------------------------------------------------------------

function TrendChartSkeleton() {
  return (
    <Card>
      <Box sx={{ p: 3 }}>
        <Skeleton width="50%" height={24} />
        <Skeleton width="70%" height={16} sx={{ mt: 0.5 }} />
        <Skeleton variant="rectangular" height={260} sx={{ mt: 2, borderRadius: 1 }} />
      </Box>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

interface DoraTrendChartsProps {
  timeRange: DoraTimeRange;
  appId?: string | null;
}

export function DoraTrendCharts({ timeRange, appId }: DoraTrendChartsProps) {
  const { data, error, isLoading } = useDoraTrends(timeRange, appId);

  // Loading state
  if (isLoading) {
    return (
      <Grid container spacing={3}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Grid size={{ xs: 12, md: 6 }} key={i}>
            <TrendChartSkeleton />
          </Grid>
        ))}
      </Grid>
    );
  }

  // Error state
  if (error) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>Failed to load trend data.
              </Typography>
    );
  }

  // Empty state
  if (!data) {
    return null;
  }

  return (
    <Grid container spacing={3}>
      {DORA_METRIC_CONFIGS.map((config) => {
        const trendKey = TREND_KEYS[config.key];
        if (!trendKey) return null;

        const trendSeries = data.trends[trendKey];
        if (!trendSeries || trendSeries.series.length === 0) return null;

        return (
          <Grid size={{ xs: 12, md: 6 }} key={config.key}>
            <TrendChartCard
              title={config.title}
              subheader={config.description}
              trendSeries={trendSeries}
              formatValue={config.formatValue}
            />
          </Grid>
        );
      })}
    </Grid>
  );
}
