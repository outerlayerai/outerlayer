import { describe, expect, it } from 'vitest';
import { alpha, createTheme } from '@mui/material/styles';

import { createAppTheme } from '../../../theme/create-theme';
import { placeholderFill, filledScrim, dropRingBorder } from '../upload-avatar-styles';

describe('upload-avatar color tokens', () => {
  it('resolve to the app cssVariables palette tokens', () => {
    const theme = createAppTheme();
    const vars = theme.vars!.palette;

    // Warm neutral surface / hairline / dark ink — the exact clean-room tokens
    // (the resolved value is a `var(--…)` reference, so pin the token name too).
    expect(placeholderFill(theme)).toBe(vars.background.neutral);
    expect(placeholderFill(theme)).toContain('--mui-palette-background-neutral');

    expect(dropRingBorder(theme)).toBe(`1px dashed ${vars.divider}`);
    expect(dropRingBorder(theme)).toContain('--mui-palette-divider');

    expect(filledScrim(theme)).toBe(`rgba(${vars.text.primaryChannel} / 0.64)`);
    expect(filledScrim(theme)).toContain('text-primaryChannel');
    expect(filledScrim(theme)).toContain('/ 0.64)');
  });

  it('degrade to concrete fallbacks on a bare (no-vars) theme without throwing', () => {
    const bare = createTheme();

    // The scrim and ring resolve to concrete colors off the bare palette.
    expect(filledScrim(bare)).toBe(alpha(bare.palette.text.primary, 0.64));
    expect(filledScrim(bare)).toBe('rgba(0, 0, 0, 0.64)');
    expect(dropRingBorder(bare)).toBe(`1px dashed ${bare.palette.divider}`);
    expect(dropRingBorder(bare)).toBe('1px dashed rgba(0, 0, 0, 0.12)');

    // background.neutral is a clean-room-only key; on the bare palette the guard
    // degrades it to undefined rather than throwing (the app-card-styles pattern).
    expect(placeholderFill(bare)).toBe(
      (bare.palette.background as unknown as Record<string, string | undefined>).neutral,
    );
    expect(placeholderFill(bare)).toBeUndefined();

    for (const value of [filledScrim(bare), dropRingBorder(bare)]) {
      expect(value).not.toContain('undefined');
    }
  });
});
