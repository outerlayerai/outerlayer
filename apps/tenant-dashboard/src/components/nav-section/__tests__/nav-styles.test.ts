// @vitest-environment node
/**
 * Exact-value contract for the nav-section style helpers.
 *
 * These helpers live in a `.ts` file so they sit inside the Stryker
 * patch-mutation net; the positional `toEqual` on whole style objects is what
 * kills the literal mutants. Every expected value is computed from the same
 * `createAppTheme()` instance, so a drifted spec value, an off-system token
 * sneaking back (e.g. an alpha-blue fill), or a mutated literal all fail here.
 */

import { describe, it, expect } from 'vitest';
import { createTheme } from '@mui/material/styles';

import { createAppTheme } from '../../../theme/create-theme';
import {
  getNavItemStyles,
  getNavItemActiveStyles,
  getNavSubheaderStyles,
  getNavCounterStyles,
  getMiniItemStyles,
  getMiniIconSlotStyles,
  getNavIconSlotStyles,
  getMiniDotStyles,
  getSubItemDotStyles,
} from '../styles';
import { NAV } from '@/layouts/config-layout';

const theme = createAppTheme();
const p = theme.vars!.palette;

describe('nav-section style helpers', () => {
  it('base vertical item (depth 1)', () => {
    expect(getNavItemStyles(theme, { depth: 1 })).toEqual({
      position: 'relative',
      height: 36,
      borderRadius: 6,
      padding: theme.spacing(0, 1.25, 0, 1),
      margin: theme.spacing(0, 1.5, 0.25),
      color: p.text.secondary,
      '&:hover': {
        backgroundColor: p.action.hover,
        color: p.text.primary,
      },
    });
  });

  it('active vertical item (depth 1) — neutral chip + 2px brand bar, weighted label', () => {
    expect(getNavItemActiveStyles(theme, { depth: 1 })).toEqual({
      backgroundColor: p.background.neutral,
      color: p.text.primary,
      '& .nav-label': { fontWeight: theme.typography.fontWeightSemiBold },
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
    });
    // Guard against the banned look: no alpha-blue fill.
    const styles = getNavItemActiveStyles(theme, { depth: 1 });
    expect(styles.backgroundColor).toBe(p.background.neutral);
    expect(styles.backgroundColor).not.toBe(p.action.selected);
  });

  it('active styles fall back to theme.palette under a bare createTheme (no vars)', () => {
    const bare = createTheme();
    expect(bare.vars).toBeUndefined();

    // A direct call: the `(theme.vars ?? theme)` guard must not crash when
    // theme.vars is undefined (the bare-createTheme case consumer/family unit
    // tests hit). A crash here fails the test on its own; the concrete
    // assertion pins that the fallback read primary.main off `theme.palette`.
    const styles = getNavItemActiveStyles(bare, { depth: 1 }) as Record<string, any>;
    expect(styles['&::before'].backgroundColor).toBe(bare.palette.primary.main);
  });

  it('depth-2 sub-item: shorter, one 32px indent step per depth, no neutral fill when active', () => {
    const d2 = getNavItemStyles(theme, { depth: 2 });
    const d3 = getNavItemStyles(theme, { depth: 3 });
    expect(d2.height).toBe(32);
    expect(d2.paddingLeft).toBe(theme.spacing(1.25 + 4));
    expect(d3.paddingLeft).toBe(theme.spacing(1.25 + 8));

    const active2 = getNavItemActiveStyles(theme, { depth: 2 });
    expect(active2).toEqual({
      color: p.text.primary,
      '& .nav-label': { fontWeight: theme.typography.fontWeightSemiBold },
    });
    expect(active2.backgroundColor).toBeUndefined();
  });

  it('subheader: overline colour + insets, one-step hover', () => {
    expect(getNavSubheaderStyles(theme)).toEqual({
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      color: p.text.disabled,
      paddingLeft: theme.spacing(2.75),
      paddingRight: theme.spacing(2.75),
      paddingTop: theme.spacing(2),
      paddingBottom: theme.spacing(1),
      '&:hover': { color: p.text.secondary },
    });
  });

  it('counter: neutral vs attention (mono face, 11px/500)', () => {
    const shared = {
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
    };
    expect(getNavCounterStyles(theme, 'neutral')).toEqual({
      ...shared,
      backgroundColor: p.background.neutral,
      color: p.text.secondary,
    });
    expect(getNavCounterStyles(theme, 'attention')).toEqual({
      ...shared,
      backgroundColor: p.warning.lighter,
      color: p.warning.darker,
    });
    // Default variant is neutral.
    expect(getNavCounterStyles(theme)).toEqual(getNavCounterStyles(theme, 'neutral'));
  });

  it('mini item base tile (40×40, centred)', () => {
    expect(getMiniItemStyles(theme)).toEqual({
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
    });
  });

  it('icon slot is one 24×24 centred square in BOTH modes', () => {
    const slot = {
      width: 24,
      height: 24,
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
    expect(getMiniIconSlotStyles()).toEqual(slot);
    expect(getNavIconSlotStyles()).toEqual(slot);
  });

  it('anchors the icon centre at the same x from the rail edge in both modes', () => {
    // Invariant: vertical and mini place the icon CENTRE at the same distance
    // from the rail's left edge, so collapse/expand reads as labels fading
    // around stationary icons — not icons jumping. Derive both centres from the
    // actual helpers so any drift in padding, slot size, tile size, or the mini
    // rail width breaks this. A plain createTheme() (no CSS-variable spacing)
    // yields simple `Npx` shorthands; the geometry is palette-independent.
    const plain = createTheme();
    const leadingLength = (shorthand: string): number => {
      // CSS shorthand: 4→[t,r,b,l], 2|3→[.,h,.], 1→all. We want the LEFT length.
      const parts = shorthand.split(/\s+/);
      const idx = parts.length === 4 ? 3 : parts.length >= 2 ? 1 : 0;
      return parseFloat(parts[idx]!);
    };

    const item = getNavItemStyles(plain, { depth: 1 });
    const marginLeft = leadingLength(item.margin as string); // 12
    const paddingLeft = leadingLength(item.padding as string); // 8
    const slot = getNavIconSlotStyles().width as number; // 24
    const verticalCentre = marginLeft + paddingLeft + slot / 2;

    const tile = getMiniItemStyles(plain).width as number; // 40, auto-centred in the rail
    const miniCentre = (NAV.MINI_WIDTH - tile) / 2 + tile / 2;

    expect(verticalCentre).toBe(32);
    expect(miniCentre).toBe(32);
    expect(verticalCentre).toBe(miniCentre);
  });

  it('mini dot: :has(*) show rule + hidden slot output (decision D2)', () => {
    expect(getMiniDotStyles(theme)).toEqual({
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
    });
  });

  it('sub-item dot: static colour, no transform', () => {
    expect(getSubItemDotStyles(theme, { active: false })).toEqual({
      width: 4,
      height: 4,
      borderRadius: '50%',
      backgroundColor: p.text.disabled,
    });
    expect(getSubItemDotStyles(theme, { active: true }).backgroundColor).toBe(
      p.primary.main,
    );
  });
});
