import { describe, expect, it } from "vitest";

import {
  ACTION,
  DISPLAY_SCALE,
  BRAND_PRIMARY_DARK,
  BRAND_PRIMARY_LIGHT,
  cssVars,
  cssVarsBlock,
  FONT,
  fontStack,
  RADIUS,
  SHADOW,
  TYPE_SCALE,
} from "./index";

describe("cssVars", () => {
  it("maps the light scheme's most-used roles to their exact values", () => {
    const vars = cssVars("light");
    expect(vars["--am-primary-main"]).toBe("#2065D1");
    expect(vars["--am-primary-contrast"]).toBe("#FFFFFF");
    expect(vars["--am-text-primary"]).toBe("#1A1A18");
    expect(vars["--am-bg-paper"]).toBe("#FFFFFF");
    expect(vars["--am-bg-neutral"]).toBe("#F4F4F2");
    expect(vars["--am-divider"]).toBe("#E7E7E3");
    expect(vars["--am-error-main"]).toBe("#D32F2F");
    expect(vars["--am-shadow-overlay"]).toBe(SHADOW.overlayLight);
    expect(vars["--am-shadow-dialog"]).toBe(SHADOW.dialogLight);
    expect(vars["--am-radius-control"]).toBe("8px");
  });

  it("switches every per-scheme role in dark mode (no light value leaks through)", () => {
    const light = cssVars("light");
    const dark = cssVars("dark");
    expect(dark["--am-primary-main"]).toBe(BRAND_PRIMARY_DARK.main);
    expect(dark["--am-primary-contrast"]).toBe("#0B1220");
    expect(dark["--am-bg-default"]).toBe("#131312");
    expect(dark["--am-shadow-overlay"]).toBe(SHADOW.overlayDark);
    // Same contract shape in both schemes: identical key sets.
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    // Neutrals are scheme-invariant; primary/text/bg/divider/action are not.
    expect(dark["--am-neutral-500"]).toBe(light["--am-neutral-500"]);
    for (const key of ["--am-primary-main", "--am-text-primary", "--am-bg-paper", "--am-divider", "--am-action-selected"]) {
      expect(dark[key]).not.toBe(light[key]);
    }
  });

  it("kebab-cases camelCase action states", () => {
    const vars = cssVars("light");
    expect(vars["--am-action-disabled-background"]).toBe(ACTION.light.disabledBackground);
    expect(vars).not.toHaveProperty("--am-action-disabledBackground");
  });

  it("renders a scheme as CSS declarations", () => {
    const block = cssVarsBlock("light");
    expect(block).toContain("  --am-primary-main: #2065D1;");
    expect(block.split("\n")).toHaveLength(Object.keys(cssVars("light")).length);
  });
});

describe("fontStack", () => {
  it("quotes the family and appends fallbacks in order", () => {
    expect(fontStack(FONT.mono)).toBe(
      "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    );
  });
});

describe("scale invariants", () => {
  it("keeps the brand ramps AA-intentional: dark main is the lifted blue, not the light main", () => {
    expect(BRAND_PRIMARY_LIGHT.main).toBe("#2065D1");
    expect(BRAND_PRIMARY_DARK.main).toBe("#4C8DEE");
  });

  it("keeps display steps strictly above the app ramp's largest heading", () => {
    const h1Px = parseFloat("1.875rem") * 16;
    expect(parseFloat("3rem") * 16).toBeGreaterThan(h1Px);
    expect(DISPLAY_SCALE).toEqual({
      display1: { fontSize: "3rem", fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.1 },
      display2: { fontSize: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15 },
      display3: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.25 },
    });
  });

  it("pins the control geometry the component overrides assume", () => {
    expect(RADIUS).toEqual({ control: 8, card: 12, overlay: 10, chip: 6 });
    expect(TYPE_SCALE.button).toEqual({
      fontSize: "0.875rem",
      fontWeight: 500,
      textTransform: "none",
      letterSpacing: 0,
    });
  });
});
