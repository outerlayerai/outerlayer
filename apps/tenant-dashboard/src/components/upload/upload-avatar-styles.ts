import { alpha } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';

// ----------------------------------------------------------------------
// Color tokens for <UploadAvatar>. Kept in a `.ts` module (not inline sx) so
// the exact token choices sit in the Stryker patch-mutation net and can be
// asserted with concrete values.
//
// Every color is read through the `(theme.vars ?? theme)` guard: the avatar
// also renders under a bare default theme (no ThemeProvider), where bare
// `theme.vars.*` would crash. The scrim additionally branches on `theme.vars`
// because `text.primaryChannel` exists only on the cssVariables palette —
// falling back to `alpha()` on a bare theme (the chart-wrapper convention).
// This is a vars branch, not a `palette.mode` branch.
// ----------------------------------------------------------------------

const palette = (theme: Theme) => (theme.vars ?? theme).palette;

// Warm low-emphasis surface behind the empty-state camera prompt — the same
// neutral fill the bordered-flat cards use for their footer/pressed states.
export const placeholderFill = (theme: Theme) => palette(theme).background.neutral;

// Dark wash over a set photo so the white "Update photo" prompt stays legible;
// `text.primary` keeps the wash on the warm-neutral ramp.
export const filledScrim = (theme: Theme) =>
  theme.vars
    ? `rgba(${theme.vars.palette.text.primaryChannel} / 0.64)`
    : alpha(theme.palette.text.primary, 0.64);

// Dashed drop-target ring — the same hairline the bordered-flat cards use.
export const dropRingBorder = (theme: Theme) => `1px dashed ${palette(theme).divider}`;
