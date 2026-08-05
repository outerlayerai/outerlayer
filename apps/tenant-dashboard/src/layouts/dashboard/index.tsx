"use client";

import NavRail from "./nav-rail";
import { LayoutMain } from "../content-frame";
import { useSettingsContext } from '@/components/settings';
import { useShellNav } from "../shell-nav-context";
import { NAV } from "../config-layout";

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

export default function DashboardLayout({ children }: Props) {
  const settings = useSettingsContext();
  // The persistent header (in `(authenticated)/layout.tsx`) owns the mobile
  // toggle; the drawer open state is shared through ShellNavContext.
  const { navOpen, closeNav } = useShellNav();
  const isMini = settings.themeLayout === "mini";

  // The rail width (+1 for its border) is passed unconditionally; the frame's
  // `ml: { lg: ... }` breakpoint gates it, so below `lg` the rail is a drawer
  // that overlays instead of reserving space.
  const railWidth = (isMini ? NAV.MINI_WIDTH : NAV.WIDTH) + 1;

  return (
    <>
      <NavRail openNav={navOpen} onCloseNav={closeNav} />
      <LayoutMain railWidth={railWidth}>{children}</LayoutMain>
    </>
  );
}
