import { DISPLAY_SCALE } from "@repo/design-tokens"
import type { Config } from "tailwindcss"

function displayStep(
  step: keyof typeof DISPLAY_SCALE,
): [string, { lineHeight: string; letterSpacing: string; fontWeight: string }] {
  const { fontSize, lineHeight, letterSpacing, fontWeight } = DISPLAY_SCALE[step]
  return [fontSize, { lineHeight: `${lineHeight}`, letterSpacing, fontWeight: `${fontWeight}` }]
}

// Every color utility resolves through the `--am-*` variables the root layout
// injects from @repo/design-tokens, so light/dark both come from the shared
// token schemes and the site cannot drift from the product theme.
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        canvas: "var(--am-bg-default)",
        paper: "var(--am-bg-paper)",
        sunken: "var(--am-bg-neutral)",
        ink: "var(--am-text-primary)",
        "ink-soft": "var(--am-text-secondary)",
        "ink-faint": "var(--am-text-disabled)",
        rule: "var(--am-divider)",
        brand: {
          lighter: "var(--am-primary-lighter)",
          light: "var(--am-primary-light)",
          DEFAULT: "var(--am-primary-main)",
          dark: "var(--am-primary-dark)",
          darker: "var(--am-primary-darker)",
          contrast: "var(--am-primary-contrast)",
        },
        success: {
          lighter: "var(--am-success-lighter)",
          light: "var(--am-success-light)",
          DEFAULT: "var(--am-success-main)",
          dark: "var(--am-success-dark)",
        },
        warning: {
          lighter: "var(--am-warning-lighter)",
          light: "var(--am-warning-light)",
          DEFAULT: "var(--am-warning-main)",
          dark: "var(--am-warning-dark)",
        },
        error: {
          lighter: "var(--am-error-lighter)",
          light: "var(--am-error-light)",
          DEFAULT: "var(--am-error-main)",
          dark: "var(--am-error-dark)",
        },
      },
      fontSize: {
        display1: displayStep("display1"),
        display2: displayStep("display2"),
        display3: displayStep("display3"),
      },
      // Deliberately squarer than the product RADIUS tokens: the marketing
      // site runs an editorial, print-like register (hard rules, near-square
      // corners) while the app keeps its softer control radii.
      borderRadius: {
        control: "2px",
        card: "2px",
        overlay: "2px",
        chip: "2px",
      },
      boxShadow: {
        overlay: "var(--am-shadow-overlay)",
        dialog: "var(--am-shadow-dialog)",
      },
    },
  },
  plugins: [],
}

export default config
