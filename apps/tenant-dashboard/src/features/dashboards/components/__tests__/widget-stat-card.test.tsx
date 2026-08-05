// @vitest-environment jsdom
/**
 * WidgetStatCard — change-sentiment inversion tests.
 *
 * tool_error_rate (and error_rate) are the first metrics to populate
 * `change` where an "up" trend is BAD, not good, so the stat card needs
 * metric-aware inversion (a bare `direction: 'up'` must not always render
 * green). `resolveChangeSentiment` is the pulled-out logic; tested directly
 * rather than via rendered CSS, which is unreliable to assert on in jsdom.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { resolveChangeSentiment, WidgetStatCard } from '../widget-stat-card';
import { betterDirectionFor, getMetricDescription } from '../../types';

describe('resolveChangeSentiment', () => {
  it('returns "neutral" when there is no direction (no change data)', () => {
    expect(resolveChangeSentiment(undefined, 'session_count')).toBe('neutral');
  });

  it('returns "neutral" for a flat direction regardless of metric', () => {
    expect(resolveChangeSentiment('flat', 'tool_error_rate')).toBe('neutral');
    expect(resolveChangeSentiment('flat', 'session_count')).toBe('neutral');
  });

  it('treats "up" as good for a non-inverted metric (sessions growing)', () => {
    expect(resolveChangeSentiment('up', 'session_count')).toBe('good');
    expect(resolveChangeSentiment('down', 'session_count')).toBe('bad');
  });

  it('treats "up" as BAD for tool_error_rate — the metric-aware inversion', () => {
    expect(resolveChangeSentiment('up', 'tool_error_rate')).toBe('bad');
    expect(resolveChangeSentiment('down', 'tool_error_rate')).toBe('good');
  });

  it('treats "up" as BAD for error_rate too (pre-existing inverted metric)', () => {
    expect(resolveChangeSentiment('up', 'error_rate')).toBe('bad');
    expect(resolveChangeSentiment('down', 'error_rate')).toBe('good');
  });

  it('treats "up" as BAD for agent_pr_unreviewed_merge_rate — more unreviewed merges is worse', () => {
    expect(resolveChangeSentiment('up', 'agent_pr_unreviewed_merge_rate')).toBe('bad');
    expect(resolveChangeSentiment('down', 'agent_pr_unreviewed_merge_rate')).toBe('good');
  });

  it('treats "up" as BAD for agent_pr_reopen_rate — more reopened PRs is more churn', () => {
    expect(resolveChangeSentiment('up', 'agent_pr_reopen_rate')).toBe('bad');
    expect(resolveChangeSentiment('down', 'agent_pr_reopen_rate')).toBe('good');
  });

  it('defaults to non-inverted behavior when metric is undefined', () => {
    expect(resolveChangeSentiment('up', undefined)).toBe('good');
  });

  // Regression: these cost/rate metrics fell through to the "up = good"
  // default, so a FALLING cost-per-PR rendered red (alarm) and a RISING
  // revert rate rendered green. betterDirection = 'down' fixes both.
  it('treats a FALLING cost per merged PR as GOOD (was backwards)', () => {
    expect(resolveChangeSentiment('down', 'agent_cost_per_merged_pr')).toBe('good');
    expect(resolveChangeSentiment('up', 'agent_cost_per_merged_pr')).toBe('bad');
  });

  it('treats a FALLING attributed cost per merged PR as GOOD', () => {
    expect(resolveChangeSentiment('down', 'agent_direct_cost_per_merged_pr')).toBe('good');
    expect(resolveChangeSentiment('up', 'agent_direct_cost_per_merged_pr')).toBe('bad');
  });

  it('treats a RISING revert rate as BAD (was silently green)', () => {
    expect(resolveChangeSentiment('up', 'agent_pr_revert_rate')).toBe('bad');
    expect(resolveChangeSentiment('down', 'agent_pr_revert_rate')).toBe('good');
  });

  it('treats Total Spend as NEUTRAL in both directions — a rise can be more usage, not waste', () => {
    expect(resolveChangeSentiment('up', 'total_agent_cost')).toBe('neutral');
    expect(resolveChangeSentiment('down', 'total_agent_cost')).toBe('neutral');
  });

  it('returns "neutral" for a flat direction on any metric', () => {
    expect(resolveChangeSentiment('flat', 'agent_cost_per_merged_pr')).toBe('neutral');
  });
});

describe('betterDirectionFor', () => {
  it('is "down" (lower is better) for cost-per-merged-PR and its attributed variant', () => {
    expect(betterDirectionFor('agent_cost_per_merged_pr')).toBe('down');
    expect(betterDirectionFor('agent_direct_cost_per_merged_pr')).toBe('down');
  });

  it('is "down" for revert rate, so a rise reads as bad', () => {
    expect(betterDirectionFor('agent_pr_revert_rate')).toBe('down');
  });

  it('is "up" (higher is better) for merge rate and error-free sessions', () => {
    expect(betterDirectionFor('agent_pr_merge_rate')).toBe('up');
    expect(betterDirectionFor('clean_session_rate')).toBe('up');
  });

  it('is "neutral" for raw spend — a rise can be more usage, not waste', () => {
    expect(betterDirectionFor('total_agent_cost')).toBe('neutral');
  });

  it('falls back to "up" for an unmapped or missing metric', () => {
    expect(betterDirectionFor('some_unmapped_metric')).toBe('up');
    expect(betterDirectionFor(undefined)).toBe('up');
  });
});

describe('getMetricDescription', () => {
  it('returns the exact description for a known metric', () => {
    expect(getMetricDescription('total_agent_cost')).toBe(
      'Total agent-session cost for the selected period.',
    );
  });

  it('spells out lower-is-better in the cost-per-merged-PR description', () => {
    expect(getMetricDescription('agent_cost_per_merged_pr')).toContain('Lower is better');
  });

  it('names the interactive-session population in every behavior-rate description', () => {
    // These three rates exclude headless agent and worker runs (populations
    // that structurally can't prompt); the tooltip must say so, or the
    // number is unexplainable next to an all-origins sessions list.
    expect(getMetricDescription('agent_hands_on_rate')).toContain('interactive sessions');
    expect(getMetricDescription('agent_auto_approved_rate')).toContain('interactive sessions');
    expect(getMetricDescription('agent_tool_denial_rate')).toContain('interactive sessions');
  });

  it('returns undefined for an unmapped or missing metric', () => {
    expect(getMetricDescription('nope_not_a_metric')).toBeUndefined();
    expect(getMetricDescription(undefined)).toBeUndefined();
  });
});

describe('WidgetStatCard — empty prior window', () => {
  const theme = createTheme();
  const renderWithTheme = (ui: React.ReactElement) =>
    render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

  it('renders "no prior data" instead of a percentage when priorEmpty is set', () => {
    renderWithTheme(
      <WidgetStatCard
        data={{ type: 'stat', value: 5, label: 'Sessions', priorEmpty: true }}
        metric="session_count"
      />
    );

    expect(screen.getByText('▪ no prior data')).toBeInTheDocument();
    // No fabricated percentage anywhere on the card.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders the real percentage when change exists, and no "no prior data" caption', () => {
    renderWithTheme(
      <WidgetStatCard
        data={{
          type: 'stat',
          value: 20,
          label: 'Sessions',
          change: { value: 100, direction: 'up' },
        }}
        metric="session_count"
      />
    );

    expect(screen.getByText('▲ +100.0%')).toBeInTheDocument();
    expect(screen.queryByText(/no prior data/)).not.toBeInTheDocument();
  });

  it('formats total_agent_cost (the Total Spend tile) as currency, not a bare count', () => {
    // Regression guard: total_agent_cost must be in COST_METRICS so the Total
    // Spend tile renders "$1,234" not "1.2K" — same treatment as total_cost.
    renderWithTheme(
      <WidgetStatCard data={{ type: 'stat', value: 1234, label: 'Total Spend' }} metric="total_agent_cost" />
    );
    expect(screen.getByText(/\$/)).toBeInTheDocument();
  });

  it('renders a cost tile with exactly 2 decimals — no raw-float tail', () => {
    // Headline dollars render at 2 decimals; fCurrency's extended precision
    // (fractionDigits:6) would render a sub-cent tail like "$10,425.660000".
    renderWithTheme(
      <WidgetStatCard data={{ type: 'stat', value: 10425.66, label: 'Total Spend' }} metric="total_agent_cost" />
    );
    expect(screen.getByText('$10,425.66')).toBeInTheDocument();
    expect(screen.queryByText(/\.\d{3,}/)).not.toBeInTheDocument();
  });

  it('currency-formats Direct Cost per Merged PR', () => {
    // agent_direct_cost_per_merged_pr must be in COST_METRICS; the generic
    // branch renders it as "128.07" with no $ prefix.
    renderWithTheme(
      <WidgetStatCard data={{ type: 'stat', value: 128.07, label: 'Direct Cost per Merged PR' }} metric="agent_direct_cost_per_merged_pr" />
    );
    expect(screen.getByText('$128.07')).toBeInTheDocument();
  });

  it('does NOT currency-format a non-cost metric with the same value (proves formatting is metric-driven)', () => {
    renderWithTheme(
      <WidgetStatCard data={{ type: 'stat', value: 1234, label: 'Sessions' }} metric="session_count" />
    );
    // A bare count renders shortened ("1.2K"), never with a currency symbol.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  // The unit is "pp", not "%": the value is a difference between two rates, and
  // a "%" suffix reads as if pass and fail should sum to 100.
  it('signs a positive score-outcome merge-rate lift with a leading "+" and "pp" (not "%")', () => {
    renderWithTheme(
      <WidgetStatCard
        data={{ type: 'stat', value: 50, label: 'worker.ci_green: Merge-Rate Lift, Pass − Fail' }}
        metric="agent_pr_outcome_by_score_merge_rate"
      />
    );
    expect(screen.getByText('+50.0pp')).toBeInTheDocument();
  });

  it('renders the caption (cohort sample size) under the value — so a "+50pp" lift off 3 PRs is not read as authoritatively as one off 300', () => {
    renderWithTheme(
      <WidgetStatCard
        data={{
          type: 'stat',
          value: 50,
          label: 'worker.ci_green: Merge-Rate Lift (Pass − Fail)',
          caption: '1 passing vs 2 failing PRs',
        }}
        metric="agent_pr_outcome_by_score_merge_rate"
      />
    );
    expect(screen.getByText('+50.0pp')).toBeInTheDocument();
    expect(screen.getByText('1 passing vs 2 failing PRs')).toBeInTheDocument();
  });

  it('does NOT render the caption line when a stat carries no caption (the common case) — no empty element', () => {
    renderWithTheme(
      <WidgetStatCard data={{ type: 'stat', value: 1234, label: 'Sessions' }} metric="session_count" />
    );
    expect(screen.queryByText(/passing vs/)).not.toBeInTheDocument();
  });

  it('signs a negative score-outcome merge-rate lift with a leading "-" and "pp"', () => {
    renderWithTheme(
      <WidgetStatCard
        data={{ type: 'stat', value: -12.5, label: 'worker.ci_green: Merge-Rate Lift, Pass − Fail' }}
        metric="agent_pr_outcome_by_score_merge_rate"
      />
    );
    expect(screen.getByText('-12.5pp')).toBeInTheDocument();
  });

  it('formats the score-outcome cycle-time lift in signed hours, not pp', () => {
    renderWithTheme(
      <WidgetStatCard
        data={{ type: 'stat', value: -3.5, label: 'worker.ci_green: Cycle-Time Lift, Pass − Fail' }}
        metric="agent_pr_outcome_by_score_cycle_time"
      />
    );
    expect(screen.getByText('-3.5h')).toBeInTheDocument();
  });

  it('renders an em-dash + reason (never the value) when unavailable is set', () => {
    // cost-per-merged-PR with spend but nothing merged: value 0 must NOT show
    // as "$0" (reads as best-case); the card shows "—" + the reason instead.
    renderWithTheme(
      <WidgetStatCard
        data={{ type: 'stat', value: 0, label: 'Cost per Merged PR', unavailable: { reason: 'agent spend, no PRs merged yet' } }}
        metric="agent_cost_per_merged_pr"
      />
    );

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('agent spend, no PRs merged yet')).toBeInTheDocument();
    // The misleading "$0" must be nowhere on the card.
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
  });
});
