'use client';

// ---------------------------------------------------------------------------
// DoraMetricCard Component
//
// Renders a single DORA metric with formatted value, performance badge,
// trend indicator, and sample size context.
// ---------------------------------------------------------------------------

import { useState } from 'react';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

import Iconify from '@/components/iconify';

import type { DoraMetricValue, TrendDirection } from '@/lib/dora-metrics/types';

import { DoraPerformanceBadge } from './dora-performance-badge';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DoraMetricCardProps {
  title: string;
  metric: DoraMetricValue;
  formatValue: (value: number) => string;
  higherIsBetter: boolean;
  /** What the metric measures and why it matters (drives the info popover). */
  explanation?: string;
  /** Authoritative DORA source linked from the info popover. */
  sourceUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TREND_ICONS: Record<TrendDirection, string> = {
  up: 'eva:trending-up-fill',
  down: 'eva:trending-down-fill',
  stable: 'eva:minus-fill',
};

/**
 * Determine the semantic color for a trend indicator.
 *
 * - For "higher is better" metrics (e.g. deployment frequency):
 *   up = good (success), down = bad (error).
 * - For "lower is better" metrics (e.g. lead time, CFR, MTTR):
 *   up = bad (error), down = good (success).
 * - Stable is always neutral (text.secondary).
 */
function useTrendColor(direction: TrendDirection, higherIsBetter: boolean): string {
  const theme = useTheme();

  if (direction === 'stable') {
    return theme.palette.text.secondary;
  }

  const isPositiveTrend =
    (direction === 'up' && higherIsBetter) || (direction === 'down' && !higherIsBetter);

  return isPositiveTrend ? theme.palette.success.main : theme.palette.error.main;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DoraMetricCard({
  title,
  metric,
  formatValue,
  higherIsBetter,
  explanation,
  sourceUrl,
}: DoraMetricCardProps) {
  const { trend, performanceLevel, sampleSize, value } = metric;

  const trendColor = useTrendColor(trend.direction, higherIsBetter);
  const trendIcon = TREND_ICONS[trend.direction];

  const [infoAnchor, setInfoAnchor] = useState<HTMLElement | null>(null);

  return (
    <Card sx={{ p: 3, height: '100%' }}>
      <Stack spacing={1.5}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography variant="subtitle2" sx={{
            color: "text.secondary"
          }}>
            {title}
          </Typography>

          {explanation && (
            <>
              <IconButton
                size="small"
                aria-label={`About ${title}`}
                onClick={(event) => setInfoAnchor(event.currentTarget)}
              >
                <Iconify icon="eva:info-outline" width={16} />
              </IconButton>

              <Popover open={Boolean(infoAnchor)} anchorEl={infoAnchor} onClose={() => setInfoAnchor(null)}>
                <Stack spacing={1} sx={{ p: 2, maxWidth: 300 }}>
                  <Typography variant="body2">{explanation}</Typography>
                  {sourceUrl && (
                    <Link href={sourceUrl} target="_blank" rel="noopener noreferrer" variant="caption">
                      Learn more about DORA metrics →
                    </Link>
                  )}
                </Stack>
              </Popover>
            </>
          )}
        </Box>

        <Typography variant="h3">{formatValue(value)}</Typography>

        <DoraPerformanceBadge level={performanceLevel} />

        {/* Trend indicator */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Iconify icon={trendIcon} sx={{ color: trendColor, width: 20, height: 20 }} />
          <Typography variant="body2" sx={{ color: trendColor }}>
            {trend.changePercent > 0 ? '+' : ''}
            {trend.changePercent.toFixed(1)}%
          </Typography>
        </Box>

        {/* Sample size context */}
        <Typography variant="body2" sx={{
          color: "text.disabled"
        }}>
          Based on {sampleSize} deployment{sampleSize !== 1 ? 's' : ''}
        </Typography>
      </Stack>
    </Card>
  );
}
