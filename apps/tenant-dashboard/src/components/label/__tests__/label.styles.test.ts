import { describe, expect, it } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import { getLabelStyles } from "../styles";
import type { LabelColor } from "../types";

// The variant×color → foreground/background/border mapping is the whole point
// of Label: every status surface in the product (deployments, alerts, scores,
// entitlements) reads a pill color from it. These assertions pin each cell to
// an exact theme var so a swapped token (main↔contrastText, dark↔light) is
// caught rather than shrugged off as "still a pill".

const theme = createAppTheme();
const v = theme.vars.palette;
const NON_DEFAULT: readonly Exclude<LabelColor, "default">[] = [
  "primary",
  "secondary",
  "info",
  "success",
  "warning",
  "error",
];

// The class selector `theme.applyStyles('dark', …)` emits, derived from the
// same theme so the test never hard-codes MUI's internal selector string.
const darkSelector = Object.keys(theme.applyStyles("dark", { color: "x" }))[0]!;

describe("getLabelStyles — shared base", () => {
  it("emits the pill geometry and type ramp exactly", () => {
    const s = getLabelStyles(theme, "primary", "filled");
    // Height/minWidth are the caption line box snapped up to the 8px grid at
    // spacing(3); minWidth == height keeps a short/icon-only pill square.
    expect(s.height).toBe(theme.spacing(3));
    expect(s.minWidth).toBe(theme.spacing(3));
    // Small-control radius (Button/Tooltip/Chip/MenuItem idiom), not shape(8).
    expect(s.borderRadius).toBe(6);
    expect(s.display).toBe("inline-flex");
    expect(s.textTransform).toBe("capitalize");
    // Emphasis-label weight (semibold), not heading-only bold.
    expect(s.fontWeight).toBe(theme.typography.fontWeightSemiBold);
    // Caption size, sourced from the type ramp rather than a raw px conversion.
    expect(s.fontSize).toBe(theme.typography.caption.fontSize);
    expect(s.padding).toBe(theme.spacing(0, 0.75));
  });
});

describe("getLabelStyles — non-default colors", () => {
  it.each(NON_DEFAULT)("filled/%s paints main behind contrastText", (color) => {
    const s = getLabelStyles(theme, color, "filled");
    expect(s.backgroundColor).toBe(v[color].main);
    expect(s.color).toBe(v[color].contrastText);
    // Filled never draws a border.
    expect(s.border).toBeUndefined();
  });

  it.each(NON_DEFAULT)("outlined/%s is a hollow main-colored 1px ring", (color) => {
    const s = getLabelStyles(theme, color, "outlined");
    expect(s.backgroundColor).toBe("transparent");
    expect(s.color).toBe(v[color].main);
    // 1px hairline — the theme's resting-border width; 2px is focus-only.
    expect(s.border).toBe(`1px solid ${v[color].main}`);
  });

  it.each(NON_DEFAULT)("soft/%s tints main at the selected-fill strength with a scheme-flipped ink", (color) => {
    const s = getLabelStyles(theme, color, "soft");
    // Wash strength comes from the theme's action.selectedOpacity var (the
    // same tint tier as action.selected), not a transcribed magic opacity.
    expect(s.backgroundColor).toBe(
      `rgba(${v[color].mainChannel} / ${v.action.selectedOpacity})`,
    );
    // Light scheme uses the darker shade; the dark-scheme override swaps to the
    // lighter shade so the ink stays legible on the darker wash.
    expect(s.color).toBe(v[color].dark);
    expect((s as Record<string, unknown>)[darkSelector]).toEqual({
      color: v[color].light,
    });
  });
});

describe("getLabelStyles — default color", () => {
  it("filled inverts ink/paper so contrast holds in both schemes", () => {
    const s = getLabelStyles(theme, "default", "filled");
    expect(s.backgroundColor).toBe(v.text.primary);
    expect(s.color).toBe(v.background.paper);
    expect(s.border).toBeUndefined();
  });

  it("outlined rings the primary ink with a 1px hairline", () => {
    const s = getLabelStyles(theme, "default", "outlined");
    expect(s.backgroundColor).toBe("transparent");
    expect(s.color).toBe(v.text.primary);
    expect(s.border).toBe(`1px solid ${v.text.primary}`);
  });

  it("soft is a neutral surface with secondary ink — no scheme override", () => {
    const s = getLabelStyles(theme, "default", "soft");
    expect(s.backgroundColor).toBe(v.background.neutral);
    expect(s.color).toBe(v.text.secondary);
    expect((s as Record<string, unknown>)[darkSelector]).toBeUndefined();
  });
});
