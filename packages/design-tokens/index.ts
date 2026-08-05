/**
 * Design tokens — the single source of truth for the product's visual system.
 *
 * The tenant-dashboard MUI theme composes these values into its two color
 * schemes, and the Claude Design preview bundle is generated from them, so
 * neither can drift from the other. Zero-dependency on purpose: the dashboard
 * imports this from client components, and the bundle generator runs it under
 * plain tsx.
 *
 * Every color is authored per scheme rather than derived at runtime — dark
 * values are re-tuned for dark surfaces, not computed tints of the light ones.
 */

export type SchemeMode = "light" | "dark";

export type ColorRamp = {
  lighter: string;
  light: string;
  main: string;
  dark: string;
  darker: string;
  contrastText: string;
};

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

// Brand-blue primary ramp — OKLCH lightness steps from the OuterLayer accent
// #2065D1, no hue drift. Light scheme uses the accent directly.
export const BRAND_PRIMARY_LIGHT: ColorRamp = {
  lighter: "#E9F0FC",
  light: "#6499E6",
  main: "#2065D1",
  dark: "#1A55B8",
  darker: "#143F86",
  contrastText: "#FFFFFF",
};

// Dark scheme lifts main to #4C8DEE — the #2065D1 original fails AA on dark
// surfaces. White-on-#4C8DEE is only ~3:1, so filled buttons take ink text.
export const BRAND_PRIMARY_DARK: ColorRamp = {
  lighter: "#172A4D",
  light: "#86B0F2",
  main: "#4C8DEE",
  dark: "#2A6BD4",
  darker: "#B9D2F8",
  contrastText: "#0B1220",
};

export const BRAND_PRIMARY_MAIN = BRAND_PRIMARY_LIGHT.main;

// Distinct accent for the platform-admin area. The brand is deliberately a
// single blue, so this is an independent choice — Tailwind's open-source
// `violet-600` — not derived from any prior theme.
export const PLATFORM_ADMIN_PRIMARY_MAIN = "#7C3AED";

// ---------------------------------------------------------------------------
// Neutrals
// ---------------------------------------------------------------------------

// Warm-neutral ink ramp — a lightness ladder, deliberately NOT a cool grey
// family. Drives text/background/divider across both schemes.
export const NEUTRAL = {
  50: "#FAFAF9",
  100: "#F4F4F2",
  200: "#E7E7E3",
  300: "#D5D5D0",
  400: "#A8A8A1",
  500: "#7C7C74",
  600: "#5C5C55",
  700: "#44443F",
  800: "#2A2A27",
  900: "#1A1A18",
} as const;

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

export type SemanticRamp = Omit<ColorRamp, "contrastText">;
export type SemanticSet = {
  error: SemanticRamp;
  warning: SemanticRamp;
  success: SemanticRamp;
};

// Light mains follow MUI's defaults; dark mains are re-tuned for dark
// surfaces. lighter/darker are spec-authored tints (compat + subtle fills).
export const SEMANTIC_LIGHT: SemanticSet = {
  error: { lighter: "#FCEDEC", light: "#EF5350", main: "#D32F2F", dark: "#C62828", darker: "#7A1D1A" },
  warning: { lighter: "#FBF1E3", light: "#FF9800", main: "#ED6C02", dark: "#E65100", darker: "#7A3B08" },
  success: { lighter: "#EBF3EC", light: "#4CAF50", main: "#2E7D32", dark: "#1B5E20", darker: "#14401A" },
};
export const SEMANTIC_DARK: SemanticSet = {
  error: { lighter: "#2C1615", light: "#F0908C", main: "#F26B67", dark: "#C0362F", darker: "#F5B4B1" },
  warning: { lighter: "#2A2410", light: "#F0C065", main: "#F0A94C", dark: "#B26B12", darker: "#F5D18A" },
  success: { lighter: "#12281A", light: "#7FCB93", main: "#66BB6A", dark: "#2E7D32", darker: "#A6DBB0" },
};

// ---------------------------------------------------------------------------
// Scheme surfaces / ink / interaction states
// ---------------------------------------------------------------------------

export const TEXT = {
  light: { primary: NEUTRAL[900], secondary: NEUTRAL[600], disabled: NEUTRAL[400] },
  dark: { primary: "#F4F4F2", secondary: "#A8A8A1", disabled: "#6B6B64" },
} as const;

export const BACKGROUND = {
  light: { default: NEUTRAL[50], paper: "#FFFFFF", neutral: NEUTRAL[100] },
  dark: { default: "#131312", paper: "#1B1B19", neutral: "#232320" },
} as const;

export const DIVIDER = {
  light: NEUTRAL[200],
  dark: "rgba(255,255,255,0.10)",
} as const;

export const ACTION = {
  light: {
    active: "rgba(26,26,24,0.56)",
    hover: "rgba(26,26,24,0.04)",
    selected: "rgba(32,101,209,0.08)",
    focus: "rgba(32,101,209,0.24)",
    disabled: "rgba(26,26,24,0.26)",
    disabledBackground: "rgba(26,26,24,0.10)",
  },
  dark: {
    active: "rgba(255,255,255,0.56)",
    hover: "rgba(255,255,255,0.06)",
    selected: "rgba(76,141,238,0.16)",
    focus: "rgba(76,141,238,0.32)",
    disabled: "rgba(255,255,255,0.30)",
    disabledBackground: "rgba(255,255,255,0.12)",
  },
} as const;

// ---------------------------------------------------------------------------
// Data-viz palette
// ---------------------------------------------------------------------------

/**
 * Chart series colors, validated as a set per scheme (colorblind-simulated
 * adjacent-pair separation, normal-vision floor, lightness band, chroma
 * floor, contrast) against the paper surface each mode's charts render on.
 *
 * `categorical` is a FIXED-ORDER slot list: series take slots in sequence and
 * a filter that removes series must not repaint the survivors. The order is
 * the colorblind-safety mechanism — never reorder or cycle it. Light slots
 * 3–4 sit below 3:1 on white by design; charts using them must carry direct
 * labels or a table view.
 *
 * `ordinal` is a one-hue lightness ramp for ordered families of one measure
 * (p50/p95/p99 percentiles, tiers) — the reader sees the order in the color.
 *
 * Status-meaning series (pass/fail, error rate) wear the semantic ramps, not
 * these slots.
 */
export const VIZ = {
  light: {
    categorical: [
      "#2065D1", // slot 1 — brand blue; single-series charts wear only this
      "#008300",
      "#E87BA4",
      "#EDA100",
      "#1BAF7A",
      "#EB6834",
      "#4A3AA7",
      "#E34948",
    ],
    ordinal: ["#6499E6", "#2065D1", "#143F86"],
    grid: "#F0F0ED",
    baseline: "#D5D5D0",
  },
  dark: {
    categorical: [
      "#4C8DEE",
      "#008300",
      "#D55181",
      "#C98500",
      "#199E70",
      "#D95926",
      "#9085E9",
      "#E66767",
    ],
    ordinal: ["#86B0F2", "#4C8DEE", "#2A6BD4"],
    grid: "rgba(255,255,255,0.06)",
    baseline: "rgba(255,255,255,0.16)",
  },
} as const;

export type VizScheme = (typeof VIZ)[SchemeMode];

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

// Overlay shadow ladder — the ONLY shadows in the system. Resting surfaces use
// 1px borders; overlays/dialogs get these.
export const SHADOW = {
  overlayLight: "0 0 0 1px rgba(16,16,15,.06), 0 4px 12px rgba(16,16,15,.10)",
  dialogLight: "0 0 0 1px rgba(16,16,15,.06), 0 12px 32px rgba(16,16,15,.16)",
  overlayDark: "0 0 0 1px rgba(255,255,255,.08), 0 4px 12px rgba(0,0,0,.5)",
} as const;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

// One 8px radius across buttons, inputs, and Card-adjacent controls; cards sit
// a step softer, overlays between, chips a step tighter.
export const RADIUS = {
  control: 8,
  card: 12,
  overlay: 10,
  chip: 6,
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

// UI face: Geist. Code/ids: JetBrains Mono. Both OFL. The dashboard self-hosts
// them at build via next/font; other consumers compose these stacks directly.
export const FONT = {
  sans: {
    family: "Geist",
    fallbacks: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
    weights: [400, 500, 600, 700],
  },
  mono: {
    family: "JetBrains Mono",
    fallbacks: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
    weights: [400, 500, 600],
  },
} as const;

export function fontStack(font: { family: string; fallbacks: readonly string[] }): string {
  return [`'${font.family}'`, ...font.fallbacks].join(", ");
}

export type TypeVariant = {
  fontSize: string;
  fontWeight: number;
  lineHeight?: number;
  letterSpacing?: string | number;
  textTransform?: "uppercase" | "none";
};

// The h3–h6 sizes sit above an abstract ladder on purpose: page titles (h4)
// and card titles (h6) carry the working hierarchy, so those steps are tuned
// to read as titles rather than labels.
export const TYPE_SCALE = {
  h1: { fontSize: "1.875rem", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.2 },
  h2: { fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.3 },
  h3: { fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.3 },
  h4: { fontSize: "1.25rem", fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.35 },
  h5: { fontSize: "1.0625rem", fontWeight: 600, lineHeight: 1.45 },
  h6: { fontSize: "0.9375rem", fontWeight: 600, lineHeight: 1.5 },
  subtitle1: { fontSize: "0.9375rem", fontWeight: 500, lineHeight: 1.5 },
  subtitle2: { fontSize: "0.8125rem", fontWeight: 600, lineHeight: 1.5 },
  body1: { fontSize: "0.875rem", fontWeight: 400, lineHeight: 1.6 },
  body2: { fontSize: "0.8125rem", fontWeight: 400, lineHeight: 1.55 },
  caption: { fontSize: "0.75rem", fontWeight: 400, lineHeight: 1.5 },
  overline: {
    fontSize: "0.75rem",
    fontWeight: 600,
    lineHeight: 1.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  button: { fontSize: "0.875rem", fontWeight: 500, textTransform: "none", letterSpacing: 0 },
} as const satisfies Record<string, TypeVariant>;

// Display steps for marketing surfaces (hero/section headlines). They sit
// above the app ramp on purpose: the dashboard's densest heading is 30px, and
// spreading these into the MUI theme would register variants the app never
// renders — so they are a separate export, not TYPE_SCALE members.
export const DISPLAY_SCALE = {
  display1: { fontSize: "3rem", fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.1 },
  display2: { fontSize: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15 },
  display3: { fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.25 },
} as const satisfies Record<string, TypeVariant>;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semiBold: 600,
  bold: 700,
} as const;

export const BASE_FONT_SIZE = 14;

// ---------------------------------------------------------------------------
// CSS variables
// ---------------------------------------------------------------------------

/**
 * Flatten one scheme to CSS custom properties (`--am-*`). This is the surface
 * non-MUI consumers (the Claude Design bundle, plain HTML/Tailwind pages)
 * build from, so its keys are part of the package contract.
 */
export function cssVars(mode: SchemeMode): Record<string, string> {
  const brand = mode === "dark" ? BRAND_PRIMARY_DARK : BRAND_PRIMARY_LIGHT;
  const semantic = mode === "dark" ? SEMANTIC_DARK : SEMANTIC_LIGHT;
  const vars: Record<string, string> = {};

  for (const [step, value] of Object.entries(brand)) {
    vars[`--am-primary-${step === "contrastText" ? "contrast" : step}`] = value;
  }
  for (const [name, ramp] of Object.entries(semantic)) {
    for (const [step, value] of Object.entries(ramp)) {
      vars[`--am-${name}-${step}`] = value;
    }
  }
  for (const [step, value] of Object.entries(NEUTRAL)) {
    vars[`--am-neutral-${step}`] = value;
  }
  for (const [role, value] of Object.entries(TEXT[mode])) {
    vars[`--am-text-${role}`] = value;
  }
  for (const [role, value] of Object.entries(BACKGROUND[mode])) {
    vars[`--am-bg-${role}`] = value;
  }
  vars["--am-divider"] = DIVIDER[mode];
  for (const [state, value] of Object.entries(ACTION[mode])) {
    vars[`--am-action-${state.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
  }
  vars["--am-shadow-overlay"] = mode === "dark" ? SHADOW.overlayDark : SHADOW.overlayLight;
  vars["--am-shadow-dialog"] = mode === "dark" ? SHADOW.overlayDark : SHADOW.dialogLight;
  for (const [name, value] of Object.entries(RADIUS)) {
    vars[`--am-radius-${name}`] = `${value}px`;
  }
  vars["--am-font-sans"] = fontStack(FONT.sans);
  vars["--am-font-mono"] = fontStack(FONT.mono);

  return vars;
}

/** Render one scheme's variables as a CSS rule body. */
export function cssVarsBlock(mode: SchemeMode, indent = "  "): string {
  return Object.entries(cssVars(mode))
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join("\n");
}
