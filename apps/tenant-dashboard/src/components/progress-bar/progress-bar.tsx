"use client";

import { AppProgressBar } from "next-nprogress-bar";
import { useTheme } from "@mui/material/styles";

// ----------------------------------------------------------------------

// Thin top-of-page bar shown during App Router navigations. The color tracks
// the B1 brand primary via its CSS var, so it re-tints with the color scheme.
export default function ProgressBar() {
  const theme = useTheme();
  // `theme.vars` under the app's cssVariables theme; degrade to the resolved
  // palette when a bare MUI theme is in play (e.g. an isolated unit test).
  const palette = (theme.vars ?? theme).palette;

  return (
    <AppProgressBar
      height="2.5px"
      color={palette.primary.main}
      options={{ showSpinner: false }}
      disableSameURL
      shallowRouting
    />
  );
}
