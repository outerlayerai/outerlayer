"use client";

/**
 * <ShellNavProvider> — the sliver of shell state the persistent header shares
 * with the (per-app) nav rail.
 *
 * The header lives in `(authenticated)/layout.tsx` so it survives every
 * in-app navigation without remounting; the rail lives in DashboardLayout,
 * below. The header owns the mobile "open navigation" button, the rail owns the
 * drawer — so the open/close state has to live above both. That is the ONLY
 * thing shared here: whether the app-detail chrome is org-level or app-detail is
 * derived from the pathname in the header itself, not carried in context.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ShellNavValue = {
  navOpen: boolean;
  openNav: () => void;
  closeNav: () => void;
};

const ShellNavContext = createContext<ShellNavValue | null>(null);

export function ShellNavProvider({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const openNav = useCallback(() => setNavOpen(true), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const value = useMemo<ShellNavValue>(
    () => ({ navOpen, openNav, closeNav }),
    [navOpen, openNav, closeNav],
  );
  return <ShellNavContext.Provider value={value}>{children}</ShellNavContext.Provider>;
}

export function useShellNav(): ShellNavValue {
  const ctx = useContext(ShellNavContext);
  if (!ctx) {
    throw new Error("useShellNav must be used within a ShellNavProvider");
  }
  return ctx;
}
