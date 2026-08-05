import { styled } from '@mui/material/styles';

import { bgBlur } from '@/theme';

import type { MenuPopoverArrowValue } from './types';

// ----------------------------------------------------------------------

// A small square, half-tucked under the paper edge and clipped to a triangle so
// it reads as a pointer back at the trigger. SIZE/INSET are our own values —
// SIZE ~1.5 grid units so the pointer reads without dominating; INSET clears the
// 10px paper corner radius. The per-edge rotation is geometry, not a style
// choice: it orients the bottom-left clip triangle outward from each edge.
const SIZE = 12;
const OFFSET = -(SIZE / 2);
const INSET = 18;

type ArrowSide = 'top' | 'bottom' | 'left' | 'right';

const ROTATION: Record<ArrowSide, string> = {
  top: 'rotate(135deg)',
  bottom: 'rotate(-45deg)',
  left: 'rotate(45deg)',
  right: 'rotate(-135deg)',
};

export const StyledArrow = styled('span')<{ arrow: MenuPopoverArrowValue }>(
  ({ theme, arrow }) => {
    const [side, align] = arrow.split('-') as [ArrowSide, string];

    const edge =
      side === 'top'
        ? { top: OFFSET }
        : side === 'bottom'
          ? { bottom: OFFSET }
          : side === 'left'
            ? { left: OFFSET }
            : { right: OFFSET };

    // Cross-axis placement along the edge from the second token.
    const centered =
      side === 'top' || side === 'bottom'
        ? { left: 0, right: 0, margin: 'auto' }
        : { top: 0, bottom: 0, margin: 'auto' };
    const placement =
      align === 'center'
        ? centered
        : align === 'left'
          ? { left: INSET }
          : align === 'right'
            ? { right: INSET }
            : align === 'top'
              ? { top: INSET }
              : { bottom: INSET };

    return {
      width: SIZE,
      height: SIZE,
      position: 'absolute' as const,
      borderBottomLeftRadius: SIZE / 4,
      clipPath: 'polygon(0% 0%, 100% 100%, 0% 100%)',
      border: `solid 1px ${(theme.vars ?? theme).palette.divider}`,
      transform: ROTATION[side],
      ...bgBlur({
        color: theme.palette.background.paper,
        colorChannel: theme.vars?.palette.background.paperChannel,
      }),
      ...edge,
      ...placement,
    };
  },
);
