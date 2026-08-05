// @vitest-environment jsdom
/**
 * WidgetRenderer Component Tests
 *
 * Tests that WidgetRenderer correctly routes data to the right
 * visualization component based on response type and widget config.
 * Test names follow "should [outcome] when [condition]"
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    // Immediately report as intersecting so widgets render their content
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

// Mock Popover to avoid @mui/utils resolution issue in jsdom
vi.mock('@mui/material/Popover', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ open, children }: any) =>
      open ? <div data-testid="mock-popover">{children}</div> : null,
  };
});

// Mock Chart to avoid ApexCharts in jsdom
vi.mock('@/components/chart', () => ({
  __esModule: true,
  default: ({ type, series }: any) => (
    <div data-testid="mock-chart" data-type={type}>
      {series?.map((s: any) => s.name).join(', ')}
    </div>
  ),
  useChart: (opts: any) => opts,
  useChartScheme: () => ({
    palette: { success: { main: '#2E7D32' }, error: { main: '#D32F2F' }, background: { paper: '#FFFFFF' } },
    viz: {
      categorical: ['#2065D1', '#008300', '#E87BA4', '#EDA100', '#1BAF7A', '#EB6834', '#4A3AA7', '#E34948'],
      ordinal: ['#6499E6', '#2065D1', '#143F86'],
      grid: '#F0F0ED',
      baseline: '#D5D5D0',
    },
    mode: 'light',
  }),
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
  metric: 'request_count',
  visualization: 'line',
  filters: [],
  groupBy: null,
  timeGranularity: 'auto',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WidgetRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading skeleton when data is loading', () => {
    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: mockRefresh,
    });

    const { container } = renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    // MUI Skeleton renders with specific classes
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('should render error message with retry button when fetch fails', () => {
    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: new Error('Network error'),
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByText('Failed to load widget data')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('should call refresh when retry button is clicked after error', async () => {
    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: new Error('Network error'),
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    await userEvent.click(screen.getByText('Retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('should keep rendering the last good data when a background refresh fails', () => {
    // A transient failure while polling (or on window refocus) sets `error`
    // while SWR still holds the previous data. The chart must survive — a
    // dashboard that blanks a rendered widget every time one poll hiccups
    // reads as broken.
    mockUseWidgetData.mockReturnValue({
      data: {
        type: 'timeSeries',
        series: [{ name: 'request_count', data: [{ x: '2026-01-01', y: 100 }] }],
      },
      error: new Error('transient 500'),
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByTestId('mock-chart')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load widget data')).not.toBeInTheDocument();
  });

  it('should render chart when data type is timeSeries', () => {
    const timeSeriesData: WidgetDataResponse = {
      type: 'timeSeries',
      series: [
        {
          name: 'request_count',
          data: [
            { x: '2026-01-01', y: 100 },
            { x: '2026-01-02', y: 150 },
          ],
        },
      ],
    };

    mockUseWidgetData.mockReturnValue({
      data: timeSeriesData,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByTestId('mock-chart')).toBeInTheDocument();
    expect(screen.getByText('Test Widget')).toBeInTheDocument();
  });

  it('should render stat card when visualization is stat and data type is stat', () => {
    const statData: WidgetDataResponse = {
      type: 'stat',
      value: 1234,
      label: 'Total Requests',
    };

    mockUseWidgetData.mockReturnValue({
      data: statData,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    const statWidget = { ...baseWidget, visualization: 'stat' as const };
    renderWithTheme(<WidgetRenderer widget={statWidget} />);

    // formatValue(1234) returns "1.2K" for values >= 1000
    expect(screen.getByText('1.2K')).toBeInTheDocument();
    expect(screen.getByText('Total Requests')).toBeInTheDocument();
  });

  it('should render ranking list when data type is ranking', () => {
    const rankingData: WidgetDataResponse = {
      type: 'ranking',
      items: [
        { name: 'gpt-4', value: 80 },
        { name: 'gpt-3.5', value: 120 },
      ],
    };

    mockUseWidgetData.mockReturnValue({
      data: rankingData,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByText('gpt-4')).toBeInTheDocument();
    expect(screen.getByText('gpt-3.5')).toBeInTheDocument();
    expect(screen.getByText('Test Widget')).toBeInTheDocument();
  });

  it('should render "No data available" when data is undefined after loading', () => {
    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    renderWithTheme(<WidgetRenderer widget={baseWidget} />);

    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('should pass widget config to useWidgetData when rendered', () => {
    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      refresh: mockRefresh,
    });

    const widget = {
      ...baseWidget,
      groupBy: 'model',
      timeGranularity: 'day' as const,
      filters: [{ field: 'model' as const, operator: 'equals', value: 'gpt-4' }],
    };

    renderWithTheme(<WidgetRenderer widget={widget} />);

    expect(mockUseWidgetData).toHaveBeenCalledWith(
      'test-org',
      'test-app-id',
      {
        metric: 'request_count',
        visualization: 'line',
        filters: [{ field: 'model', operator: 'equals', value: 'gpt-4' }],
        groupBy: 'model',
        timeGranularity: 'day',
        scoreName: undefined,
        scoreNameB: undefined,
        // Inherit widget resolves to the header env (dev) via EnvContext.
        environments: ['dev'],
        environmentIsDefault: true,
        scope: undefined,
      },
      { preset: '7d' },
      { enabled: true }
    );
  });

  it('should show delete button when onDelete is provided and data is loaded', () => {
    mockUseWidgetData.mockReturnValue({
      data: {
        type: 'timeSeries',
        series: [{ name: 'test', data: [{ x: '2026-01-01', y: 10 }] }],
      },
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    const onDelete = vi.fn();
    renderWithTheme(<WidgetRenderer widget={baseWidget} onDelete={onDelete} />);

    // Delete button is an IconButton rendered in CardHeader action
    const deleteButtons = screen.getAllByRole('button');
    expect(deleteButtons.length).toBeGreaterThan(0);
  });

  it('should require confirmation before calling onDelete', async () => {
    mockUseWidgetData.mockReturnValue({
      data: {
        type: 'timeSeries',
        series: [{ name: 'test', data: [{ x: '2026-01-01', y: 10 }] }],
      },
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    const onDelete = vi.fn();
    renderWithTheme(<WidgetRenderer widget={baseWidget} onDelete={onDelete} />);

    // Click trash icon — should open confirmation, not delete immediately
    const trashButton = screen.getAllByRole('button')[0]!;
    await userEvent.click(trashButton);
    expect(onDelete).not.toHaveBeenCalled();

    // Confirmation popover should appear
    expect(screen.getByText('Delete widget?')).toBeInTheDocument();

    // Click "Delete" to confirm
    await userEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith('w-1');
  });

  it('should not call onDelete when cancel is clicked in confirmation', async () => {
    mockUseWidgetData.mockReturnValue({
      data: {
        type: 'timeSeries',
        series: [{ name: 'test', data: [{ x: '2026-01-01', y: 10 }] }],
      },
      error: undefined,
      isLoading: false,
      refresh: mockRefresh,
    });

    const onDelete = vi.fn();
    renderWithTheme(<WidgetRenderer widget={baseWidget} onDelete={onDelete} />);

    // Click trash icon to open confirmation
    const trashButton = screen.getAllByRole('button')[0]!;
    await userEvent.click(trashButton);

    // Click Cancel
    await userEvent.click(screen.getByText('Cancel'));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('WidgetRenderer — section_header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the title as a heading band and never fetch data', () => {
    mockUseWidgetData.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true, // would show a skeleton for any data widget
      refresh: mockRefresh,
    });

    renderWithTheme(
      <WidgetRenderer
        widget={{ ...baseWidget, metric: 'section_header', visualization: 'stat', title: 'Are we shipping more efficiently?' }}
      />
    );

    // The heading renders immediately — no skeleton, no data dependency.
    expect(screen.getByRole('heading', { name: 'Are we shipping more efficiently?' })).toBeInTheDocument();
    // The data hook is called (hooks are unconditional) but DISABLED — the
    // enabled flag is the contract that no request fires for a header.
    expect(mockUseWidgetData).toHaveBeenCalledWith(
      'test-org',
      'test-app-id',
      expect.objectContaining({ metric: 'section_header' }),
      { preset: '7d' },
      { enabled: false }
    );
  });
});
