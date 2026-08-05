"use client";

import { Box, Stack, Typography } from "@mui/material";

// ----------------------------------------------------------------------

type Props = {
  heading: string;
  description?: React.ReactNode;
  /**
   * The left-hand settings nav. Passed as a slot so each area keeps its own
   * tested nav component (active-state, permission gating, query-string
   * preservation) — the shell only owns the two-column frame and page heading.
   */
  nav: React.ReactNode;
  children: React.ReactNode;
};

/**
 * The settings two-column shell: a left nav rail and a right pane that finally
 * carries a real page heading (the org/app settings panes had none). Used by
 * org settings, app settings, and /profile so all three read as one surface.
 */
export function SettingsShell({ heading, description, nav, children }: Props) {
  return (
    <Stack
      direction={{ xs: "column", md: "row" }}
      spacing={{ xs: 2, md: 4 }}
      sx={{ py: { xs: 2, md: 4 } }}
    >
      <Box sx={{ flexShrink: 0, width: { md: 220 } }}>{nav}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ mb: 3 }}>
          <Typography variant="h4">{heading}</Typography>
          {description && (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
              {description}
            </Typography>
          )}
        </Box>
        {children}
      </Box>
    </Stack>
  );
}
