'use client';

/**
 * WidgetStatCard Component
 *
 * Single-metric stat tile in the instrument register: mono uppercase label,
 * mono semibold figure, mono text delta against a named prior period. The
 * figure and label wear ink — only the delta wears a sentiment color, and it
 * is text (the darker step, AA on paper), never an icon-arrow.
 */

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme, type Theme } from '@mui/material/styles';
import Iconify from '@/components/iconify';
import { fCurrency, fShortenNumber } from '@/utils/format-number';
import { betterDirectionFor, getMetricDescription, getMetricEvidenceLine } from '../types';
import type { WidgetStatResponse } from '../types';

interface WidgetStatCardProps {
  data: WidgetStatResponse;
  metric?: string;
  /** Names the comparison window in the delta row, e.g. "vs prior 30d". */
  periodLabel?: string;
}

// cost_per_session_p50/p95 and agent_session_duration_p50/p95/p99 moved off
// the stat card entirely — they're now AGENT_FLEET_TREND_METRICS, rendered
// as multi-series line charts by widget-chart.tsx (see METRIC_CHART_TYPE /
// getTooltipFormatter there), never a single blended stat.
const COST_METRICS = new Set(['total_cost', 'total_agent_cost', 'avg_cost', 'cost_per_request', 'cost_per_token', 'cost_per_error', 'cost_per_user', 'agent_cost_per_merged_pr', 'agent_direct_cost_per_merged_pr', 'agent_spend_per_active_dev', 'total_cost_of_ai']);
const TOKEN_METRICS = new Set(['total_tokens', 'avg_tokens', 'tokens_per_request', 'tokens_per_user']);
const LATENCY_METRICS = new Set(['avg_latency', 'p50_latency', 'p95_latency', 'p99_latency', 'latency_cost_ratio']);
const RATE_METRICS = new Set(['error_rate', 'success_rate', 'tool_error_rate', 'clean_session_rate', 'agent_hands_on_rate', 'agent_clean_job_rate', 'agent_pr_merge_rate', 'agent_pr_unreviewed_merge_rate', 'agent_pr_reopen_rate', 'agent_pr_revert_rate', 'agent_share_of_merged_prs', 'agent_unshipped_spend_share', 'agent_tool_denial_rate', 'agent_auto_approved_rate']);

/**
 * A DIFFERENCE of two rates (pass cohort minus fail cohort), not a rate
 * itself — "pp" (percentage points), not "%", is the correct unit (a jump
 * from 10% to 60% is "+50pp", not "+50%", which would misread as relative
 * growth). Always signed: 0 is meaningful here (no predictive difference),
 * so a bare "50.0pp" without a leading "+"/"-" would be as ambiguous as the
 * two-bar chart this replaced.
 */
const SIGNED_RATE_DIFF_METRICS = new Set([
  'agent_pr_outcome_by_score_merge_rate',
  'agent_pr_outcome_by_score_revert_rate',
]);
/** Same signed-difference reasoning, in hours (pass cohort minus fail cohort). */
const SIGNED_HOUR_DIFF_METRICS = new Set(['agent_pr_outcome_by_score_cycle_time']);

/**
 * Agent cost tiles whose dollar figures derive from TOKEN USAGE priced at
 * public API rates. For teams on subscription tools (Claude Max, Copilot
 * seats) that is API-EQUIVALENT VALUE, not cash billed — an honesty
 * disclosure the tile must carry wherever the number appears (info icon
 * beside the label). `total_cost` (the per-request LLM metric) bills the
 * same way, but only the agent-program tiles feed budget conversations.
 */
const TOKEN_COST_DISCLOSURE_METRICS = new Set([
  'total_agent_cost',
  'agent_cost_per_merged_pr',
  'agent_direct_cost_per_merged_pr',
  'agent_spend_per_active_dev',
  'agent_unshipped_spend_share',
  'total_cost_of_ai',
]);

const TOKEN_COST_DISCLOSURE =
  'Token spend is computed from usage at public API prices — API-equivalent value. For subscription tools (e.g. Claude Max), it measures value consumed, not cash billed.';

function formatMetricValue(value: number, metric?: string): string {
  if (metric) {
    if (COST_METRICS.has(metric)) {
      // 2 decimals for the headline dollar amount. fCurrency auto-extends
      // precision for sub-cent values (e.g. per-token cost) so those stay
      // visible — passing 6 here just gave every total a "$10,425.660000" tail.
      return fCurrency(value, 2);
    }
    if (TOKEN_METRICS.has(metric)) {
      return `${fShortenNumber(value)} tokens`;
    }
    if (LATENCY_METRICS.has(metric)) {
      return `${fShortenNumber(value / 1000)}s`;
    }
    if (RATE_METRICS.has(metric)) {
      return `${value.toFixed(1)}%`;
    }
    if (SIGNED_RATE_DIFF_METRICS.has(metric)) {
      return `${value > 0 ? '+' : ''}${value.toFixed(1)}pp`;
    }
    if (SIGNED_HOUR_DIFF_METRICS.has(metric)) {
      return `${value > 0 ? '+' : ''}${value.toFixed(1)}h`;
    }
  }

  // Fallback: generic formatting
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  return value.toFixed(2);
}

/**
 * Whether a period-over-period `direction` reads as good/bad/neutral for
 * this metric. Delegates the "which way is good" decision to the single
 * source of truth, `betterDirectionFor` (types.ts) — so a metric can't
 * silently default to "up = green" the way falling cost / rising revert
 * rate once did. Pulled out of the component so this (the part most likely
 * to regress) is unit-testable without a DOM/CSS round-trip.
 *
 *   betterDirection 'up'      → up = good,  down = bad
 *   betterDirection 'down'    → down = good, up = bad
 *   betterDirection 'neutral' → neither; grey, no verdict (e.g. Total Spend)
 */
export function resolveChangeSentiment(
  direction: NonNullable<WidgetStatResponse['change']>['direction'] | undefined,
  metric: string | undefined,
): 'good' | 'bad' | 'neutral' {
  if (!direction || direction === 'flat') return 'neutral';
  const better = betterDirectionFor(metric);
  if (better === 'neutral') return 'neutral';
  return direction === better ? 'good' : 'bad';
}

/** Delta glyphs are text, not icons — ▲ up, ▼ down, ▪ flat/neutral. */
const DIRECTION_GLYPH: Record<string, string> = { up: '▲', down: '▼', flat: '▪' };

export function WidgetStatCard({ data, metric, periodLabel = 'vs prior period' }: WidgetStatCardProps) {
  const theme = useTheme();
  const mono = theme.typography.fontFamilyMonospace;

  const sentiment = resolveChangeSentiment(data.change?.direction, metric);
  // One info affordance per tile: the plain-language explanation, the
  // metric's evidence tier, and — for token-derived cost tiles — the
  // API-equivalent-value disclosure.
  const description = getMetricDescription(metric);
  const evidence = getMetricEvidenceLine(metric);
  const disclosure =
    metric && TOKEN_COST_DISCLOSURE_METRICS.has(metric) ? TOKEN_COST_DISCLOSURE : undefined;
  const infoText = [description, evidence, disclosure].filter(Boolean).join(' ');

  // Sentiment wears the darker text step on paper (AA as text) and the
  // lighter step on dark surfaces — the `.main` steps are mark colors, not
  // text colors.
  const changeColorSx =
    sentiment === 'good'
      ? (t: Theme) => ({
          color: (t.vars ?? t).palette.success.dark,
          ...t.applyStyles('dark', { color: (t.vars ?? t).palette.success.light }),
        })
      : sentiment === 'bad'
        ? (t: Theme) => ({
            color: (t.vars ?? t).palette.error.dark,
            ...t.applyStyles('dark', { color: (t.vars ?? t).palette.error.light }),
          })
        : { color: 'text.secondary' };

  const glyph = DIRECTION_GLYPH[data.change?.direction ?? 'flat'] ?? '▪';

  const deltaRowSx = {
    fontFamily: mono,
    fontSize: '0.71875rem',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'baseline',
    gap: 0.75,
    mt: 0.5,
  };

  return (
    <Card
      sx={{
        px: 2.5,
        py: 2,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        // Content must never bleed past the card: descriptions vary in
        // length and users size tiles freely, so the card clips…
        overflow: 'hidden',
      }}
    >
      <Typography
        component="div"
        gutterBottom
        sx={{
          fontFamily: mono,
          fontSize: '0.6875rem',
          fontWeight: 600,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'text.secondary',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
        }}
      >
        {data.label}
        {infoText && (
          // The metric explanation (and, for token-derived cost tiles, the
          // API-equivalent-value disclosure) lives behind a hover icon so the
          // tile body stays label + figure + delta at every tile size.
          <Tooltip title={infoText}>
            <Iconify
              icon="eva:info-outline"
              width={13}
              sx={{ color: 'text.disabled', flexShrink: 0 }}
              aria-label="What this measures"
            />
          </Tooltip>
        )}
      </Typography>
      {data.unavailable ? (
        // Ratio with a zero denominator (e.g. cost-per-merged-PR, nothing
        // merged). Render an em-dash + reason, NEVER data.value — a "$0" here
        // reads as best-case when it's worst-case (spend, no outcome).
        <>
          <Typography sx={{ fontFamily: mono, fontSize: '1.6875rem', lineHeight: 1.2, color: 'text.disabled' }}>
            —
          </Typography>
          <Typography variant="body2" sx={{ mt: 0.5, color: 'text.secondary' }}>
            {data.unavailable.reason}
          </Typography>
        </>
      ) : (
        <Typography
          sx={{
            fontFamily: mono,
            fontSize: '1.6875rem',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: 1.2,
          }}
        >
          {formatMetricValue(data.value, metric)}
        </Typography>
      )}
      {!data.unavailable && data.caption && (
        // Sample size / denominator the headline number can't carry itself —
        // a lift of "+50pp" means something very different at n=4 vs n=400.
        <Typography variant="caption" sx={{ mt: 0.5, color: 'text.secondary', fontFamily: mono }}>
          {data.caption}
        </Typography>
      )}
      {!data.unavailable && data.change && (
        <Box sx={deltaRowSx}>
          <Box component="span" sx={changeColorSx}>
            {glyph} {data.change.value > 0 ? '+' : ''}
            {data.change.value.toFixed(1)}%
          </Box>
          <Box component="span" sx={{ color: 'text.disabled' }}>
            {periodLabel}
          </Box>
        </Box>
      )}
      {!data.change && data.priorEmpty && (
        // No prior-period baseline — say so instead of fabricating a percent
        // (a fabricated "+100.0%" on every tile of a fresh install reads as broken).
        <Box sx={deltaRowSx}>
          <Box component="span" sx={{ color: 'text.disabled' }}>
            ▪ no prior data
          </Box>
        </Box>
      )}
    </Card>
  );
}
