// @vitest-environment jsdom
/**
 * WidgetRenderer Score Component Tests
 *
 * Tests that WidgetRenderer correctly renders score components
 * for each score response type.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { useParams } from 'next/navigation';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { Widget, WidgetDataResponse } from '../../types';

// ---------------------------------------------------------------------------
// IntersectionObserver mock — immediately triggers as visible
// ---------------------------------------------------------------------------

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  disconnect() {}
  unobserve() {}
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  value: MockIntersectionObserver,
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRefresh = vi.fn();
const mockUseWidgetData = vi.fn();

vi.mock('../../hooks/use-widget-data', () => ({
  useWidgetData: (...args: any[]) => mockUseWidgetData(...args),
}));

vi.mock('../context', () => ({
  useDashboardContext: () => ({
    timeRange: '7d',
    appId: 'test-app-id',
  }),
}));

vi.mocked(useParams).mockReturnValue({ orgName: 'test-org' } as never);

// Header env switch is the canonical app-wide env scope —
// `inherit` widgets read it from EnvContext.
vi.mock('@/context/env-context', () => ({
  useEnvContext: () => ({
    selectedEnv: {
      name: 'dev',
      id: 'env-dev',
      isPinned: false,
      pinnedVersion: null,
      isDefault: true,
      isUnknown: false,
    },
  }),
}));

vi.mock('@mui/material/Popover', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ open, children }: any) =>
      open ? <div data-testid="mock-popover">{children}</div> : null,
  };
});

vi.mock('@/components/chart', () => ({
  __esModule: true,
  default: ({ type, series }: any) => (
    <div data-testid="mock-chart" data-type={type}>
      {series?.map((s: any) => s.name).join(', ')}
    </div>
  ),
  useChart: (opts: any) => opts,
}));

// Mock score analytics components
vi.mock('@/sections/score-analytics/score-summary-cards', () => ({
  ScoreSummaryCards: ({ aggregations }: any) => (
    <div data-testid="score-summary-cards">
      {aggregations?.map((a: any) => a.name).join(', ')}
    </div>
  ),
}));

vi.mock('@/sections/score-analytics/score-histogram', () => ({
  ScoreHistogram: ({ data, scoreName }: any) => (
    <div data-testid="score-histogram" data-score-name={scoreName}>
      {data?.name}
    </div>
  ),
}));

vi.mock('@/sections/score-analytics/score-trend-chart', () => ({
  ScoreTrendChart: ({ data, scoreName }: any) => (
    <div data-testid="score-trend-chart" data-score-name={scoreName}>
      {data?.name}
    </div>
  ),
}));

vi.mock('@/sections/score-analytics/score-comparison-view', () => ({
  ScoreComparisonView: ({ appId }: any) => (
    <div data-testid="score-comparison-view">{appId}</div>
  ),
}));

vi.mock('@/sections/score-analytics/score-scatter-chart', () => ({
  ScoreScatterChart: ({ data }: any) => (
    <div data-testid="score-scatter-chart">
      {data?.points?.length ?? 0} points
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { WidgetRenderer } from '../widget-renderer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const theme = createTheme();

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}

const baseWidget: Widget = {
  id: 'w-1',
  dashboardId: 'd-1',
  title: 'Test Widget',
  metric: 'score_summary',
  visualization: 'stat',
  filters: [],
  groupBy: null,
  timeGranularity: 'auto',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WidgetRenderer (score widgets)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render score summary inline when data type is scoreSummary', () => {
    const data: WidgetDataResponse = {
      type: 'scoreSummary',
      aggregations: [
        { name: 'accuracy', avgScore: 0.85, count: 100, minScore: 0.5, maxScore: 1.0 },
      ],
    };

    mockUseWidgetData.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByText('accuracy')).toBeInTheDocument();
  });

  it('renders a boolean score as a True rate % with a dataType chip and no Min/Max', () => {
    mockUseWidgetData.mockReturnValue({
      data: {
        type: 'scoreSummary',
        aggregations: [
          { name: 'passed', avgScore: 0.75, count: 100, minScore: 0, maxScore: 1, dataType: 'boolean' },
        ],
      } as WidgetDataResponse,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByText('True rate: 75.0%')).toBeInTheDocument();
    expect(screen.getByText('boolean')).toBeInTheDocument(); // dataType chip
    expect(screen.queryByText(/^Avg:/)).toBeNull();
    expect(screen.queryByText(/^Min:/)).toBeNull();
    expect(screen.queryByText(/^Max:/)).toBeNull();
  });

  it('renders a numeric score as an Avg with Min/Max and its dataType chip', () => {
    mockUseWidgetData.mockReturnValue({
      data: {
        type: 'scoreSummary',
        aggregations: [
          { name: 'rating', avgScore: 4.2, count: 50, minScore: 1, maxScore: 5, dataType: 'numeric' },
        ],
      } as WidgetDataResponse,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByText('Avg: 4.20')).toBeInTheDocument();
    expect(screen.getByText('numeric')).toBeInTheDocument();
    expect(screen.getByText('Min: 1')).toBeInTheDocument();
  });

  it('should render bar chart inline when data type is scoreHistogram', () => {
    const widget: Widget = {
      ...baseWidget,
      metric: 'score_histogram',
      visualization: 'bar',
      scoreName: 'accuracy',
    };

    const data: WidgetDataResponse = {
      type: 'scoreHistogram',
      data: {
        name: 'accuracy',
        type: 'numeric',
        buckets: [{ bucket: 0.5, count: 10 }],
        categories: [],
      },
    };

    mockUseWidgetData.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={widget} />);

    // Rendered inline as a Chart component (no nested ScoreHistogram card)
    expect(screen.getByTestId('mock-chart')).toBeInTheDocument();
  });

  it('should render line chart inline when data type is scoreTrend', () => {
    const widget: Widget = {
      ...baseWidget,
      metric: 'score_trend',
      visualization: 'line',
      scoreName: 'accuracy',
    };

    const data: WidgetDataResponse = {
      type: 'scoreTrend',
      data: {
        name: 'accuracy',
        interval: 'day',
        points: [{ timestamp: '2026-01-28', avgScore: 0.85, count: 20 }],
      },
    };

    mockUseWidgetData.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={widget} />);

    // Rendered inline as a Chart component (no nested ScoreTrendChart card)
    expect(screen.getByTestId('mock-chart')).toBeInTheDocument();
  });

  it('should render score comparison content when data type is scoreComparison with comparison data', () => {
    const widget: Widget = {
      ...baseWidget,
      metric: 'score_comparison',
      visualization: 'bar',
      scoreName: 'accuracy',
      scoreNameB: 'relevance',
    };

    const data: WidgetDataResponse = {
      type: 'scoreComparison',
      comparison: {
        nameA: 'accuracy',
        nameB: 'relevance',
        type: 'categorical',
        matrix: [{ labelA: 'pass', labelB: 'pass', count: 50 }],
        totalMatched: 80,
        totalA: 100,
        totalB: 90,
      },
    };

    mockUseWidgetData.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={widget} />);

    // Should render the heatmap chart for comparison data
    expect(screen.getByTestId('mock-chart')).toBeInTheDocument();
  });

  it('should render scatter chart inline when data type is scoreComparison with scatter data', () => {
    const widget: Widget = {
      ...baseWidget,
      metric: 'score_comparison',
      visualization: 'bar',
      scoreName: 'accuracy',
      scoreNameB: 'relevance',
    };

    const data: WidgetDataResponse = {
      type: 'scoreComparison',
      scatter: {
        nameA: 'accuracy',
        nameB: 'relevance',
        points: [{ scoreA: 0.8, scoreB: 0.7 }],
        totalMatched: 50,
        totalA: 100,
        totalB: 90,
      },
    };

    mockUseWidgetData.mockReturnValue({
      data,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={widget} />);

    // Rendered inline as a Chart component (no nested ScoreScatterChart card)
    expect(screen.getByTestId('mock-chart')).toBeInTheDocument();
  });

  it('should pass scoreName and scoreNameB in widget config to useWidgetData', () => {
    const widget: Widget = {
      ...baseWidget,
      metric: 'score_comparison',
      scoreName: 'accuracy',
      scoreNameB: 'relevance',
    };

    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={widget} />);

    expect(mockUseWidgetData).toHaveBeenCalledWith(
      'test-org',
      'test-app-id',
      expect.objectContaining({
        metric: 'score_comparison',
        scoreName: 'accuracy',
        scoreNameB: 'relevance',
      }),
      { preset: '7d' },
      { enabled: true }
    );
  });
});
