"use client";

/**
 * <AppHeader> — the ONE persistent top bar for every authenticated route.
 *
 * It is mounted once in `(authenticated)/layout.tsx`, the common ancestor of
 * both shells, so navigating org ↔ app never remounts it — the header reads as
 * a stationary frame with its breadcrumb and (on app-detail) rail offset
 * animating around it, instead of the whole bar flashing out and back.
 *
 * Route-conditional chrome, all derived from the pathname here (never from an
 * up-context, which would flicker on mount): the mobile "open navigation"
 * toggle, the rail-width offset, and the wordmark — all keyed on whether this
 * is an app DETAIL route. On app-detail the rail owns the logo at its top-left,
 * so the header carries none and starts right of the rail; on rail-less
 * (org-level) routes the header carries the wordmark. The breadcrumb and
 * trailing cluster are identical on every route.
 *
 * The logo handing off between the rail and the header on org↔app transitions
 * is inherent to a sidebar-logo layout (and accepted by the user): only one
 * surface owns the mark at a time — the rail when there is one, else the header.
 */

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Iconify from "@/components/iconify";
import Logo from "@/components/logo";
import { useSettingsContext } from "@/components/settings";
import NotificationsPopover from "../components/common/notifications-popover";
import AccountPopover from "../components/common/account-popover";
import { AppBreadcrumb } from "../components/app-breadcrumb";
import { TempAccessIndicator } from "../components/temp-access-banner";
import { useResponsive } from "../hooks/use-responsive";
import { useMemberships } from "../auth/hooks/use-memberships";
import { HEADER, NAV } from "./config-layout";
import { ChromeIconButton } from "./common/chrome-icon-button";
import { useShellNav } from "./shell-nav-context";

// ----------------------------------------------------------------------

/**
 * App DETAIL = `/orgs/{org}/apps/{appName}[/...]` — an app's own pages, which
 * get the rail + toggle. The apps LIST at `/orgs/{org}/apps` (no `{appName}`
 * segment) is org-level chrome, so the pattern REQUIRES the segment past
 * `apps`. Without it, the list would wrongly render app-detail chrome.
 */
export function isAppDetailRoute(pathname: string): boolean {
  return /^\/orgs\/[^/]+\/apps\/[^/]+/.test(pathname);
}

/**
 * The fixed bar's width. App-detail routes at `lg` up reserve the rail (its
 * width + its 1px border); everywhere else — org level, or the mobile drawer
 * where the rail overlays — the bar is full width. Returns `undefined` for the
 * full-width case so the caller can spread it conditionally.
 */
export function headerWidthOffset(
  isAppDetail: boolean,
  lgUp: boolean,
  isNavMini: boolean,
): string | undefined {
  if (!(isAppDetail && lgUp)) return undefined;
  return `calc(100% - ${(isNavMini ? NAV.MINI_WIDTH : NAV.WIDTH) + 1}px)`;
}

// ----------------------------------------------------------------------

// Render children only if the user has org memberships (mirrors the old
// per-shell headers — the breadcrumb + org-scoped controls need an org).
function RequiresMembership({ children }: { children: ReactNode }) {
  const { memberships } = useMemberships();
  if (memberships.length === 0) return null;
  return <>{children}</>;
}

// ----------------------------------------------------------------------

export function AppHeader() {
  const pathname = usePathname();
  const settings = useSettingsContext();
  const { openNav } = useShellNav();
  const lgUp = useResponsive("up", "lg");

  const isAppDetail = isAppDetailRoute(pathname ?? "");
  const isNavMini = settings.themeLayout === "mini";
  const widthOffset = headerWidthOffset(isAppDetail, lgUp, isNavMini);

  return (
    // Solid paper + hairline come from the global MuiAppBar override;
    // the bar sets no surface of its own. `width` transitions on the rail
    // offset (org↔app, and the mini toggle); nothing else animates.
    <AppBar
      position="fixed"
      sx={(theme) => ({
        height: HEADER.HEIGHT,
        justifyContent: "center",
        zIndex: theme.zIndex.appBar,
        transition: theme.transitions.create("width", {
          duration: theme.transitions.duration.shorter,
          easing: theme.transitions.easing.sharp,
        }),
        ...(widthOffset && { width: widthOffset }),
      })}
    >
      <Toolbar
        disableGutters
        sx={{
          height: 1,
          minHeight: { xs: `${HEADER.HEIGHT}px` },
          px: { xs: 2, lg: 3 },
          gap: 1,
        }}
      >
        {isAppDetail && !lgUp && (
          <ChromeIconButton aria-label="Open navigation" onClick={openNav}>
            <Iconify icon="mdi:menu" width={20} />
          </ChromeIconButton>
        )}

        {/*
          The header carries the wordmark ONLY on rail-less (non-app-detail)
          routes; on app-detail the rail owns the logo at its top-left. Within
          the rail-less header, below `sm` it drops to the square mark so the bar
          still fits the breadcrumb + trailing cluster at 390px — a breakpoint
          rule nested under the route rule.

          The wordmark takes NO height override: it renders at the shared `Logo`
          default, the same size the rail uses for its expanded wordmark, so the
          mark stays one size across the org↔app handoff. Do not pin a height
          here — that is what made the org-page logo render smaller than in-app.
        */}
        {!isAppDetail && (
          <>
            <Logo
              full
              sx={{
                mr: { xs: 1.5, lg: 2 },
                flexShrink: 0,
                display: { xs: "none", sm: "inline-flex" },
              }}
            />
            <Logo
              sx={{
                width: 24,
                height: 24,
                mr: 1.5,
                flexShrink: 0,
                display: { xs: "inline-flex", sm: "none" },
              }}
            />
          </>
        )}

        {/*
          The three-segment breadcrumb spine `Org / App / Env`.
          The App and Env segments self-collapse outside an app route, so on
          org-level pages this narrows to the org switcher. `minHeight` reserves
          the control row so the bar doesn't shift as segments populate.
        */}
        <RequiresMembership>
          <Box sx={{ display: "flex", alignItems: "center", minHeight: 40, minWidth: 0, flex: "1 1 auto" }}>
            <AppBreadcrumb />
          </Box>
        </RequiresMembership>

        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 1,
            flexShrink: 0,
            ml: "auto",
          }}
        >
          <RequiresMembership>
            <TempAccessIndicator />
          </RequiresMembership>
          <RequiresMembership>
            <NotificationsPopover />
          </RequiresMembership>
          <AccountPopover />
        </Stack>
      </Toolbar>
    </AppBar>
  );
}
