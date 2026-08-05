import type { CSSObject, Theme } from "@mui/material/styles";

import { LabelColor, LabelVariant } from "./types";

// ----------------------------------------------------------------------

// Per variant×color the pill resolves to a foreground/background/border trio.
// Every value is a theme var so the pill re-colors with the active color
// scheme; the two genuinely scheme-dependent choices (default-filled contrast,
// soft foreground) are expressed via CSS-var flips or `applyStyles('dark')`,
// never a static `palette.mode` branch (which is frozen under cssVariables).
function variantColorStyles(
  theme: Theme,
  color: LabelColor,
  variant: LabelVariant,
): CSSObject {
  // Under the app's cssVariables theme `theme.vars` carries the scheme-aware
  // CSS vars; a bare MUI theme (e.g. a unit test that doesn't wrap the app
  // theme) exposes none, so degrade to the resolved palette rather than crash.
  const vars = (theme.vars ?? theme) as NonNullable<typeof theme.vars>;

  if (color === "default") {
    switch (variant) {
      case "filled":
        // text.primary is near-ink in light / near-paper in dark, and
        // background.paper is its inverse — so the pair stays legible in both
        // schemes without a mode branch.
        return {
          backgroundColor: vars.palette.text.primary,
          color: vars.palette.background.paper,
        };
      case "outlined":
        return {
          backgroundColor: "transparent",
          color: vars.palette.text.primary,
          border: `1px solid ${vars.palette.text.primary}`,
        };
      case "soft":
        return {
          backgroundColor: vars.palette.background.neutral,
          color: vars.palette.text.secondary,
        };
    }
  }

  const palette = vars.palette[color];

  switch (variant) {
    case "filled":
      return {
        backgroundColor: palette.main,
        color: palette.contrastText,
      };
    case "outlined":
      return {
        backgroundColor: "transparent",
        color: palette.main,
        // 1px hairline — the theme's resting-border idiom everywhere (Card,
        // AppBar, inputs, Menu). 2px is reserved for focus-visible outlines.
        border: `1px solid ${palette.main}`,
      };
    case "soft":
      // Soft wash = the color's own channel tinted at the theme's selected/
      // active fill strength (`action.selectedOpacity`, the CSS var the theme
      // already flips per scheme — 0.08 light → 0.16 dark).
      return {
        backgroundColor: `rgba(${palette.mainChannel} / ${vars.palette.action.selectedOpacity})`,
        // Darker shade reads on the light-scheme wash; the lighter shade takes
        // over on the dark-scheme wash.
        color: palette.dark,
        ...theme.applyStyles("dark", { color: palette.light }),
      };
  }
}

export function getLabelStyles(
  theme: Theme,
  color: LabelColor,
  variant: LabelVariant,
): CSSObject {
  return {
    // Geometry from the theme spacing grid + caption type ramp:
    //  - height/minWidth: the caption line box snapped up to spacing(3) (24px),
    //    a compact control on the 8px grid; minWidth == height keeps a short or
    //    icon-only pill from collapsing narrower than it is tall.
    //  - borderRadius: the theme's small-control radius — Button/Tooltip/Chip/
    //    MenuItem all use 6; shape.borderRadius 8 is for larger surfaces.
    //  - padding: no vertical (fixed height + flex-centered), spacing(0.75)
    //    horizontal breathing.
    //  - type: the caption size at the fontWeightSemiBold emphasis-label weight
    //    (TableCell head / subtitle2 / overline weight; bold 700 is heading-only).
    height: theme.spacing(3),
    minWidth: theme.spacing(3),
    lineHeight: 0,
    borderRadius: 6,
    cursor: "default",
    alignItems: "center",
    whiteSpace: "nowrap",
    display: "inline-flex",
    justifyContent: "center",
    textTransform: "capitalize",
    padding: theme.spacing(0, 0.75),
    fontSize: theme.typography.caption.fontSize,
    fontWeight: theme.typography.fontWeightSemiBold,
    transition: theme.transitions.create("all", {
      duration: theme.transitions.duration.shorter,
    }),
    ...variantColorStyles(theme, color, variant),
  };
}
