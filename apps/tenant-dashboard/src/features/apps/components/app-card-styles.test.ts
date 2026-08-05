import { createTheme } from "@mui/material/styles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppTheme } from "@/theme/create-theme";
import type { AppEnvSummary } from "../types";
import {
  activityStampSx,
  appNameSx,
  cardSx,
  envChipSx,
  envChipsWrapSx,
  envLabelSx,
  envVersionSx,
  footerSx,
  formatEnvChipLabel,
  formatRelativeActivity,
  gearButtonSx,
  headerRowSx,
  notConnectedSx,
  overflowChipSx,
  repoLineSx,
  repoTextSx,
  selectEnvChips,
} from "./app-card-styles";

// The card renders against the real app theme in production; pin every style
// value to a theme var read off that same theme so a swapped token (e.g.
// text.disabled → text.secondary) or a drifted literal is caught, and a
// `return {}` gutting of any helper fails.
const theme = createAppTheme();
const v = theme.vars.palette;

const env = (
  name: string,
  is_default: boolean,
  current_version: number,
): AppEnvSummary => ({ name, is_default, current_version });

describe("selectEnvChips", () => {
  it("keeps the default env first, sorts the rest by name, caps at 3, and returns the hidden rest", () => {
    const { chips, hidden, overflow } = selectEnvChips([
      env("staging", false, 7),
      env("prod", true, 0),
      env("alpha", false, 4),
      env("qa", false, 0),
      env("beta", false, 2),
    ]);

    // default first (version null since current_version 0 = HEAD-tracking),
    // then the remaining names ascending; a pinned env carries its version.
    expect(chips).toEqual([
      { name: "prod", version: null },
      { name: "alpha", version: 4 },
      { name: "beta", version: 2 },
    ]);
    // the overflowed tail keeps the same order + version mapping (the +N
    // tooltip lists these): qa then staging by name, staging pinned to v7.
    expect(hidden).toEqual([
      { name: "qa", version: null },
      { name: "staging", version: 7 },
    ]);
    expect(overflow).toBe(2);
  });

  it("returns no chips, no hidden, and zero overflow for an app with no readable envs", () => {
    expect(selectEnvChips([])).toEqual({ chips: [], hidden: [], overflow: 0 });
  });

  it("shows all three envs with no hidden/+N at the 3-env boundary", () => {
    const { chips, hidden, overflow } = selectEnvChips([
      env("prod", true, 3),
      env("dev", false, 0),
      env("staging", false, 0),
    ]);
    expect(chips).toEqual([
      { name: "prod", version: 3 },
      { name: "dev", version: null },
      { name: "staging", version: null },
    ]);
    expect(hidden).toEqual([]);
    expect(overflow).toBe(0);
  });

  it("maps current_version 0 to null and any positive version through unchanged", () => {
    expect(selectEnvChips([env("a", false, 0)]).chips[0]).toEqual({
      name: "a",
      version: null,
    });
    expect(selectEnvChips([env("b", false, 12)]).chips[0]).toEqual({
      name: "b",
      version: 12,
    });
  });
});

describe("formatEnvChipLabel", () => {
  it("appends ` · vN` for a pinned env and shows the bare name for HEAD-tracking", () => {
    expect(formatEnvChipLabel({ name: "preview-gitlab-stg-test", version: 4 })).toBe(
      "preview-gitlab-stg-test · v4",
    );
    expect(formatEnvChipLabel({ name: "dev", version: null })).toBe("dev");
  });
});

describe("formatRelativeActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefixes 'Updated' and renders a suffixed relative distance", () => {
    expect(formatRelativeActivity("2026-07-05T00:00:00Z")).toBe(
      "Updated 2 days ago",
    );
  });
});

describe("app-card style helpers — exact values", () => {
  it("cardSx: full-height flex column, hover steps the border, pressed fills neutral, no shadow/lift", () => {
    expect(cardSx(theme)).toEqual({
      display: "flex",
      flexDirection: "column",
      height: "100%",
      cursor: "pointer",
      "&:hover": { borderColor: v.text.disabled },
      "&:active": { backgroundColor: v.background.neutral },
    });
  });

  it("headerRowSx: name/gear split with its padding", () => {
    expect(headerRowSx).toEqual({
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 1,
      px: 2,
      pt: 2,
      pb: 0.5,
    });
  });

  it("appNameSx: semibold primary ink, ellipsis-safe", () => {
    expect(appNameSx(theme)).toEqual({
      fontWeight: theme.typography.fontWeightSemiBold,
      color: v.text.primary,
      minWidth: 0,
    });
  });

  it("gearButtonSx: 28×28 radius-6, secondary ink, action.hover", () => {
    expect(gearButtonSx(theme)).toEqual({
      width: 28,
      height: 28,
      borderRadius: "6px",
      color: v.text.secondary,
      "&:hover": { backgroundColor: v.action.hover },
    });
  });

  it("repoLineSx: padding and layout", () => {
    expect(repoLineSx).toEqual({
      display: "flex",
      alignItems: "center",
      gap: 1,
      px: 2,
      pb: 1.5,
      minWidth: 0,
    });
  });

  it("repoTextSx: mono 0.75rem secondary ink", () => {
    expect(repoTextSx(theme)).toEqual({
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: "0.75rem",
      color: v.text.secondary,
      minWidth: 0,
    });
  });

  it("notConnectedSx: disabled ink (absence is prose)", () => {
    expect(notConnectedSx(theme)).toEqual({ color: v.text.disabled });
  });

  it("footerSx: neutral strip, hairline top, bottom-only radius, pinned via mt:auto", () => {
    expect(footerSx(theme)).toEqual({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 1,
      mt: "auto",
      px: 2,
      py: 1,
      borderTop: `1px solid ${v.divider}`,
      backgroundColor: v.background.neutral,
      borderRadius: "0 0 11px 11px",
    });
  });

  it("envChipSx: 20px mono chip capped at 110px, shrinkable, clips to its box", () => {
    expect(envChipSx(theme)).toEqual({
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
      backgroundColor: v.background.paper,
      border: `1px solid ${v.divider}`,
      color: v.text.secondary,
    });
  });

  it("envLabelSx: the name+version label, ellipsized as one unit", () => {
    expect(envLabelSx).toEqual({
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      minWidth: 0,
    });
  });

  it("overflowChipSx: the +N chip — chip look but never shrinks or caps", () => {
    expect(overflowChipSx(theme)).toEqual({
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
      backgroundColor: v.background.paper,
      border: `1px solid ${v.divider}`,
      color: v.text.secondary,
    });
  });

  it("envChipsWrapSx: single line — never wraps, clips residual overflow", () => {
    expect(envChipsWrapSx).toEqual({
      display: "flex",
      alignItems: "center",
      flexWrap: "nowrap",
      gap: 0.5,
      minWidth: 0,
      overflow: "hidden",
    });
  });

  it("envVersionSx: disabled-ink pinned-version suffix nested in the label", () => {
    expect(envVersionSx(theme)).toEqual({
      ml: 0.25,
      color: v.text.disabled,
    });
  });

  it("activityStampSx: disabled ink, right-aligned, single line", () => {
    expect(activityStampSx(theme)).toEqual({
      flexShrink: 0,
      whiteSpace: "nowrap",
      color: v.text.disabled,
    });
  });
});

describe("app-card style helpers — bare-theme guard (no theme.vars)", () => {
  // Under a consumer/unit render without a ThemeProvider, MUI hands sx a bare
  // default theme whose `vars` is null. The `(theme.vars ?? theme)` guard must
  // fall back to `theme.palette.*` instead of crashing.
  const bare = createTheme();

  it("cardSx falls back to palette.text.disabled / background.neutral without throwing", () => {
    const s = cardSx(bare) as {
      "&:hover": { borderColor: unknown };
      "&:active": { backgroundColor: unknown };
    };
    expect(s["&:hover"].borderColor).toBe(bare.palette.text.disabled);
    // background.neutral is absent on the bare palette — the guard degrades to
    // undefined rather than throwing, which is the whole point of the fallback.
    expect(s["&:active"].backgroundColor).toBe(
      (bare.palette.background as unknown as Record<string, string | undefined>)
        .neutral,
    );
  });

  it("gearButtonSx falls back to palette.action.hover without throwing", () => {
    const s = gearButtonSx(bare) as { "&:hover": { backgroundColor: unknown } };
    expect(s["&:hover"].backgroundColor).toBe(bare.palette.action.hover);
  });
});
