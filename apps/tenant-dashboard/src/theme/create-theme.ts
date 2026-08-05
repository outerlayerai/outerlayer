import {
  createTheme,
  lighten,
  darken,
  type Theme,
  type PaletteColor,
  type PaletteOptions,
  type SimplePaletteColorOptions,
  type Shadows,
} from "@mui/material/styles";

import {
  ACTION,
  BACKGROUND,
  DIVIDER,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SHADOW,
  TEXT,
  TYPE_SCALE,
} from "@repo/design-tokens";

import {
  BRAND_PRIMARY_LIGHT,
  BRAND_PRIMARY_DARK,
  PLATFORM_ADMIN_PRIMARY_MAIN,
} from "./palette";
import { primaryFont, monoFont } from "./typography";

// Enable the cssVariables theme typing (theme.vars / colorSchemes) and the
// custom palette/typography keys the app components read.
// `.lighter`/`.darker`, `background.neutral`, and `fontWeightSemiBold` are
// adopted clean-room design tokens (spec vocabulary — subtle fills, neutral
// bands, the semibold weight); `fontFamilyMonospace` is the consciously pinned
// mono stack the theme assigns to code/id surfaces. The clean-room
// contract test pins this exact set so the augmentation can't silently grow.
declare module "@mui/material/styles" {
  interface CssThemeVariables {
    enabled: true;
  }
  interface PaletteColor {
    lighter: string;
    darker: string;
  }
  interface SimplePaletteColorOptions {
    lighter?: string;
    darker?: string;
  }
  interface TypeBackground {
    neutral: string;
  }
  interface TypeBackgroundOptions {
    neutral?: string;
  }
  interface TypographyVariants {
    fontWeightSemiBold: number;
    fontFamilyMonospace: string;
  }
  interface TypographyVariantsOptions {
    fontWeightSemiBold?: number;
    fontFamilyMonospace?: string;
  }
}

// ----------------------------------------------------------------------
// Dark mode is a color scheme (cssVariables), toggled via useColorScheme().
// `colorSchemeSelector: "class"` pairs with the root layout's
// InitColorSchemeScript `attribute="class"` to allow a manual toggle.

// Scheme raw values come from @repo/design-tokens (the shared source of truth
// with the Claude Design preview bundle); this module composes them into the
// MUI theme. Aliases keep the composition code readable.
const semanticLight = SEMANTIC_LIGHT;
const semanticDark = SEMANTIC_DARK;

// Overlay shadow ladder — the ONLY shadows in the system. Resting surfaces use
// 1px borders; overlays/dialogs get these. Dark values are applied per-override
// via theme.applyStyles("dark", ...) since `shadows:` is theme-level, not
// per-scheme.
const overlayLight = SHADOW.overlayLight;
const dialogLight = SHADOW.dialogLight;
const overlayDark = SHADOW.overlayDark;

// Collapse MUI's 25-step ladder so no component can summon a Material drop
// shadow: everything below "dialog" resolves to the overlay value.
function flatShadows(overlay: string, dialog: string): Shadows {
  return [
    "none",
    ...Array<string>(7).fill(overlay),
    ...Array<string>(17).fill(dialog),
  ] as unknown as Shadows;
}

type PrimaryRamp = {
  main: string;
  light?: string;
  dark?: string;
  lighter?: string;
  darker?: string;
};

type CreateAppThemeOptions = {
  // Override the brand primary (platform-admin passes its distinct accent).
  primary?: PrimaryRamp;
  // A distinct prefix lets a nested ThemeProvider emit its own stylesheet
  // (MUI skips generation when a nested prefix matches the parent's).
  cssVarPrefix?: string;
};

// `.lighter`/`.darker` compat shades for colors that don't ship them. In dark
// mode a "lighter" surface must be a DARK tint of the hue — light tints render
// near-white on a dark background — so the derivation flips per scheme.
function compatShades(main: string, mode: "light" | "dark") {
  return mode === "dark"
    ? { lighter: darken(main, 0.72), darker: lighten(main, 0.64) }
    : { lighter: lighten(main, 0.8), darker: darken(main, 0.8) };
}

// Extend a MUI-resolved semantic color, preserving its curated
// main/light/dark/contrastText, with the compat shades.
function withCompat(
  color: PaletteColor,
  mode: "light" | "dark",
): SimplePaletteColorOptions {
  return { ...color, ...compatShades(color.main, mode) };
}

// Brand primary for a scheme: the spec's OKLCH ramp by default, or a
// single-main override (platform-admin) whose shades are derived and whose
// light/dark/contrastText MUI augments.
function primaryColor(
  mode: "light" | "dark",
  override?: PrimaryRamp,
): SimplePaletteColorOptions {
  if (!override) {
    return { ...(mode === "dark" ? BRAND_PRIMARY_DARK : BRAND_PRIMARY_LIGHT) };
  }
  return {
    main: override.main,
    ...(override.light ? { light: override.light } : {}),
    ...(override.dark ? { dark: override.dark } : {}),
    lighter: override.lighter ?? compatShades(override.main, mode).lighter,
    darker: override.darker ?? compatShades(override.main, mode).darker,
  };
}

function buildScheme(
  mode: "light" | "dark",
  override: PrimaryRamp | undefined,
  muiSecondary: PaletteColor,
): PaletteOptions {
  const isDark = mode === "dark";
  const brand = isDark ? BRAND_PRIMARY_DARK : BRAND_PRIMARY_LIGHT;
  const semantic = isDark ? semanticDark : semanticLight;

  return {
    primary: primaryColor(mode, override),
    // Info is aliased to the brand blue — never a second blue in the system.
    info: { ...brand },
    secondary: withCompat(muiSecondary, mode),
    error: { ...semantic.error },
    warning: { ...semantic.warning },
    success: { ...semantic.success },
    text: { ...TEXT[mode] },
    background: { ...BACKGROUND[mode] },
    divider: DIVIDER[mode],
    action: { ...ACTION[mode] },
  };
}

export function createAppTheme(options: CreateAppThemeOptions = {}): Theme {
  const { primary, cssVarPrefix } = options;

  // MUI's own per-scheme defaults, read once to source `secondary` WITH its
  // curated light/dark/contrastText (the spec palette leaves secondary to MUI).
  const defaults = createTheme({ colorSchemes: { light: true, dark: true } });

  return createTheme({
    cssVariables: {
      colorSchemeSelector: "class",
      ...(cssVarPrefix ? { cssVarPrefix } : {}),
    },
    shape: { borderRadius: 8 },
    colorSchemes: {
      light: {
        palette: buildScheme(
          "light",
          primary,
          defaults.colorSchemes.light!.palette.secondary,
        ),
      },
      dark: {
        palette: buildScheme(
          "dark",
          primary,
          defaults.colorSchemes.dark!.palette.secondary,
        ),
      },
    },
    typography: {
      fontFamily: primaryFont,
      fontFamilyMonospace: monoFont,
      fontSize: 14,
      fontWeightMedium: 500,
      fontWeightSemiBold: 600,
      // The variant ramp (including the h3-h6 remap toward observed page/card
      // title usage) lives in the tokens package.
      ...TYPE_SCALE,
    },
    shadows: flatShadows(overlayLight, dialogLight),
    components: {
      // 1 — Button: de-capsed, no elevation; ink CTA for color="inherit" via
      // the variants API (the containedInherit key is legacy).
      // color defaults to "inherit" (not MUI's "primary") so a bare button is
      // an ink CTA / ink-outlined / ink text by convention — brand blue is
      // opt-in via an explicit color="primary".
      MuiButton: {
        defaultProps: { disableElevation: true, color: "inherit" },
        styleOverrides: {
          // One 8px radius across buttons, inputs, and Card — no 6-vs-8 split on
          // a stacked control column. minHeight 40 (medium/large) matches the
          // OutlinedInput box so a CTA and the field above it read the same
          // height; sizeSmall is left alone (dense toolbars). Large drops its
          // label to the 14px button step so input text and button labels sit
          // on one type size, not 14-vs-15.
          root: ({ theme }) => ({
            borderRadius: 8,
            padding: "6px 14px",
            boxShadow: "none",
            fontWeight: 500,
            variants: [
              {
                props: { variant: "contained", color: "inherit" },
                style: {
                  backgroundColor: theme.vars.palette.text.primary,
                  color: theme.vars.palette.background.paper,
                  "&:hover": {
                    backgroundColor: theme.vars.palette.text.primary,
                    opacity: 0.9,
                  },
                },
              },
            ],
          }),
          outlined: ({ theme }) => ({ borderColor: theme.vars.palette.divider }),
          sizeMedium: { minHeight: 40 },
          sizeLarge: { minHeight: 40, fontSize: "0.875rem" },
        },
      },

      // 2 — AppBar: quiet paper chrome + 1px hairline (not the default blue bar).
      MuiAppBar: {
        defaultProps: { color: "inherit", elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.vars.palette.background.paper,
            color: theme.vars.palette.text.primary,
            boxShadow: "none",
            borderBottom: `1px solid ${theme.vars.palette.divider}`,
          }),
        },
      },

      // 3 — Card: flat, bordered, no dark overlay gradient.
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            border: `1px solid ${theme.vars.palette.divider}`,
            borderRadius: 12,
            boxShadow: "none",
            backgroundImage: "none",
          }),
        },
      },

      // 4 — Paper: kill MUI's per-elevation background-image tint (dark-mode fix).
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: "none" } },
      },

      // 4b — Drawer: the temporary (mobile) nav drawer and the notifications
      // drawer read as opaque chrome columns, not floating tinted sheets.
      MuiDrawer: {
        styleOverrides: {
          paper: ({ theme }) => ({
            backgroundImage: "none",
            backgroundColor: (theme.vars ?? theme).palette.background.paper,
          }),
        },
      },

      // 5 — Inputs: hairline field + soft blue focus ring.
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 8,
            // Lift the small field from ~37px to 40px (vertical padding only, so
            // adornment horizontal padding is untouched) to match the 40px
            // button box — stacked inputs and CTAs measure the same height.
            "&.MuiInputBase-sizeSmall .MuiOutlinedInput-input": {
              paddingTop: 10,
              paddingBottom: 10,
            },
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: theme.vars.palette.divider,
            },
            "&:hover .MuiOutlinedInput-notchedOutline": {
              borderColor: theme.vars.palette.text.disabled,
            },
            // Focus is a neutral border step — no brand-blue ring (a deliberate
            // design deviation, not an oversight).
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: theme.vars.palette.text.primary,
            },
            // Suppress the global focus-visible outline on the field itself.
            "& .MuiInputBase-input:focus-visible": { outline: "none" },
          }),
        },
      },
      MuiTextField: { defaultProps: { size: "small" } },
      // Standalone Select / Autocomplete / FormControl don't inherit the
      // TextField size default, so a no-size dropdown renders at MUI's 56px
      // medium and mismatches the 40px button/field metric. Pin them small too
      // so the whole input family lands on one control height.
      MuiFormControl: { defaultProps: { size: "small" } },
      MuiSelect: { defaultProps: { size: "small" } },
      // Autocomplete renders its own popper+paper slots (NOT through Menu/Popover),
      // so it doesn't inherit the shared overlay styling — join it explicitly or
      // its popup falls back to a flat, elevation-0 white sheet.
      MuiAutocomplete: {
        defaultProps: { size: "small" },
        styleOverrides: {
          paper: ({ theme }) => ({
            borderRadius: 10,
            border: `1px solid ${theme.vars.palette.divider}`,
            boxShadow: overlayLight,
            backgroundImage: "none",
            ...theme.applyStyles("dark", { boxShadow: overlayDark }),
          }),
          listbox: { padding: 6 }, // match MuiMenu list padding (:449)
          option: ({ theme }) => ({
            borderRadius: 6,
            margin: "2px 4px",
            '&[aria-selected="true"]': {
              backgroundColor: theme.vars.palette.action.selected,
            },
          }),
        },
      },

      // 5b — InputLabel: the floating label follows the neutral-focus border
      // (the OutlinedInput override above focuses to ink, not brand blue). Stock
      // MUI colors the focused label primary.main, which paired a blue label
      // with the ink focus border. Ink on focus; error red is preserved
      // (:not(.Mui-error)) so a focused invalid field keeps its red label.
      MuiInputLabel: {
        styleOverrides: {
          root: ({ theme }) => ({
            "&.Mui-focused:not(.Mui-error)": {
              color: theme.vars.palette.text.primary,
            },
          }),
        },
      },

      // 6 — Tabs: de-capsed, thin blue underline. KEEP the scrollable
      // defaultProps (trace-drawer clip fix).
      MuiTabs: {
        defaultProps: { variant: "scrollable", allowScrollButtonsMobile: true },
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: ({ theme }) => ({
            height: 2,
            backgroundColor: theme.vars.palette.primary.main,
          }),
        },
      },
      MuiTab: {
        styleOverrides: {
          root: ({ theme }) => ({
            textTransform: "none",
            fontWeight: 500,
            minHeight: 40,
            minWidth: 0,
            padding: "8px 12px",
            color: theme.vars.palette.text.secondary,
            "&.Mui-selected": { color: theme.vars.palette.primary.main },
          }),
        },
      },

      // 7 — Tooltip: solid ink chip, not translucent grey.
      MuiTooltip: {
        styleOverrides: {
          tooltip: ({ theme }) => ({
            backgroundColor: theme.vars.palette.text.primary,
            color: theme.vars.palette.background.paper,
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 6,
            padding: "5px 9px",
          }),
          arrow: ({ theme }) => ({ color: theme.vars.palette.text.primary }),
        },
      },

      // 8 — Menu / Popover: the one place a soft shadow appears; dark shadow via
      // applyStyles since `shadows:` is theme-level.
      MuiMenu: {
        styleOverrides: {
          paper: ({ theme }) => ({
            borderRadius: 10,
            border: `1px solid ${theme.vars.palette.divider}`,
            boxShadow: overlayLight,
            backgroundImage: "none",
            ...theme.applyStyles("dark", { boxShadow: overlayDark }),
          }),
          list: { padding: 6 },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: ({ theme }) => ({
            borderRadius: 10,
            border: `1px solid ${theme.vars.palette.divider}`,
            boxShadow: overlayLight,
            backgroundImage: "none",
            ...theme.applyStyles("dark", { boxShadow: overlayDark }),
          }),
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 6,
            margin: "2px 4px",
            "&.Mui-selected": {
              backgroundColor: theme.vars.palette.action.selected,
            },
          }),
        },
      },

      // 8b — Dialog family: without these, dialogs render stock MUI. The paper
      // joins the flat-overlay language (radius, no per-elevation tint); it takes
      // NO 1px border because the dialog shadow (elevation 24 → dialogLight)
      // already carries the "0 0 0 1px" ring — a border would double it.
      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: 10, backgroundImage: "none" },
        },
      },
      // DialogTitle defaults to variant h6, but the clean-room h6 is remapped
      // down to a card-label size — restore section-header presence by pinning
      // the h5 ramp step here, NOT by changing the global h6 (which card titles
      // depend on).
      MuiDialogTitle: {
        styleOverrides: {
          root: ({ theme }) => ({
            fontSize: theme.typography.h5.fontSize,
            fontWeight: theme.typography.h5.fontWeight,
            lineHeight: theme.typography.h5.lineHeight,
            padding: "20px 24px 8px",
          }),
        },
      },
      MuiDialogContent: {
        styleOverrides: {
          root: {
            padding: "8px 24px 20px",
            // MUI's stock `.MuiDialogTitle-root + &` rule zeroes paddingTop with higher
            // specificity than the root class alone — re-assert the intended gap.
            ".MuiDialogTitle-root + &": { paddingTop: 8 },
          },
        },
      },
      MuiDialogActions: {
        styleOverrides: { root: { padding: "12px 24px 20px" } },
      },

      // 9 — Chip: mono face — matches the trace-id vocabulary.
      MuiChip: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 6,
            fontWeight: 500,
            fontFamily: theme.typography.fontFamilyMonospace,
            backgroundColor: theme.vars.palette.background.neutral,
          }),
        },
      },

      // 10 — Link: the one blue; underline on hover; accessible focus.
      MuiLink: {
        defaultProps: { underline: "hover" },
        styleOverrides: {
          root: ({ theme }) => ({
            color: theme.vars.palette.primary.main,
            fontWeight: 500,
            "&:focus-visible": {
              outline: `2px solid ${theme.vars.palette.primary.main}`,
              outlineOffset: 2,
              borderRadius: 2,
            },
          }),
        },
      },

      // 11 — TableCell: quiet dense table, neutral header band.
      MuiTableCell: {
        styleOverrides: {
          root: ({ theme }) => ({ borderColor: theme.vars.palette.divider }),
          head: ({ theme }) => ({
            backgroundColor: theme.vars.palette.background.neutral,
            fontWeight: 600,
            fontSize: 13,
            color: theme.vars.palette.text.secondary,
          }),
        },
      },

      // 12 — CssBaseline: one accessible focus ring everywhere + base surface.
      MuiCssBaseline: {
        styleOverrides: (theme) => ({
          // Reserve the scrollbar gutter permanently: without it, toggling
          // between a scrolling and a non-scrolling view (e.g. Context Files
          // vs History) shifts the whole layout by the scrollbar width on
          // browsers with classic (non-overlay) scrollbars.
          html: { scrollbarGutter: "stable" },
          body: { backgroundColor: theme.vars.palette.background.default },
          "*:focus-visible": {
            outline: `2px solid ${theme.vars.palette.primary.main}`,
            outlineOffset: 2,
          },
          "*": {
            scrollbarColor: `${theme.vars.palette.text.disabled} transparent`,
            scrollbarWidth: "thin",
          },
        }),
      },

      // 13 — Switch: recolor the checked state to the one blue; the resting
      // track is quiet neutral ink. Geometry stays stock — resizing the thumb
      // or track would ripple layout, so this is recolor-only.
      MuiSwitch: {
        styleOverrides: {
          switchBase: ({ theme }) => ({
            "&.Mui-checked": { color: theme.vars.palette.text.primary },
            "&.Mui-checked + .MuiSwitch-track": {
              backgroundColor: theme.vars.palette.text.primary,
              opacity: 1,
            },
          }),
          track: ({ theme }) => ({
            backgroundColor: theme.vars.palette.text.disabled,
            opacity: 1,
          }),
        },
      },

      // 14 — Checkbox: quiet the unchecked box (stock draws cool action.active).
      // Checked/indeterminate render as ink (text.primary), matching the all-ink
      // control language — the whole selection-control family (Checkbox, Switch,
      // Radio) checks ink, not brand blue.
      // A `.Mui-error` box (unchecked, applied by RHF checkboxes on validation
      // failure) draws the outline in error.main so a required checkbox gives
      // the same red feedback an OutlinedInput does.
      MuiCheckbox: {
        styleOverrides: {
          root: ({ theme }) => ({
            color: theme.vars.palette.text.disabled,
            "&.Mui-checked": { color: theme.vars.palette.text.primary },
            "&.MuiCheckbox-indeterminate": {
              color: theme.vars.palette.text.primary,
            },
            "&.Mui-error": { color: theme.vars.palette.error.main },
          }),
        },
      },

      // 15 — Radio: same resting/selected split as Checkbox — checks ink.
      MuiRadio: {
        styleOverrides: {
          root: ({ theme }) => ({
            color: theme.vars.palette.text.disabled,
            "&.Mui-checked": { color: theme.vars.palette.text.primary },
          }),
        },
      },

      // 16 — Skeleton: warm-neutral base (tracks the scheme via vars), so a
      // placeholder sits on the same surface language as the content it stands
      // in for. Recolor ONLY — no borderRadius: styleOverrides.root merges after
      // MUI's own variant rules, so an 8px here would clobber circular (→50%)
      // and text (fractional) placeholders. The rounded variant already resolves
      // to shape.borderRadius on its own. Pulse animation left stock.
      MuiSkeleton: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.vars.palette.background.neutral,
          }),
        },
      },

      // 17 — ToggleButtonGroup / ToggleButton: a segmented control in the Tab
      // language — de-capsed, hairline borders, the selected segment reads as
      // the one blue on the quiet selected fill (stock is a boxy primary tint).
      MuiToggleButtonGroup: {
        styleOverrides: {
          grouped: ({ theme }) => ({
            borderColor: theme.vars.palette.divider,
          }),
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: ({ theme }) => ({
            textTransform: "none",
            fontWeight: 500,
            color: theme.vars.palette.text.secondary,
            borderColor: theme.vars.palette.divider,
            "&.Mui-selected": {
              color: theme.vars.palette.primary.main,
              backgroundColor: theme.vars.palette.action.selected,
              "&:hover": {
                backgroundColor: theme.vars.palette.action.selected,
              },
            },
          }),
        },
      },

      // 18 — Alert: flat radius + weight for every variant; the two variants the
      // app actually uses are tokenized through the clean-room ramp. `standard`
      // (the default, ~52 imports) gets the `lighter` fill with `dark` ink;
      // `outlined` (7 dialog/panel sites) keeps a transparent field with a
      // severity-`main` hairline and the same `dark` ink. `info` aliases the
      // brand blue. `filled` is absent in the tree, so it keeps MUI's default.
      MuiAlert: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 8,
            fontWeight: 500,
            variants: (["error", "warning", "info", "success"] as const).flatMap(
              (sev) => [
                {
                  props: { variant: "standard", severity: sev },
                  style: {
                    backgroundColor: theme.vars.palette[sev].lighter,
                    color: theme.vars.palette[sev].dark,
                  },
                },
                {
                  props: { variant: "outlined", severity: sev },
                  style: {
                    color: theme.vars.palette[sev].dark,
                    borderColor: theme.vars.palette[sev].main,
                  },
                },
              ],
            ),
          }),
        },
      },

      // 19 — Slider: the one blue on a hairline rail; the focus/hover halo is the
      // palette's focus alpha, not a Material drop shadow.
      MuiSlider: {
        styleOverrides: {
          root: ({ theme }) => ({ color: theme.vars.palette.primary.main }),
          rail: ({ theme }) => ({
            backgroundColor: theme.vars.palette.divider,
            opacity: 1,
          }),
          track: { border: "none" },
          thumb: ({ theme }) => ({
            "&:hover, &.Mui-focusVisible": {
              boxShadow: `0 0 0 6px ${theme.vars.palette.action.focus}`,
            },
          }),
        },
      },

      // 20 — Accordion family: a flat bordered panel. Accordion inherits the
      // Paper bg-image kill but keeps stock elevation, the ::before divider
      // quirk, and the gutter-margin growth animation. disableGutters + explicit
      // summary sizing removes the animation; the details get a hairline top rule.
      MuiAccordion: {
        defaultProps: { elevation: 0, disableGutters: true },
        styleOverrides: {
          root: ({ theme }) => ({
            border: `1px solid ${theme.vars.palette.divider}`,
            borderRadius: 8,
            "&:before": { display: "none" },
            "&.Mui-expanded": { margin: 0 },
          }),
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          root: { minHeight: 48, "&.Mui-expanded": { minHeight: 48 } },
          content: { margin: "12px 0", "&.Mui-expanded": { margin: "12px 0" } },
        },
      },
      MuiAccordionDetails: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderTop: `1px solid ${theme.vars.palette.divider}`,
            padding: 16,
          }),
        },
      },
    },
  });
}

// Base theme with a distinct primary for the platform-admin area.
export function createPlatformAdminTheme(): Theme {
  return createAppTheme({
    primary: { main: PLATFORM_ADMIN_PRIMARY_MAIN },
    cssVarPrefix: "admin",
  });
}

export const theme = createAppTheme();
