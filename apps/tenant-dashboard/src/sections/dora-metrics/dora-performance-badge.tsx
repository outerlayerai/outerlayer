'use client';

import Chip from '@mui/material/Chip';
import { alpha } from '@mui/material/styles';

import type { PerformanceLevel } from '@/lib/dora-metrics/types';
import { PERFORMANCE_LEVEL_COLORS, PERFORMANCE_LEVEL_LABELS } from '@/lib/dora-metrics/thresholds';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DoraPerformanceBadgeProps {
  level: PerformanceLevel;
  size?: 'small' | 'medium';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DoraPerformanceBadge({ level, size = 'small' }: DoraPerformanceBadgeProps) {
  const color = PERFORMANCE_LEVEL_COLORS[level];

  return (
    <Chip
      label={PERFORMANCE_LEVEL_LABELS[level]}
      size={size}
      sx={{
        backgroundColor: alpha(color, 0.15),
        color,
        fontWeight: 600,
      }}
    />
  );
}
