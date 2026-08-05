"use client";

/**
 * <NavRail> — the fixed left navigation rail.
 *
 * One component owns BOTH the 240px vertical and 64px mini widths so `width`
 * actually transitions on the mini toggle; splitting the two widths across
 * separate components would mount/unmount instead, and the width would snap.
 * Structure: logo row (fixed) · scrollable
 * item region · footer collapse control (fixed). The logo lives at the rail's
 * top-left — the wordmark when expanded, the square mark when mini; the header
 * only carries it on rail-less (non-app-detail) routes. Below `lg` the rail
 * renders inside a temporary Drawer that closes on route change.
 *
 * The rail container is a plain Box, NOT `component="nav"`: the
 * nav-section family renders its own `<nav>` landmark, so the rail must not nest
 * a second one. The collapse control is the fixed footer row here.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import ButtonBase from "@mui/material/ButtonBase";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Iconify from "@/components/iconify";
import Logo from "@/components/logo";
import { NavSectionVertical, NavSectionMini } from "@/components/nav-section";
import { useSettingsContext } from "@/components/settings";
import { useResponsive } from "../../hooks/use-responsive";
import { useNavData } from "./config-navigation";
import { HEADER, NAV } from "../config-layout";

// ----------------------------------------------------------------------

type Props = {
  openNav: boolean;
  onCloseNav: VoidFunction;
};

export default function NavRail({ openNav, onCloseNav }: Props) {
  const pathname = usePathname();
  const settings = useSettingsContext();
  const lgUp = useResponsive("up", "lg");
  const navData = useNavData();

  // Mini is only meaningful at `lg` up — the mobile drawer is always full.
  const mini = settings.themeLayout === "mini";

  // Close the mobile drawer on route change (carry-over from nav-vertical).
  useEffect(() => {
    if (openNav) {
      onCloseNav();
    }
  }, [pathname]);

  const handleToggle = () => {
    settings.onUpdate("themeLayout", mini ? "vertical" : "mini");
  };

  const logoRow = (isMini: boolean) => (
    <Box
      sx={{
        height: HEADER.HEIGHT,
        flexShrink: 0,
        borderBottom: "1px solid",
        borderColor: "divider",
        display: "flex",
        alignItems: "center",
        ...(isMini ? { justifyContent: "center", px: 0 } : { px: 2 }),
      }}
    >
      {/* Logo links to the org root (current behavior). Expanded rail shows the
          wordmark; the mini rail keeps the 24px square mark. */}
      <Logo full={!isMini} sx={isMini ? { width: 24, height: 24 } : undefined} />
    </Box>
  );

  const scrollRegion = (isMini: boolean) => (
    // The logo row above supplies the top spacing; the scroll region starts
    // flush under its hairline.
    <Box
      sx={{
        flexGrow: 1,
        height: "100%",
        maxHeight: "100%",
        overflow: "auto",
        flex: 1,
        minHeight: 0,
      }}
    >
      <Box sx={{ minHeight: "100%" }}>
        {isMini ? (
          <NavSectionMini data={navData} />
        ) : (
          <NavSectionVertical data={navData} />
        )}
      </Box>
    </Box>
  );

  const footerControl = mini ? (
    <Tooltip title="Expand" placement="right">
      <ButtonBase
        aria-label="Expand navigation"
        onClick={handleToggle}
        sx={{
          width: 40,
          height: 40,
          mx: "auto",
          borderRadius: "6px",
          justifyContent: "center",
          color: "text.secondary",
          "&:hover": { bgcolor: "action.hover", color: "text.primary" },
        }}
      >
        <Iconify icon="mdi:chevron-double-right" width={20} />
      </ButtonBase>
    </Tooltip>
  ) : (
    <ButtonBase
      aria-label="Collapse navigation"
      onClick={handleToggle}
      sx={{
        height: 36,
        flex: 1,
        mx: 1.5,
        px: 1.25,
        borderRadius: "6px",
        justifyContent: "flex-start",
        gap: 1.5,
        color: "text.secondary",
        "&:hover": { bgcolor: "action.hover", color: "text.primary" },
      }}
    >
      <Iconify icon="mdi:chevron-double-left" width={20} />
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        Collapse
      </Typography>
    </ButtonBase>
  );

  if (lgUp) {
    return (
      <Box
        sx={{
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          width: mini ? NAV.MINI_WIDTH : NAV.WIDTH,
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.default",
          borderRight: "1px solid",
          borderColor: "divider",
          overflow: "hidden",
          transition: (theme) =>
            theme.transitions.create("width", {
              duration: theme.transitions.duration.shorter,
              easing: theme.transitions.easing.sharp,
            }),
        }}
      >
        {logoRow(mini)}
        {scrollRegion(mini)}
        <Box
          sx={{
            height: 44,
            flexShrink: 0,
            borderTop: "1px solid",
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
          }}
        >
          {footerControl}
        </Box>
      </Box>
    );
  }

  return (
    <Drawer
      open={openNav}
      onClose={onCloseNav}
      slotProps={{
        paper: {
          sx: {
            width: NAV.WIDTH,
            bgcolor: "background.default",
            border: "none",
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      {logoRow(false)}
      {scrollRegion(false)}
    </Drawer>
  );
}
