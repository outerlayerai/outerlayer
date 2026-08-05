// @vitest-environment jsdom
/**
 * WidgetRankingList Component Tests
 *
 * Tests rendering of grouped/ranked data as horizontal progress bars.
 * Test names follow "should [outcome] when [condition]"
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { WidgetRankingList } from '../widget-ranking-list';
import type { WidgetRankingResponse } from '../../types';

const theme = createTheme();

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);
}

// ---------------------------------------------------------------------------

describe('WidgetRankingList', () => {
  it('should render "No data available" when items array is empty', () => {
    const data: WidgetRankingResponse = { type: 'ranking', items: [] };
    renderWithTheme(<WidgetRankingList data={data} />);

    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('should render the healthy-outcome copy for an empty anomaly ranking, not "No data available"', () => {
    const data: WidgetRankingResponse = { type: 'ranking', items: [] };
    renderWithTheme(
      <WidgetRankingList data={data} metric="agent_cost_anomalies_by_branch" />
    );

    expect(screen.getByText('No cost anomalies in this window')).toBeInTheDocument();
    expect(screen.queryByText('No data available')).not.toBeInTheDocument();
  });

  it('should render dollar values for cost rankings and percent for the error-rate ranking', () => {
    const cost: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'feat/x', value: 21.3 }],
    };
    const { unmount } = renderWithTheme(
      <WidgetRankingList data={cost} metric="agent_cost_by_branch" />
    );
    expect(screen.getByText('$21.30')).toBeInTheDocument();
    unmount();

    const rate: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'feat/x', value: 4.1 }],
    };
    renderWithTheme(
      <WidgetRankingList data={rate} metric="agent_tool_error_rate_by_branch" />
    );
    expect(screen.getByText('4.1%')).toBeInTheDocument();
  });

  it('should keep plain count formatting for count-valued rankings (top_models ranks by requests, never $)', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'claude-fable-5', value: 1200 }],
    };
    renderWithTheme(<WidgetRankingList data={data} metric="top_models" />);

    expect(screen.getByText('1.2K')).toBeInTheDocument();
  });

  it('should render all item names when data has multiple items', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [
        { name: 'gpt-4', value: 80 },
        { name: 'gpt-3.5-turbo', value: 120 },
        { name: 'claude-3', value: 45 },
      ],
    };
    renderWithTheme(<WidgetRankingList data={data} />);

    expect(screen.getByText('gpt-4')).toBeInTheDocument();
    expect(screen.getByText('gpt-3.5-turbo')).toBeInTheDocument();
    expect(screen.getByText('claude-3')).toBeInTheDocument();
  });

  it('should format large values with K suffix when value exceeds 1000', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'model-a', value: 2500 }],
    };
    renderWithTheme(<WidgetRankingList data={data} />);

    expect(screen.getByText('2.5K')).toBeInTheDocument();
  });

  it('should format very large values with M suffix when value exceeds 1000000', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'model-a', value: 3_200_000 }],
    };
    renderWithTheme(<WidgetRankingList data={data} />);

    expect(screen.getByText('3.2M')).toBeInTheDocument();
  });

  it('should format decimal values to two decimal places when value is not an integer', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'model-a', value: 12.456 }],
    };
    renderWithTheme(<WidgetRankingList data={data} />);

    expect(screen.getByText('12.46')).toBeInTheDocument();
  });

  it('should render integer values with locale formatting when value is a whole number', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'model-a', value: 500 }],
    };
    renderWithTheme(<WidgetRankingList data={data} />);

    expect(screen.getByText('500')).toBeInTheDocument();
  });

  it('should fill parent height by default instead of using a fixed pixel height', () => {
    const data: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'model-a', value: 100 }],
    };
    const { container } = renderWithTheme(<WidgetRankingList data={data} />);

    // The outermost Stack wrapper should use 100% height to fill the flex parent
    const listContainer = container.firstChild as HTMLElement;
    expect(listContainer.style.height).toBe('100%');
  });
});

describe('WidgetRankingList — Executive Overview rankings', () => {
  it('formats the agent-vs-human comparison in hours (switching to days past 48h) and rates in percent', () => {
    const cycle: WidgetRankingResponse = {
      type: 'ranking',
      items: [
        { name: 'Agent-shipped', value: 14.2 },
        { name: 'Human-only', value: 72 },
      ],
    };
    const { unmount } = renderWithTheme(<WidgetRankingList data={cycle} metric="agent_vs_human_cycle_time" />);
    expect(screen.getByText('14.2h')).toBeInTheDocument();
    expect(screen.getByText('3.0d')).toBeInTheDocument();
    unmount();

    const rate: WidgetRankingResponse = {
      type: 'ranking',
      items: [
        { name: 'Agent-shipped', value: 87 },
        { name: 'Human-only', value: 92 },
      ],
    };
    renderWithTheme(<WidgetRankingList data={rate} metric="agent_vs_human_merge_rate" />);
    expect(screen.getByText('87.0%')).toBeInTheDocument();
    expect(screen.getByText('92.0%')).toBeInTheDocument();
  });

  it('formats worker-kind cost rankings as dollars and shows the no-PRs empty copy for an empty comparison', () => {
    const cost: WidgetRankingResponse = {
      type: 'ranking',
      items: [{ name: 'cloud', value: 8.5 }],
    };
    const { unmount } = renderWithTheme(<WidgetRankingList data={cost} metric="agent_cost_by_worker_kind" />);
    expect(screen.getByText('$8.50')).toBeInTheDocument();
    unmount();

    renderWithTheme(
      <WidgetRankingList data={{ type: 'ranking', items: [] }} metric="agent_vs_human_cycle_time" />
    );
    // Not "No data available" — an empty window is a real, healthy outcome.
    expect(screen.getByText('No PRs merged in this window')).toBeInTheDocument();
  });
});
