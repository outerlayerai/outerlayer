'use client';

/**
 * StatCard — the app's single-metric stat tile: mono uppercase label, mono
 * semibold figure, mono text delta. The figure and label wear ink — only the
 * delta wears a sentiment color (the darker step on paper, the lighter step
 * on dark surfaces — the `.main` steps are mark colors, not text colors), and
 * the delta is text (▲/▼/▪ glyphs), never an icon-arrow.
 *
 * Purely presentational: every caller formats its own value/delta text.
 * Metric-aware formatting and sentiment resolution live with the callers
 * (dashboards' WidgetStatCard; the context Overview's tiles).
 */

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useTheme, type Theme } from '@mui/material/styles';
import Iconify from '@/components/iconify';

type StatCardSentiment = 'good' | 'bad' | 'neutral';

interface StatCardChange {
  /** Text glyph: ▲ up, ▼ down, ▪ flat/neutral. */
  glyph: string;
  /** Signed delta text, e.g. "+4.1%" or "+6.0pp". */
  text: string;
  sentiment: StatCardSentiment;
  /** Names the comparison window, e.g. "vs prior 30 days". */
  periodLabel: string;
}

interface StatCardProps {
  label: string;
  /** The formatted headline figure. Ignored when `unavailableReason` is set. */
  value: string;
  /** Sample size / denominator the headline number can't carry itself. */
  caption?: ReactNode;
  /** Plain-language explanation behind the label's hover info icon. */
  infoText?: string;
  /**
   * Renders an em-dash + reason instead of the value — for a figure that
   * cannot be computed (e.g. a ratio with a zero denominator), where showing
   * a zero would misread as best-case.
   */
  unavailableReason?: string;
  change?: StatCardChange;
  /** Shown (muted, with a ▪ glyph) when there is no prior-period baseline —
   *  say so instead of fabricating a percent. */
  noPriorText?: string;
}

export function StatCard({
  label,
  value,
  caption,
  infoText,
  unavailableReason,
  change,
  noPriorText,
}: StatCardProps) {
  const theme = useTheme();
  const mono = theme.typography.fontFamilyMonospace;

  const changeColorSx =
    change?.sentiment === 'good'
      ? (t: Theme) => ({
          color: (t.vars ?? t).palette.success.dark,
          ...t.applyStyles('dark', { color: (t.vars ?? t).palette.success.light }),
        })
      : change?.sentiment === 'bad'
        ? (t: Theme) => ({
            color: (t.vars ?? t).palette.error.dark,
            ...t.applyStyles('dark', { color: (t.vars ?? t).palette.error.light }),
          })
        : { color: 'text.secondary' };

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
        // Content must never bleed past the card: captions vary in length and
        // callers size tiles freely, so the card clips.
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
        {label}
        {infoText && (
          // The explanation lives behind a hover icon so the tile body stays
          // label + figure + delta at every tile size.
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
      {unavailableReason !== undefined ? (
        <>
          <Typography sx={{ fontFamily: mono, fontSize: '1.6875rem', lineHeight: 1.2, color: 'text.disabled' }}>
            —
          </Typography>
          <Typography variant="body2" sx={{ mt: 0.5, color: 'text.secondary' }}>
            {unavailableReason}
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
          {value}
        </Typography>
      )}
      {unavailableReason === undefined && caption !== undefined && (
        <Typography variant="caption" sx={{ mt: 0.5, color: 'text.secondary', fontFamily: mono }}>
          {caption}
        </Typography>
      )}
      {unavailableReason === undefined && change && (
        <Box sx={deltaRowSx}>
          <Box component="span" sx={changeColorSx}>
            {change.glyph} {change.text}
          </Box>
          <Box component="span" sx={{ color: 'text.disabled' }}>
            {change.periodLabel}
          </Box>
        </Box>
      )}
      {!change && noPriorText !== undefined && (
        <Box sx={deltaRowSx}>
          <Box component="span" sx={{ color: 'text.disabled' }}>
            ▪ {noPriorText}
          </Box>
        </Box>
      )}
    </Card>
  );
}
