import type { PopoverOrigin } from '@mui/material/Popover';

import type { MenuPopoverArrowValue } from './types';

// ----------------------------------------------------------------------

type ArrowSide = 'top' | 'bottom' | 'left' | 'right';

interface ArrowOrigins {
  anchorOrigin: PopoverOrigin;
  transformOrigin: PopoverOrigin;
}

/**
 * Map an arrow value to the Popover anchor/transform origins, derived
 * mechanically from the value's two tokens (no lookup table).
 *
 * The value names the paper edge the arrow sits on, pointing back at the anchor:
 *  - `top`    -> paper opens below the anchor (anchor `bottom` / transform `top`)
 *  - `bottom` -> paper opens above           (anchor `top` / transform `bottom`)
 *  - `left`   -> paper opens to the right     (anchor `right` / transform `left`)
 *  - `right`  -> paper opens to the left      (anchor `left` / transform `right`)
 * The second token is the cross-axis alignment shared by both origins.
 */
export function getArrowOrigins(arrow: MenuPopoverArrowValue): ArrowOrigins {
  const [side, align] = arrow.split('-') as [ArrowSide, string];

  if (side === 'top' || side === 'bottom') {
    const horizontal = align as PopoverOrigin['horizontal'];
    return side === 'top'
      ? {
          anchorOrigin: { vertical: 'bottom', horizontal },
          transformOrigin: { vertical: 'top', horizontal },
        }
      : {
          anchorOrigin: { vertical: 'top', horizontal },
          transformOrigin: { vertical: 'bottom', horizontal },
        };
  }

  const vertical = align as PopoverOrigin['vertical'];
  return side === 'left'
    ? {
        anchorOrigin: { vertical, horizontal: 'right' },
        transformOrigin: { vertical, horizontal: 'left' },
      }
    : {
        anchorOrigin: { vertical, horizontal: 'left' },
        transformOrigin: { vertical, horizontal: 'right' },
      };
}

/**
 * A small margin nudge on the paper so the edge-inset arrow lines up over the
 * trigger rather than the paper corner: the arrow sits inset from the corner, so
 * shifting the paper a fraction of a spacing unit toward the aligned side
 * recentres the pointer. Center-aligned arrows sit on the axis midpoint and need
 * no nudge. `0.75` spacing units (6px on the 8px grid) matches the arrow inset.
 */
export function getArrowPaperOffset(
  arrow: MenuPopoverArrowValue,
): { ml?: number; mt?: number } {
  const [side, align] = arrow.split('-') as [ArrowSide, string];
  if (align === 'center') return {};

  const NUDGE = 0.75;
  const value = align === 'left' || align === 'top' ? -NUDGE : NUDGE;
  return side === 'top' || side === 'bottom' ? { ml: value } : { mt: value };
}
