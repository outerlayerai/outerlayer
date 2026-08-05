// @vitest-environment jsdom
/**
 * <AppHeader> — the persistent top bar.
 *
 * The core contract is that ONE adaptive header serves every authenticated
 * route: its chrome (rail offset, mobile toggle, and the wordmark) is derived
 * from the pathname, so navigating org↔app reconciles the SAME header node
 * instead of remounting a per-shell one (the flash). These pins lock the route
 * derivation, the exact rail-offset widths, the no-remount identity, and the
 * rule that the header shows the wordmark only on rail-less (org-level) routes —
 * the rail owns it on app-detail.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ThemeProvider, createTheme } from "@mui/material/styles";

let mockPath = "/orgs/acme/apps";
let mockLgUp = false;

vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));
vi.mock("@/components/settings", () => ({
  useSettingsContext: () => ({ themeLayout: "vertical" }),
}));
vi.mock("../../hooks/use-responsive", () => ({ useResponsive: () => mockLgUp }));
vi.mock("../../auth/hooks/use-memberships", () => ({
  useMemberships: () => ({ memberships: [{ id: "o1" }] }),
}));
vi.mock("@/components/logo", () => ({
  __esModule: true,
  default: ({ full, sx }: { full?: boolean; sx?: { height?: number } }) => (
    // Expose a `data-height` attribute ONLY when the caller overrode the height,
    // so a test can assert the header passes no override (defers to the shared
    // Logo default that the rail also uses).
    <div
      data-testid={full ? "wordmark" : "mark"}
      {...(sx?.height !== undefined ? { "data-height": String(sx.height) } : {})}
    />
  ),
}));
vi.mock("@/components/iconify", () => ({ __esModule: true, default: () => <span /> }));
vi.mock("../../components/app-breadcrumb", () => ({
  AppBreadcrumb: () => <div data-testid="breadcrumb" />,
}));
vi.mock("../../components/common/notifications-popover", () => ({
  __esModule: true,
  default: () => <div data-testid="notif" />,
}));
vi.mock("../../components/common/account-popover", () => ({
  __esModule: true,
  default: () => <div data-testid="account" />,
}));
vi.mock("../../components/temp-access-banner", () => ({
  TempAccessIndicator: () => <div data-testid="temp" />,
}));

import { AppHeader, isAppDetailRoute, headerWidthOffset } from "../app-header";
import { ShellNavProvider } from "../shell-nav-context";

function tree() {
  return (
    <ThemeProvider theme={createTheme()}>
      <ShellNavProvider>
        <AppHeader />
      </ShellNavProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mockPath = "/orgs/acme/apps";
  mockLgUp = false;
});

describe("isAppDetailRoute", () => {
  it("distinguishes the apps LIST (org-level) from an app's DETAIL pages", () => {
    // LIST — no {appName} segment past `apps` → org-level chrome.
    expect(isAppDetailRoute("/orgs/acme/apps")).toBe(false);
    expect(isAppDetailRoute("/orgs/acme/apps/")).toBe(false);
    // DETAIL — the {appName} segment is present.
    expect(isAppDetailRoute("/orgs/acme/apps/my-app")).toBe(true);
    expect(isAppDetailRoute("/orgs/acme/apps/my-app/env/dev/logs")).toBe(true);
    // Other org-level routes.
    expect(isAppDetailRoute("/orgs/acme")).toBe(false);
    expect(isAppDetailRoute("/orgs/acme/settings")).toBe(false);
    expect(isAppDetailRoute("/profile")).toBe(false);
  });
});

describe("headerWidthOffset", () => {
  it("reserves rail width + its 1px border, only on app-detail at lg-up", () => {
    // org-level → full width
    expect(headerWidthOffset(false, true, false)).toBeUndefined();
    // app-detail but below lg → rail overlays as a drawer, no offset
    expect(headerWidthOffset(true, false, false)).toBeUndefined();
    // app-detail, lg-up, vertical rail → 240 + 1
    expect(headerWidthOffset(true, true, false)).toBe("calc(100% - 241px)");
    // app-detail, lg-up, mini rail → 64 + 1
    expect(headerWidthOffset(true, true, true)).toBe("calc(100% - 65px)");
  });
});

describe("AppHeader", () => {
  it("org-level route: wordmark defers to the shared Logo size (matches the rail), no nav toggle", () => {
    mockPath = "/orgs/acme/apps";
    render(tree());
    // The header passes NO height override, so the wordmark renders at the Logo
    // component's default height — the SAME size the rail uses for its expanded
    // wordmark. Re-adding a height override here reintroduces the org-page-vs-
    // in-app size mismatch, so pin its absence.
    expect(screen.getByTestId("wordmark")).not.toHaveAttribute("data-height");
    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
  });

  it("app-detail route (mobile): NO header logo (the rail owns it) but the nav toggle is present", () => {
    mockPath = "/orgs/acme/apps/my-app/env/dev/logs";
    render(tree());
    // The rail carries the logo on app-detail — the header renders neither the
    // wordmark nor the mark.
    expect(screen.queryByTestId("wordmark")).toBeNull();
    expect(screen.queryByTestId("mark")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toBeInTheDocument();
  });

  it("app-detail route (desktop): NO header logo — the header starts right of the rail", () => {
    mockPath = "/orgs/acme/apps/my-app/env/dev/logs";
    mockLgUp = true;
    render(tree());
    expect(screen.queryByTestId("wordmark")).toBeNull();
    expect(screen.queryByTestId("mark")).toBeNull();
  });

  it("keeps ONE header node across an org→app navigation (no remount)", () => {
    mockPath = "/orgs/acme/apps";
    const { rerender } = render(tree());
    const before = screen.getByRole("banner");
    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();

    // Navigate into an app; only the pathname changes.
    mockPath = "/orgs/acme/apps/my-app/env/dev/logs";
    rerender(tree());
    const after = screen.getByRole("banner");

    // Same DOM node → React reconciled the one adaptive header rather than
    // swapping a per-route header (which would flash). Re-splitting into two
    // route-keyed headers, or keying by pathname, breaks this.
    expect(after).toBe(before);
    // ...and the app-detail toggle appeared on that same header.
    expect(
      screen.getByRole("button", { name: "Open navigation" }),
    ).toBeInTheDocument();
  });

  it("reserves the breadcrumb row height so populating segments don't shift the bar", () => {
    render(tree());
    const crumbRow = screen.getByTestId("breadcrumb").parentElement!;
    expect(crumbRow).toHaveStyle({ minHeight: "40px" });
  });
});
