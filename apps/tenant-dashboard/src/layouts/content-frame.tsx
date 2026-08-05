"use client";

/**
 * <LayoutMain> — the shared page frame for BOTH shells.
 *
 * This is the single source of truth for the content column, rather than the
 * railed DashboardLayout and the nav-less AppLayout each hardcoding their own
 * (`1800px !important` vs `Container maxWidth="lg"`). It offsets the fixed
 * header, reserves the rail width at `lg` up, and caps the readable column.
 * It paints no background: the canvas is the CssBaseline body
 * (`background.default`).
 */

import Box, { BoxProps } from "@mui/material/Box";
import { HEADER, CONTENT } from "./config-layout";

type Props = BoxProps & {
  /** Rail width in px INCLUDING its 1px border; 0 = no rail (AppLayout, <lg). */
  railWidth?: number;
};

export function LayoutMain({ children, railWidth = 0, sx, ...other }: Props) {
  return (
    <Box
      component="main"
      sx={[
        (theme) => ({
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          pt: `${HEADER.HEIGHT}px`,
          ...(railWidth > 0 && {
            // Only reserve the rail at `lg` up — below it the rail is a drawer
            // that overlays rather than pushing the content.
            ml: { lg: `${railWidth}px` },
            transition: theme.transitions.create("margin-left", {
              duration: theme.transitions.duration.shorter,
              easing: theme.transitions.easing.sharp,
            }),
          }),
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...other}
    >
      <Box
        sx={{
          width: "100%",
          maxWidth: `${CONTENT.MAX_WIDTH}px`,
          mx: "auto",
          px: CONTENT.GUTTER_X,
          pt: CONTENT.GUTTER_TOP,
          pb: CONTENT.GUTTER_BOTTOM,
          // Full-height pages (trace tables, editors) rely on this flex-column
          // chain — all three properties have to stay together.
          display: "flex",
          flexDirection: "column",
          flex: 1,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
