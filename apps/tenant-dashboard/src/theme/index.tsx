"use client";

import * as React from "react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider as MuiThemeProvider } from "@mui/material/styles";

import { NextAppDirEmotionCacheProvider } from "./next-emotion-cache";
import { theme } from "./create-theme";

export { createAppTheme, createPlatformAdminTheme, theme } from "./create-theme";
export { bgBlur } from "./css";

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

export function ThemeProvider({ children }: Props) {
  return (
    <NextAppDirEmotionCacheProvider options={{ key: "css" }}>
      <MuiThemeProvider theme={theme} defaultMode="light">
        <CssBaseline enableColorScheme />
        {children}
      </MuiThemeProvider>
    </NextAppDirEmotionCacheProvider>
  );
}
