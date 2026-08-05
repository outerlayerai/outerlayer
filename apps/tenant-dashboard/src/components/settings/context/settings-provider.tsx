"use client";

import React, { useMemo, useCallback } from "react";
import { useColorScheme } from "@mui/material/styles";

import { SettingsValueProps } from "../types";
import { SettingsContext } from "./settings-context";
import { useLocalStorage } from "../../../hooks/use-local-storage";

// ----------------------------------------------------------------------
// themeMode is owned by MUI's color scheme (useColorScheme); only the
// layout/stretch keys are persisted here. Must render inside the ThemeProvider
// so useColorScheme has its context.

const STORAGE_KEY = "settings";

type SettingsProviderProps = {
  children: React.ReactNode;
  defaultSettings: SettingsValueProps;
};

export function SettingsProvider({
  children,
  defaultSettings,
}: SettingsProviderProps) {
  const { mode, systemMode, setMode } = useColorScheme();

  const { state, update } = useLocalStorage(STORAGE_KEY, {
    themeLayout: defaultSettings.themeLayout,
  });

  const onUpdate = useCallback(
    (name: string, value: string | boolean) => {
      if (name === "themeMode") {
        setMode(value as "light" | "dark" | "system");
        return;
      }
      update(name, value);
    },
    [setMode, update]
  );

  const resolvedMode = mode === "system" ? systemMode : mode;
  const themeMode: "light" | "dark" = resolvedMode === "dark" ? "dark" : "light";

  // The layout value space is `vertical | mini`. A user with a persisted
  // `"horizontal"` (or any other stale/garbage value) must resolve to
  // `"vertical"` so their nav still renders instead of matching no branch.
  const themeLayout: "vertical" | "mini" =
    state.themeLayout === "mini" ? "mini" : "vertical";

  const memoizedValue = useMemo(
    () => ({
      ...state,
      themeLayout,
      themeMode,
      onUpdate,
    }),
    [state, themeLayout, themeMode, onUpdate]
  );

  return (
    <SettingsContext.Provider value={memoizedValue}>
      {children}
    </SettingsContext.Provider>
  );
}
