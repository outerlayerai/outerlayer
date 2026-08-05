import { formatDistanceToNow } from "date-fns";
import type { SxProps, Theme } from "@mui/material/styles";

import type { AppEnvSummary } from "../types";

// ----------------------------------------------------------------------
// Pure logic + style helpers for <AppCard>. Kept in a `.ts` file
// (not `.tsx`) so the env-chip / relative-time logic and every literal style
// value sit inside the Stryker patch-mutation net; the exact-value tests in
// `app-card-styles.test.ts` kill the mutants.
//
// Every color is read through the `(theme.vars ?? theme)` guard: the card
// renders in unit tests without a ThemeProvider, where MUI hands the sx
// callbacks a bare default theme whose `vars` is null — bare `theme.vars.*`
// would crash. Typography tokens are read straight
// off `theme.typography` (always present, never a crash risk).
// ----------------------------------------------------------------------

const palette = (theme: Theme) => (theme.vars ?? theme).palette;

// ----------------------------------------------------------------------
// Env-chip selection (D3). Sort the default env first, then the rest by name
// ascending — a stable, deterministic order so the footer never reshuffles
// between renders. Show at most 3 chips; the rest become `hidden` (surfaced in
// the `+N` chip's tooltip) and `overflow` is their count. A pinned env
// (`current_version > 0`) carries its version; the live/default env
// (`current_version === 0`, HEAD-tracking) carries none.
// ----------------------------------------------------------------------

type EnvChip = { name: string; version: number | null };

const toChip = (env: AppEnvSummary): EnvChip => ({
  name: env.name,
  version: env.current_version > 0 ? env.current_version : null,
});

export function selectEnvChips(envs: AppEnvSummary[]): {
  chips: EnvChip[];
  hidden: EnvChip[];
  overflow: number;
} {
  const sorted = [...envs].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const chips = sorted.slice(0, 3).map(toChip);
  const hidden = sorted.slice(3).map(toChip);

  return { chips, hidden, overflow: hidden.length };
}

// Full "name · vN" label for a chip's tooltip and the `+N` hidden-env list.
// A pinned env appends its version; the HEAD-tracking default shows the name
// alone. Kept pure so both the per-chip tooltip and the overflow list read
// identical text.
export function formatEnvChipLabel(chip: EnvChip): string {
  return chip.version != null ? `${chip.name} · v${chip.version}` : chip.name;
}

// ----------------------------------------------------------------------
// Last-activity stamp (D4). Relative time via the app's own `date-fns@4`
// convention (`formatDistanceToNow({ addSuffix: true })`), e.g.
// "Updated 2 days ago". The caller supplies `updated_at ?? created_at`.
// ----------------------------------------------------------------------

export function formatRelativeActivity(iso: string): string {
  return `Updated ${formatDistanceToNow(new Date(iso), { addSuffix: true })}`;
}

// ----------------------------------------------------------------------
// Style helpers. Color-bearing ones are `(theme) => object`;
// layout-only ones are plain sx objects. All consumed directly as `sx`.
// ----------------------------------------------------------------------

// Card shell states + layout. The theme's MuiCard override supplies the resting
// look (12px radius, 1px divider, no shadow); this adds the interaction states
// (hover steps the border per the input-hover convention; pressed fills the
// body neutral — no lift, shadow, or translate) and makes the card a
// full-height flex column so every card in a grid row stretches to the same
// height with its footer pinned to the bottom (footerSx `mt:'auto'`).
export const cardSx = (theme: Theme) => ({
  display: "flex",
  flexDirection: "column",
  height: "100%",
  cursor: "pointer",
  "&:hover": { borderColor: palette(theme).text.disabled },
  "&:active": { backgroundColor: palette(theme).background.neutral },
});

// Header row: name (left) + settings gear (right).
export const headerRowSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 1,
  px: 2,
  pt: 2,
  pb: 0.5,
};

export const appNameSx = (theme: Theme) => ({
  fontWeight: theme.typography.fontWeightSemiBold,
  color: palette(theme).text.primary,
  minWidth: 0,
});

// 28×28 settings icon button, 18px line gear.
export const gearButtonSx = (theme: Theme) => ({
  width: 28,
  height: 28,
  borderRadius: "6px",
  color: palette(theme).text.secondary,
  "&:hover": { backgroundColor: palette(theme).action.hover },
});

// Repo line: provider glyph + mono `owner/repo · branch`.
export const repoLineSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  px: 2,
  pb: 1.5,
  minWidth: 0,
};

export const repoTextSx = (theme: Theme) => ({
  fontFamily: theme.typography.fontFamilyMonospace,
  fontSize: "0.75rem",
  color: palette(theme).text.secondary,
  minWidth: 0,
});

// "Not connected to git" prose (absence is prose, not an identifier).
export const notConnectedSx = (theme: Theme) => ({
  color: palette(theme).text.disabled,
});

// Footer strip: env chips (left) + activity stamp (right). Pinned to the card
// bottom with `mt:'auto'` (the card is a flex column, cardSx) so footers align
// across a grid row. `borderRadius` is `0 0 11px 11px` = the 12px card radius
// minus its 1px border.
export const footerSx = (theme: Theme) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 1,
  mt: "auto",
  px: 2,
  py: 1,
  borderTop: `1px solid ${palette(theme).divider}`,
  backgroundColor: palette(theme).background.neutral,
  borderRadius: "0 0 11px 11px",
});

// The chip group is a SINGLE line, always — cards keep one constant height.
// It never wraps; instead each env chip caps its width and
// truncates, and `overflow:'hidden'` clips any residual so a long env name can
// never cascade the footer to a second line.
export const envChipsWrapSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  flexWrap: "nowrap",
  gap: 0.5,
  minWidth: 0,
  overflow: "hidden",
};

// Env chip: mono, paper-white on a hairline. Capped at 110px and shrinkable
// (`flexShrink:1`, `minWidth:0`) so a long env name truncates instead of
// wrapping or pushing the +N/activity off the line. `overflow:'hidden'` clips
// to the chip box; the inner label span (envLabelSx) carries the ellipsis.
export const envChipSx = (theme: Theme) => ({
  display: "inline-flex",
  alignItems: "center",
  height: 20,
  maxWidth: 110,
  minWidth: 0,
  flexShrink: 1,
  overflow: "hidden",
  borderRadius: "4px",
  px: 0.75,
  fontFamily: theme.typography.fontFamilyMonospace,
  fontSize: "11px",
  fontWeight: 500,
  backgroundColor: palette(theme).background.paper,
  border: `1px solid ${palette(theme).divider}`,
  color: palette(theme).text.secondary,
});

// The chip's label — name plus (nested) version — ellipsized as ONE unit so a
// squeezed chip always keeps the name leading (e.g. "canary…"), never collapses
// the name and leaves a bare "·v11".
export const envLabelSx: SxProps<Theme> = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

// The `+N` overflow chip: same look as an env chip but never shrinks or caps —
// it's short and the single-line contract keeps it (and the activity stamp)
// always visible.
export const overflowChipSx = (theme: Theme) => ({
  display: "inline-flex",
  alignItems: "center",
  height: 20,
  flexShrink: 0,
  borderRadius: "4px",
  px: 0.75,
  fontFamily: theme.typography.fontFamilyMonospace,
  fontSize: "11px",
  fontWeight: 500,
  whiteSpace: "nowrap",
  backgroundColor: palette(theme).background.paper,
  border: `1px solid ${palette(theme).divider}`,
  color: palette(theme).text.secondary,
});

// Pinned-version suffix (`·v4`), nested inline inside the label so it truncates
// with the name rather than clinging on after the name has vanished.
export const envVersionSx = (theme: Theme) => ({
  ml: 0.25,
  color: palette(theme).text.disabled,
});

export const activityStampSx = (theme: Theme) => ({
  flexShrink: 0,
  whiteSpace: "nowrap",
  color: palette(theme).text.disabled,
});
