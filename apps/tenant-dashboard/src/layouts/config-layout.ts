// ----------------------------------------------------------------------
// Named chrome layout constants.

export const HEADER = {
  HEIGHT: 56, // one height, all breakpoints (was 64 mobile / 80 desktop)
} as const;

export const NAV = {
  WIDTH: 240, // vertical rail (was 280)
  MINI_WIDTH: 64, // mini rail (was 88)
} as const;

export const CONTENT = {
  MAX_WIDTH: 1600, // content column cap (was a hardcoded 1800px !important)
  GUTTER_X: { xs: 2, sm: 3, lg: 4 }, // 16 / 24 / 32px
  GUTTER_TOP: 3, // 24px between header hairline and page content
  GUTTER_BOTTOM: 8, // 64px tail so last table rows never kiss the viewport edge
} as const;

// Popover / overlay width group. Declared alongside its consumers —
// the three chrome popovers (account menu, notifications drawer, temp-access
// popover) — since `import/no-unused-modules` rejects an export with no reader.
export const POPOVER = {
  ACCOUNT_WIDTH: 240,
  NOTIFICATIONS_WIDTH: 360,
  TEMP_ACCESS_WIDTH: 320,
} as const;
