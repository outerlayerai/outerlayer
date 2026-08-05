'use client';

/**
 * WidgetRankingList Component
 *
 * Renders grouped/ranked data as horizontal progress bars.
 * Used when groupBy produces per-group totals (e.g. requests by model).
 */

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { fCurrency } from '@/utils/format-number';
import type { WidgetRankingResponse } from '../types';

interface WidgetRankingListProps {
  data: WidgetRankingResponse;
  metric?: string;
  height?: number | string;
}

/** Ranking metrics whose values are dollars — a bare "21.30" says nothing.
 * (`top_models` is deliberately absent: it ranks by request COUNT.) */
const COST_RANKING_METRICS = new Set([
  'agent_cost_by_branch',
  'agent_cost_by_agent_type',
  'agent_cost_by_worker_kind',
  'agent_cost_anomalies_by_branch',
]);

/** Ranking metrics whose values are 0..100 percentage points. */
const RATE_RANKING_METRICS = new Set([
  'agent_tool_error_rate_by_branch',
  'agent_vs_human_merge_rate',
  'agent_vs_human_revert_rate',
  'agent_vs_human_first_pass_ci',
]);

/** Ranking metrics whose values are durations in hours (per-phase medians / population p50s). */
const HOURS_RANKING_METRICS = new Set(['agent_pr_cycle_time_breakdown', 'agent_vs_human_cycle_time']);

/**
 * An empty result is not always "missing data" — for the anomaly detector
 * it's the healthy outcome, and "No data available" there reads as an
 * ingestion failure.
 */
const EMPTY_COPY: Record<string, string> = {
  agent_cost_anomalies_by_branch: 'No cost anomalies in this window',
  agent_pr_cycle_time_breakdown: 'No merged agent PRs in this window',
  agent_vs_human_cycle_time: 'No PRs merged in this window',
  agent_vs_human_merge_rate: 'No PRs decided in this window',
  agent_vs_human_revert_rate: 'No PRs decided in this window',
  // Size/CI data only exists on rows captured after their columns shipped —
  // "no measured PRs" is the honest empty state, not "no data available".
  agent_vs_human_pr_size: 'No merged PRs with size data in this window',
  agent_vs_human_first_pass_ci: 'No PRs with a CI verdict in this window',
};

function formatValue(value: number, metric?: string): string {
  if (metric && COST_RANKING_METRICS.has(metric)) {
    return fCurrency(value, 2);
  }
  if (metric && RATE_RANKING_METRICS.has(metric)) {
    return `${value.toFixed(1)}%`;
  }
  if (metric && HOURS_RANKING_METRICS.has(metric)) {
    // Hours below a day read fine; past that the raw hour count is hard to
    // parse (72h vs "3d"), so switch to days with one decimal.
    return value >= 48 ? `${(value / 24).toFixed(1)}d` : `${value.toFixed(1)}h`;
  }
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

export function WidgetRankingList({ data, metric, height = '100%' }: WidgetRankingListProps) {
  const theme = useTheme();

  if (!data.items || data.items.length === 0) {
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
          {(metric && EMPTY_COPY[metric]) ?? 'No data available'}
        </Typography>
      </Box>
    );
  }

  const maxValue = Math.max(...data.items.map((item) => item.value), 1);

  // Every row wears the accent: a meter's fill is one hue with its unfilled
  // track a lighter step of the same ramp. Rank is what the bar LENGTH shows —
  // coloring rows by position would spend the identity channel re-encoding it.
  return (
    <Stack spacing={1.5} sx={{ overflow: 'auto' }} style={{ height }}>
      {data.items.map((item) => (
        <Box key={item.name}>
          <Stack
            direction="row"
            sx={{
              justifyContent: "space-between",
              alignItems: "baseline",
              mb: 0.5
            }}>
            <Typography variant="body2" noWrap sx={{ maxWidth: '60%' }}>
              {item.name}
            </Typography>
            <Typography
              sx={{
                fontFamily: theme.typography.fontFamilyMonospace,
                fontSize: '0.78125rem',
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatValue(item.value, metric)}
            </Typography>
          </Stack>
          <Box
            sx={{
              height: 4,
              borderRadius: '2px',
              bgcolor: 'primary.lighter',
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                height: '100%',
                width: `${(item.value / maxValue) * 100}%`,
                borderRadius: '2px',
                bgcolor: 'primary.main',
                minWidth: 4,
              }}
            />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
