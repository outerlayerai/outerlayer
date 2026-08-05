import type { Theme } from '@mui/material/styles';

import type { NavItemCounterVariant } from './types';

// ----------------------------------------------------------------------
// Pure style helpers for the nav-section family. Kept in a `.ts` file (inside
// the Stryker patch-mutation net; `.tsx` is excluded) and consumed by
// `styled()`/`sx` callbacks. Every colour is read through the mandatory
// `(theme.vars ?? theme)` guard: under a bare `createTheme()` — which consumer
// and family unit tests use — `theme.vars` is null and bare `theme.vars.*`
// access crashes. No `theme.palette.mode` branches anywhere; the B1 dark scheme
// works by token substitution.

type StyleObject = Record<string, unknown>;

function palette(theme: Theme) {
  return (theme.vars ?? theme).palette;
}

// Vertical item container. Depth ≥ 2 sub-items are
// shorter and gain one 32px indent step per level past the top.
export function getNavItemStyles(
  theme: Theme,
  { depth = 1 }: { depth?: number } = {},
): StyleObject {
  const p = palette(theme);

  const base: StyleObject = {
    position: 'relative',
    height: depth >= 2 ? 32 : 36,
    borderRadius: 6,
    // Asymmetric: paddingLeft is 8 (not 10) so the 24px icon slot's CENTRE lands
    // 32px from the rail edge (margin 12 + padding 8 + 24/2) — the same x as the
    // mini tile's icon centre, anchoring the column across modes. See the anchor
    // invariant pin in nav-styles.test.ts.
    padding: theme.spacing(0, 1.25, 0, 1),
    margin: theme.spacing(0, 1.5, 0.25),
    color: p.text.secondary,
    '&:hover': {
      backgroundColor: p.action.hover,
      color: p.text.primary,
    },
  };

  if (depth >= 2) {
    base.paddingLeft = theme.spacing(1.25 + 4 * (depth - 1));
  }

  return base;
}

// Active state. Depth 1: ink-on-neutral chip + a single 2px brand accent bar —
// deliberately not an alpha-blue pill. Depth ≥ 2: dot + label weight only, no
// neutral fill and no accent bar.
export function getNavItemActiveStyles(
  theme: Theme,
  { depth = 1 }: { depth?: number } = {},
): StyleObject {
  const p = palette(theme);
  const label = {
    '& .nav-label': { fontWeight: theme.typography.fontWeightSemiBold },
  };

  if (depth >= 2) {
    return {
      color: p.text.primary,
      ...label,
    };
  }

  return {
    backgroundColor: p.background.neutral,
    color: p.text.primary,
    ...label,
    '&::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      width: 2,
      height: 16,
      borderRadius: 1,
      backgroundColor: p.primary.main,
    },
  };
}

// Section subheader: overline typography comes from the
// Typography variant; this carries layout + the one-step hover colour.
export function getNavSubheaderStyles(theme: Theme): StyleObject {
  const p = palette(theme);
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    color: p.text.disabled,
    paddingLeft: theme.spacing(2.75),
    paddingRight: theme.spacing(2.75),
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(1),
    '&:hover': { color: p.text.secondary },
  };
}

// Counter/badge chip (the `info` slot, e.g. QueuePendingBadge). Neutral by
// default; the attention variant is the soft warning tint.
export function getNavCounterStyles(
  theme: Theme,
  variant: NavItemCounterVariant = 'neutral',
): StyleObject {
  const p = palette(theme);
  const tone =
    variant === 'attention'
      ? { backgroundColor: p.warning.lighter, color: p.warning.darker }
      : { backgroundColor: p.background.neutral, color: p.text.secondary };

  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 18,
    borderRadius: 4,
    paddingLeft: theme.spacing(0.75),
    paddingRight: theme.spacing(0.75),
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1,
    ...tone,
  };
}

// Mini item tile: a 40×40 centred
// square. Active state reuses `getNavItemActiveStyles` (the accent bar + neutral
// fill); the `.nav-label` rule there is inert in mini (no label element).
// MuiListItemButton ships default gutter padding (8px 16px) and the clean-room
// theme has no override, so the fixed 40px tile must zero it or the centred slot
// is crushed to the 8px content box.
export function getMiniItemStyles(theme: Theme): StyleObject {
  const p = palette(theme);
  return {
    position: 'relative',
    width: 40,
    height: 40,
    minWidth: 40,
    padding: 0,
    borderRadius: 6,
    marginLeft: 'auto',
    marginRight: 'auto',
    marginBottom: theme.spacing(0.5),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: p.text.secondary,
    '&:hover': {
      backgroundColor: p.action.hover,
      color: p.text.primary,
    },
  };
}

// Icon slot — ONE 24px square for BOTH modes. Iconify glyphs carry viewBox
// padding, so a 20px slot reads visually as ~16px; 24 (0.6 of the
// 40px mini tile) holds the optical weight
// and, crucially, matches the mini slot so the icon column is a single width
// across collapse/expand. `getMiniIconSlotStyles` is the alias the mini item
// imports; the vertical item adds its own `mr` to the label on top of the
// shared square. No theme tokens here, so no palette guard is needed.
function getIconSlotStyles(): StyleObject {
  return {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

export function getMiniIconSlotStyles(): StyleObject {
  return getIconSlotStyles();
}

export function getNavIconSlotStyles(): StyleObject {
  return getIconSlotStyles();
}

// Mini dot badge (decision D2). The dot only paints when the `info` slot
// actually rendered something (`:has(*)`) — keying it off `info != null` would
// paint a permanent false dot on "Review queues", which returns null at zero.
// The slot's own output is hidden; the numeric count lives in the tooltip (D4).
export function getMiniDotStyles(theme: Theme): StyleObject {
  const p = palette(theme);
  return {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: p.primary.main,
    display: 'none',
    '&:has(*)': { display: 'block' },
    '& > *': { display: 'none' },
  };
}

// Sub-item dot in place of the icon: static colour change, no scale transform.
export function getSubItemDotStyles(
  theme: Theme,
  { active = false }: { active?: boolean } = {},
): StyleObject {
  const p = palette(theme);
  return {
    width: 4,
    height: 4,
    borderRadius: '50%',
    backgroundColor: active ? p.primary.main : p.text.disabled,
  };
}
