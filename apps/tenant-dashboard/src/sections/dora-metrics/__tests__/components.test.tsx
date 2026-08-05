// @vitest-environment jsdom
/**
 * DORA Metrics UI Component Tests
 *
 * Behavior-focused tests for the six DORA section components.
 * Test names follow "should [outcome] when [condition]"
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before component imports
// ---------------------------------------------------------------------------

vi.mock('server-only', () => ({}));

vi.mock('@/components/chart', () => ({
  __esModule: true,
  default: ({ series, type }: any) => (
    <div data-testid="chart" data-charttype={type}>
      {JSON.stringify(series)}
    </div>
  ),
  useChart: () => ({}),
}));

vi.mock('@/hooks/dora-metrics/use-dora-rankings');
vi.mock('@/hooks/dora-metrics/use-dora-trends');
vi.mock('@/hooks/dora-metrics/use-dora-metrics');
vi.mock('@/hooks/dora-metrics/use-dora-apps');

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { useDoraRankings } from '@/hooks/dora-metrics/use-dora-rankings';
import { useDoraTrends } from '@/hooks/dora-metrics/use-dora-trends';
import { useDoraMetrics } from '@/hooks/dora-metrics/use-dora-metrics';
import { useDoraApps } from '@/hooks/dora-metrics/use-dora-apps';
import { PERFORMANCE_LEVEL_LABELS } from '@/lib/dora-metrics/thresholds';
import type { DoraMetricValue } from '@/lib/dora-metrics/types';

import { DoraEmptyState } from '../dora-empty-state';
import { DoraPerformanceBadge } from '../dora-performance-badge';
import { DoraMetricCard } from '../dora-metric-card';
import { DoraAppRankings } from '../dora-app-rankings';
import {
  DoraTrendCharts,
  formatTrendAxisValue,
  isolatedTrendPoints,
  buildTrendChartConfig,
} from '../dora-trend-charts';
import { DoraMetricsView } from '../dora-metrics-view';

// ---------------------------------------------------------------------------
// Theme wrapper
// ---------------------------------------------------------------------------

const theme = createTheme();

function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const baseMetric: DoraMetricValue = {
  value: 2.5,
  unit: 'deploys/day',
  performanceLevel: 'high',
  trend: { direction: 'up', changePercent: 12.3 },
  sampleSize: 47,
};

// ---------------------------------------------------------------------------
// DoraEmptyState
// ---------------------------------------------------------------------------

describe('DoraEmptyState', () => {
  it('should render "No Data Yet" heading when no data is available', () => {
    wrap(<DoraEmptyState />);

    expect(screen.getByText('No Data Yet')).toBeInTheDocument();
  });

  it('should render descriptive text about automatic collection', () => {
    wrap(<DoraEmptyState />);

    expect(
      screen.getByText(/Deployments are recorded by CI as they happen/)
    ).toBeInTheDocument();
  });

  it('should show checking spinner when isPolling is true', () => {
    wrap(<DoraEmptyState isPolling />);

    expect(screen.getByText('Checking for data...')).toBeInTheDocument();
  });

  it('should not show checking spinner by default', () => {
    wrap(<DoraEmptyState />);

    expect(screen.queryByText('Checking for data...')).not.toBeInTheDocument();
  });

  it('should show "Load Historical Data" button when onLoadHistorical is provided', () => {
    wrap(<DoraEmptyState onLoadHistorical={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Load Historical Data/ })).toBeInTheDocument();
  });

  it('should not show the button when onLoadHistorical is not provided', () => {
    wrap(<DoraEmptyState />);

    expect(screen.queryByRole('button', { name: /Load Historical Data/ })).not.toBeInTheDocument();
  });

  it('should show "Loading..." and disable button when loadHistoricalStatus is loading', () => {
    wrap(<DoraEmptyState onLoadHistorical={vi.fn()} loadHistoricalStatus="loading" />);

    const button = screen.getByRole('button', { name: /Loading/ });
    expect(button).toBeDisabled();
  });

  it('should hide the button and show success message when loadHistoricalStatus is done', () => {
    wrap(<DoraEmptyState onLoadHistorical={vi.fn()} loadHistoricalStatus="done" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/Historical data loaded/)).toBeInTheDocument();
  });

  it('should show error message when loadHistoricalStatus is error', () => {
    wrap(<DoraEmptyState onLoadHistorical={vi.fn()} loadHistoricalStatus="error" />);

    expect(screen.getByText(/Backfill failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load Historical Data/ })).toBeInTheDocument();
  });

  it('should call onLoadHistorical when button is clicked', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onLoadHistorical = vi.fn();

    wrap(<DoraEmptyState onLoadHistorical={onLoadHistorical} />);

    await user.click(screen.getByRole('button', { name: /Load Historical Data/ }));

    expect(onLoadHistorical).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DoraPerformanceBadge
// ---------------------------------------------------------------------------

describe('DoraPerformanceBadge', () => {
  it('should render the correct label for elite level', () => {
    wrap(<DoraPerformanceBadge level="elite" />);

    expect(screen.getByText(PERFORMANCE_LEVEL_LABELS.elite)).toBeInTheDocument();
  });

  it('should render the correct label for high level', () => {
    wrap(<DoraPerformanceBadge level="high" />);

    expect(screen.getByText(PERFORMANCE_LEVEL_LABELS.high)).toBeInTheDocument();
  });

  it('should render the correct label for medium level', () => {
    wrap(<DoraPerformanceBadge level="medium" />);

    expect(screen.getByText(PERFORMANCE_LEVEL_LABELS.medium)).toBeInTheDocument();
  });

  it('should render the correct label for low level', () => {
    wrap(<DoraPerformanceBadge level="low" />);

    expect(screen.getByText(PERFORMANCE_LEVEL_LABELS.low)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// DoraMetricCard
// ---------------------------------------------------------------------------

describe('DoraMetricCard', () => {
  const formatValue = (v: number) => `${v.toFixed(1)}/day`;

  it('should render the title prop', () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
      />
    );

    expect(screen.getByText('Deployment Frequency')).toBeInTheDocument();
  });

  it('should render the formatted value by calling formatValue with metric.value', () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
      />
    );

    expect(screen.getByText(formatValue(baseMetric.value))).toBeInTheDocument();
  });

  it('should render a performance badge for the metric level', () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
      />
    );

    expect(screen.getByText(PERFORMANCE_LEVEL_LABELS[baseMetric.performanceLevel])).toBeInTheDocument();
  });

  it('should render the change percent with a plus sign when trend is positive', () => {
    const metric: DoraMetricValue = { ...baseMetric, trend: { direction: 'up', changePercent: 15.0 } };

    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={metric}
        formatValue={formatValue}
        higherIsBetter
      />
    );

    expect(screen.getByText('+15.0%')).toBeInTheDocument();
  });

  it('should NOT prefix a plus sign when the trend is negative', () => {
    const metric: DoraMetricValue = { ...baseMetric, trend: { direction: 'down', changePercent: -8.5 } };

    wrap(
      <DoraMetricCard title="X" metric={metric} formatValue={formatValue} higherIsBetter={false} />
    );

    expect(screen.getByText('-8.5%')).toBeInTheDocument();
    // A '+' here would mean the sign condition was inverted.
    expect(screen.queryByText('+-8.5%')).not.toBeInTheDocument();
  });

  it('should NOT prefix a plus sign when the trend is exactly zero', () => {
    const metric: DoraMetricValue = { ...baseMetric, trend: { direction: 'stable', changePercent: 0 } };

    wrap(
      <DoraMetricCard title="X" metric={metric} formatValue={formatValue} higherIsBetter />
    );

    // `> 0` (not `>= 0`): zero is not "positive", so no leading '+'.
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.queryByText('+0.0%')).not.toBeInTheDocument();
  });

  it('should not render an info affordance when no explanation is given', () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
      />
    );

    expect(screen.queryByLabelText('About Deployment Frequency')).toBeNull();
  });

  it('should reveal the explanation and a source link when the info button is clicked', () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
        explanation="How often you successfully ship code to production."
        sourceUrl="https://dora.dev/guides/dora-metrics-four-keys/"
      />
    );

    // Popover content is not mounted until the info button is clicked.
    expect(
      screen.queryByText('How often you successfully ship code to production.')
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('About Deployment Frequency'));

    expect(
      screen.getByText('How often you successfully ship code to production.')
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Learn more about DORA metrics/ });
    expect(link).toHaveAttribute('href', 'https://dora.dev/guides/dora-metrics-four-keys/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should render the explanation but no link when sourceUrl is omitted', () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
        explanation="How often you successfully ship code to production."
      />
    );

    fireEvent.click(screen.getByLabelText('About Deployment Frequency'));

    expect(
      screen.getByText('How often you successfully ship code to production.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Learn more about DORA metrics/ })).toBeNull();
  });

  it('should close the info popover when the user presses Escape', async () => {
    wrap(
      <DoraMetricCard
        title="Deployment Frequency"
        metric={baseMetric}
        formatValue={formatValue}
        higherIsBetter
        explanation="How often you successfully ship code to production."
        sourceUrl="https://dora.dev/guides/dora-metrics-four-keys/"
      />
    );

    fireEvent.click(screen.getByLabelText('About Deployment Frequency'));
    const body = screen.getByText('How often you successfully ship code to production.');
    expect(body).toBeInTheDocument();

    // onClose must wire Escape back to closing the popover; a no-op handler
    // would leave the content mounted.
    fireEvent.keyDown(body, { key: 'Escape' });

    await waitFor(() =>
      expect(
        screen.queryByText('How often you successfully ship code to production.')
      ).not.toBeInTheDocument()
    );
  });
});

// ---------------------------------------------------------------------------
// DoraAppRankings
// ---------------------------------------------------------------------------

const mockUseDoraRankings = useDoraRankings as ReturnType<typeof vi.fn>;

describe('DoraAppRankings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show skeleton cards when isLoading is true', () => {
    mockUseDoraRankings.mockReturnValue({ data: undefined, isLoading: true, error: undefined });

    const { container } = wrap(<DoraAppRankings timeRange="30d" />);

    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('should show error message when error is set', () => {
    mockUseDoraRankings.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Failed to fetch rankings'),
    });

    wrap(<DoraAppRankings timeRange="30d" />);

    expect(screen.getByText('Failed to fetch rankings')).toBeInTheDocument();
  });

  it('should return null when data has empty rankings array', () => {
    mockUseDoraRankings.mockReturnValue({
      data: { rankings: [], period: { start: '', end: '' } },
      isLoading: false,
      error: undefined,
    });

    const { container } = wrap(<DoraAppRankings timeRange="30d" />);

    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DoraTrendCharts
// ---------------------------------------------------------------------------

describe('formatTrendAxisValue', () => {
  it('rounds raw float trend values to <=2 decimals for axis ticks', () => {
    // The exact prod MTTR value that rendered as "1.5000000000000000"-style ticks.
    expect(formatTrendAxisValue(1.2983552777777778)).toBe('1.3');
    expect(formatTrendAxisValue(7.6923076923076925)).toBe('7.69');
  });

  it('keeps clean values clean and drops trailing-zero float noise', () => {
    expect(formatTrendAxisValue(0)).toBe('0');
    expect(formatTrendAxisValue(0.4)).toBe('0.4');
    expect(formatTrendAxisValue(2)).toBe('2');
  });

  it('renders nothing for non-finite values (null/NaN buckets)', () => {
    expect(formatTrendAxisValue(NaN)).toBe('');
    expect(formatTrendAxisValue(Infinity)).toBe('');
    expect(formatTrendAxisValue(null as unknown as number)).toBe('');
  });
});

describe('isolatedTrendPoints', () => {
  it('returns the lone non-null point surrounded by nulls (the single-MTTR-incident case)', () => {
    // The exact prod shape that rendered a blank chart: one incident, nulls otherwise.
    const series = [
      { x: '2026-06-06', y: null },
      { x: '2026-06-07', y: null },
      { x: '2026-06-08', y: 1.3 },
      { x: '2026-06-09', y: null },
    ];

    expect(isolatedTrendPoints(series)).toEqual([{ x: '2026-06-08', y: 1.3 }]);
  });

  it('returns nothing for a dense series — every point has a non-null neighbour', () => {
    const dense = [
      { x: 'a', y: 1 },
      { x: 'b', y: 2 },
      { x: 'c', y: 3 },
    ];

    expect(isolatedTrendPoints(dense)).toEqual([]);
  });

  it('treats a boundary point as isolated only when its single neighbour is null', () => {
    // First point isolated (next is null); not isolated when next is non-null.
    expect(isolatedTrendPoints([{ x: 'a', y: 5 }, { x: 'b', y: null }])).toEqual([
      { x: 'a', y: 5 },
    ]);
    expect(isolatedTrendPoints([{ x: 'a', y: 5 }, { x: 'b', y: 6 }])).toEqual([]);
    // Last point isolated when its only neighbour is null.
    expect(isolatedTrendPoints([{ x: 'a', y: null }, { x: 'b', y: 7 }])).toEqual([
      { x: 'b', y: 7 },
    ]);
  });

  it('flags only the gap-separated point, not points inside a contiguous run', () => {
    const series = [
      { x: 'a', y: 1 },
      { x: 'b', y: 2 }, // contiguous run → not isolated
      { x: 'c', y: null },
      { x: 'd', y: 9 }, // isolated
      { x: 'e', y: null },
      { x: 'f', y: 4 },
      { x: 'g', y: 5 }, // contiguous run → not isolated
    ];

    expect(isolatedTrendPoints(series)).toEqual([{ x: 'd', y: 9 }]);
  });

  it('returns nothing when there are no non-null points', () => {
    expect(isolatedTrendPoints([{ x: 'a', y: null }, { x: 'b', y: null }])).toEqual([]);
  });
});

const mockUseDoraTrends = useDoraTrends as ReturnType<typeof vi.fn>;

describe('DoraTrendCharts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show skeleton cards when isLoading is true', () => {
    mockUseDoraTrends.mockReturnValue({ data: undefined, isLoading: true, error: undefined });

    const { container } = wrap(<DoraTrendCharts timeRange="30d" />);

    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('should show error text when error is set', () => {
    mockUseDoraTrends.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network failure'),
    });

    wrap(<DoraTrendCharts timeRange="30d" />);

    expect(screen.getByText('Failed to load trend data.')).toBeInTheDocument();
  });

  it('should return null when data is null', () => {
    mockUseDoraTrends.mockReturnValue({ data: null, isLoading: false, error: undefined });

    const { container } = wrap(<DoraTrendCharts timeRange="30d" />);

    expect(container.firstChild).toBeNull();
  });

  it('overlays isolated points as a labelled scatter series; leaves dense charts single-area', () => {
    // A sparse metric (MTTR with a single non-null point surrounded by nulls)
    // must get a SECOND, scatter-type series carrying just that point — that's
    // what renders the otherwise-invisible lone marker. A dense metric (every
    // bucket non-null) must stay a single area series, untouched.
    const dense = {
      series: [
        { x: '2026-01-01', y: 1 },
        { x: '2026-01-02', y: 2 },
        { x: '2026-01-03', y: 3 },
      ],
      granularity: 'day' as const,
    };
    const sparse = {
      series: [
        { x: '2026-01-01', y: null },
        { x: '2026-01-02', y: null },
        { x: '2026-01-03', y: 1.3 },
      ],
      granularity: 'day' as const,
    };
    mockUseDoraTrends.mockReturnValue({
      data: {
        trends: {
          deploymentFrequency: dense,
          leadTime: dense,
          changeFailureRate: dense,
          mttr: sparse,
        },
        period: { start: '', end: '' },
        granularity: 'day',
      },
      isLoading: false,
      error: undefined,
    });

    const { container } = wrap(<DoraTrendCharts timeRange="30d" />);
    const charts = container.querySelectorAll('[data-testid="chart"]');
    // Card order follows DORA_METRIC_CONFIGS: DF, lead time, CFR, MTTR.
    expect(charts).toHaveLength(4);

    // Dense (Deployment Frequency): single area series, no scatter overlay.
    const df = JSON.parse(charts[0]!.textContent!);
    expect(df).toHaveLength(1);
    expect(df[0].type).toBe('area');
    expect(charts[0]!.getAttribute('data-charttype')).toBe('area');

    // Sparse (MTTR): area + scatter overlay holding exactly the isolated point.
    const mttr = JSON.parse(charts[3]!.textContent!);
    expect(mttr).toHaveLength(2);
    expect(mttr[0].type).toBe('area');
    expect(mttr[1].type).toBe('scatter');
    expect(mttr[1].data).toEqual([{ x: '2026-01-03', y: 1.3 }]);
    expect(charts[3]!.getAttribute('data-charttype')).toBe('line');
  });
});

// ---------------------------------------------------------------------------
// DoraMetricsView
// ---------------------------------------------------------------------------

const mockUseDoraMetrics = useDoraMetrics as ReturnType<typeof vi.fn>;
const mockUseDoraApps = useDoraApps as ReturnType<typeof vi.fn>;

const populatedMetrics = {
  data: {
    environment: 'production',
    metrics: {
      deploymentFrequency: baseMetric,
      leadTime: baseMetric,
      changeFailureRate: baseMetric,
      mttr: baseMetric,
    },
    period: { start: '', end: '' },
    comparisonPeriod: { start: '', end: '' },
  },
  error: undefined,
  isLoading: false,
  isEmpty: false,
  refresh: vi.fn(),
};

interface MetricsState {
  data?: unknown;
  error?: Error;
  isLoading?: boolean;
  isEmpty?: boolean;
  refresh?: () => void;
}

/** Sets the useDoraMetrics mock to a single state and returns its refresh spy. */
function seedMetrics(state: MetricsState) {
  const refresh = vi.fn();
  mockUseDoraMetrics.mockReturnValue({ ...populatedMetrics, refresh, ...state });
  return refresh;
}

// Trend/ranking data that makes DoraTrendCharts and DoraAppRankings render
// observable content — required so flipping the view's section-render
// conditions actually changes the DOM (otherwise those branches are untestable
// because the children render null on empty input).
const trendSeries = { series: [{ x: '2026-01-01', y: 1.2 }], granularity: 'day' as const };
const trendsRendering = {
  data: {
    trends: {
      deploymentFrequency: trendSeries,
      leadTime: trendSeries,
      changeFailureRate: trendSeries,
      mttr: trendSeries,
    },
    period: { start: '', end: '' },
    granularity: 'day',
  },
  isLoading: false,
  error: undefined,
};

const rankingMetric = { value: 2.5, performanceLevel: 'high' as const };
const rankingsRendering = {
  data: {
    rankings: [
      {
        serviceId: 'gateway',
        serviceName: 'Gateway',
        metrics: {
          deploymentFrequency: rankingMetric,
          leadTime: rankingMetric,
          changeFailureRate: rankingMetric,
          mttr: rankingMetric,
        },
        totalDeployments: 12,
      },
    ],
    period: { start: '', end: '' },
  },
  isLoading: false,
  error: undefined,
};

/** Make both trend + ranking sections render visible content. */
function seedSections() {
  mockUseDoraTrends.mockReturnValue(trendsRendering);
  mockUseDoraRankings.mockReturnValue(rankingsRendering);
}

describe('DoraMetricsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockUseDoraApps.mockReturnValue({ apps: [] });
    seedMetrics({});
    mockUseDoraTrends.mockReturnValue({ data: null, isLoading: false, error: undefined });
    mockUseDoraRankings.mockReturnValue({
      data: { rankings: [], period: { start: '', end: '' } },
      isLoading: false,
      error: undefined,
    });
  });

  // -- Render states ---------------------------------------------------------

  it('should render the four metric cards when data is present', () => {
    wrap(<DoraMetricsView />);

    expect(screen.getByText('Deployment Frequency')).toBeInTheDocument();
    expect(screen.getByText('Lead Time for Changes')).toBeInTheDocument();
    expect(screen.getByText('Change Failure Rate')).toBeInTheDocument();
    expect(screen.getByText('Mean Time to Restore')).toBeInTheDocument();
    // Empty state must NOT be shown in the data state.
    expect(screen.queryByText('No Data Yet')).not.toBeInTheDocument();
  });

  it('should show skeleton cards and no metrics while loading', () => {
    seedMetrics({ data: undefined, isLoading: true });

    const { container } = wrap(<DoraMetricsView />);

    expect(container.querySelectorAll('.MuiSkeleton-root').length).toBeGreaterThan(0);
    expect(screen.queryByText('Deployment Frequency')).not.toBeInTheDocument();
    expect(screen.queryByText('No Data Yet')).not.toBeInTheDocument();
  });

  it('should show the error message and no metric cards on error', () => {
    seedMetrics({ data: undefined, error: new Error('boom'), isLoading: false });

    wrap(<DoraMetricsView />);

    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.queryByText('Deployment Frequency')).not.toBeInTheDocument();
  });

  it('should show only the empty state when isEmpty is true, even with data loaded', () => {
    // Realistic SWR shape: data is present but every sample size is 0, so the
    // hook reports isEmpty. The cards / trends / rankings sections must all stay
    // hidden and only the empty state renders — this pins every section's
    // render condition (a mutation that flips one would surface hidden content).
    seedMetrics({ isEmpty: true });
    seedSections();

    wrap(<DoraMetricsView />);

    expect(screen.getByText('No Data Yet')).toBeInTheDocument();
    expect(screen.queryByText('Deployment Frequency')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.queryByText('Service Rankings')).not.toBeInTheDocument();
  });

  it('should render the trend charts and service rankings in the data state', () => {
    seedSections();

    wrap(<DoraMetricsView />);

    expect(screen.getAllByTestId('chart').length).toBeGreaterThan(0);
    expect(screen.getByText('Service Rankings')).toBeInTheDocument();
    expect(screen.getByText('Gateway')).toBeInTheDocument();
  });

  // -- Environment pinning -----------------------------------------------------
  //
  // The environment is a property of the deployment (DORA_ENVIRONMENT,
  // resolved server-side); the client sends no environment at all and only
  // renders what the response says it was computed for.

  it('should never send an environment from the client — the server pins it', () => {
    wrap(<DoraMetricsView />);

    expect(mockUseDoraMetrics).toHaveBeenCalledWith('30d', null);
    expect(screen.queryByRole('button', { name: 'Staging' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Production' })).toBeNull();
  });

  it("should render a chip naming the response's environment", () => {
    seedMetrics({});

    wrap(<DoraMetricsView />);

    // populatedMetrics carries environment: 'production' from the server
    expect(screen.getByLabelText('Deployment environment')).toHaveTextContent('Production');
  });

  // -- Time range selector ---------------------------------------------------

  it('should re-query with the selected time range', () => {
    wrap(<DoraMetricsView />);

    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
    expect(mockUseDoraMetrics).toHaveBeenLastCalledWith('7d', null);

    fireEvent.click(screen.getByRole('button', { name: '90 Days' }));
    expect(mockUseDoraMetrics).toHaveBeenLastCalledWith('90d', null);
  });

  it('should keep the current time range when the active range is re-clicked', () => {
    wrap(<DoraMetricsView />);

    fireEvent.click(screen.getByRole('button', { name: '30 Days' }));

    expect(mockUseDoraMetrics).toHaveBeenLastCalledWith('30d', null);
  });

  // -- Service filter --------------------------------------------------------

  it('should re-query with the selected app id from the service filter', () => {
    mockUseDoraApps.mockReturnValue({
      apps: [
        { id: 'app-1', name: 'Gateway' },
        { id: 'app-2', name: 'Dashboard' },
      ],
    });

    wrap(<DoraMetricsView />);

    const filter = screen.getByPlaceholderText('All Services');
    fireEvent.mouseDown(filter);
    fireEvent.change(filter, { target: { value: 'Gateway' } });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'Enter' });

    expect(mockUseDoraMetrics).toHaveBeenLastCalledWith('30d', 'app-1');
  });

  it('should filter to a service when its rankings row is clicked', () => {
    seedSections();

    wrap(<DoraMetricsView />);

    // Clicking a rankings row calls onAppSelect(serviceId) → setAppId, which
    // re-queries the metrics for that service.
    fireEvent.click(screen.getByText('Gateway'));

    expect(mockUseDoraMetrics).toHaveBeenLastCalledWith('30d', 'gateway');
  });

  // -- Load historical (backfill) --------------------------------------------

  it('should POST to the backfill endpoint and refresh on success', async () => {
    const refresh = seedMetrics({ data: undefined, isEmpty: true });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    wrap(<DoraMetricsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Historical Data' }));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/platform-admin/dora-metrics/backfill',
      { method: 'POST' },
    );
    expect(await screen.findByText('Historical data loaded. Waiting for metrics to populate...'))
      .toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('should treat a 409 (backfill already ran) as success', async () => {
    const refresh = seedMetrics({ data: undefined, isEmpty: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));

    wrap(<DoraMetricsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Historical Data' }));

    expect(await screen.findByText('Historical data loaded. Waiting for metrics to populate...'))
      .toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('should surface a backfill error and not refresh on a non-ok, non-409 response', async () => {
    const refresh = seedMetrics({ data: undefined, isEmpty: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    wrap(<DoraMetricsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Historical Data' }));

    expect(await screen.findByText('Backfill failed. Please try again.')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildTrendChartConfig — pure sparse-vs-dense option building
// ---------------------------------------------------------------------------

describe('buildTrendChartConfig', () => {
  const PRIMARY = '#7635DC';
  const fmt = (v: number) => `${v}h`;
  const day = (ys: (number | null)[]) => ({
    series: ys.map((y, i) => ({ x: `2026-06-${String(i + 1).padStart(2, '0')}`, y })),
    granularity: 'day' as const,
  });

  it('dense series → single area, no overlay/labels/inset', () => {
    const cfg = buildTrendChartConfig('DF', day([1, 2, 3]), fmt, PRIMARY);
    const o = cfg.options as any;

    expect(cfg.chartType).toBe('area');
    expect(cfg.series).toHaveLength(1);
    expect(cfg.series[0]!.type).toBe('area');
    expect(o.colors).toBeUndefined();
    expect(o.stroke.width).toBe(2);
    expect(o.fill.type).toBe('gradient');
    expect(o.dataLabels).toEqual({ enabled: false });
    expect(o.markers.size).toBe(4);
    expect(o.xaxis.max).toBeUndefined();
    expect(o.grid).toBeUndefined();
  });

  it('sparse with isolated LAST point → scatter overlay, labels, and ¾-bucket inset', () => {
    const cfg = buildTrendChartConfig('MTTR', day([null, null, 1.3]), fmt, PRIMARY);
    const o = cfg.options as any;

    expect(cfg.chartType).toBe('line');
    expect(cfg.series).toHaveLength(2);
    expect(cfg.series[1]).toEqual({
      name: 'MTTR (points)',
      type: 'scatter',
      data: [{ x: '2026-06-03', y: 1.3 }],
    });
    expect(o.colors).toEqual([PRIMARY, PRIMARY]);
    expect(o.stroke.width).toEqual([2, 0]);
    expect(o.fill.type).toEqual(['gradient', 'solid']);
    expect(o.dataLabels.enabled).toBe(true);
    expect(o.dataLabels.enabledOnSeries).toEqual([1]);
    expect(o.markers.size).toEqual([4, 6]);
    expect(o.grid.padding.right).toBe(16);
    // Inset = last bucket timestamp + ¾ day.
    expect(o.xaxis.max).toBe(new Date('2026-06-03').getTime() + 86_400_000 * 0.75);
  });

  it('isolated point that is NOT last → overlay but NO inset (xaxis.max undefined)', () => {
    // First point isolated, last bucket is null → lastIsolated is false.
    const cfg = buildTrendChartConfig('MTTR', day([5, null, null]), fmt, PRIMARY);
    const o = cfg.options as any;

    expect(cfg.chartType).toBe('line');
    expect(cfg.series[1]!.data).toEqual([{ x: '2026-06-01', y: 5 }]);
    expect(o.xaxis.max).toBeUndefined();
  });

  it('week granularity insets by ¾ of a WEEK, not a day', () => {
    const cfg = buildTrendChartConfig(
      'MTTR',
      { series: [{ x: '2026-05-01', y: null }, { x: '2026-06-03', y: 2 }], granularity: 'week' },
      fmt,
      PRIMARY,
    );
    const o = cfg.options as any;
    expect(o.xaxis.max).toBe(new Date('2026-06-03').getTime() + 7 * 86_400_000 * 0.75);
  });

  it('data label formatter uses the metric formatter for numbers, blank otherwise', () => {
    const cfg = buildTrendChartConfig('MTTR', day([null, 1.3]), fmt, PRIMARY);
    const formatter = (cfg.options as any).dataLabels.formatter;
    expect(formatter(2.5)).toBe('2.5h');
    expect(formatter(null)).toBe('');
    expect(formatter('x')).toBe('');
  });
});
