// @vitest-environment jsdom
/**
 * Load-time chrome composition (app-open loading-state bug).
 *
 * On an app-detail route the persistent header immediately applies the
 * rail-width offset and drops its logo. If AppGuard rendered its
 * LoadingScreen IN PLACE OF the whole shell while the app record loads, the
 * rail (which owns the logo) would never mount — producing an empty reserved
 * rail strip, no logo anywhere, and a loader centered against the full
 * viewport instead of the offset content pane.
 *
 * Instead, the dashboard chrome (rail + content frame) mounts unconditionally
 * and AppGuard gates only the CONTENT, rendering the loader INSIDE LayoutMain.
 * These pins lock that load-time shape:
 *   - the rail is mounted and shows its logo (negative pin on the brandless state),
 *   - the loader renders inside the <main> content frame (the offset, visible
 *     pane — not a full-bleed box outside the rail offset),
 *   - the page content stays gated until the app resolves.
 *
 * Only the leaf deps are stubbed; DashboardLayout → NavRail → LayoutMain and
 * AppGuard render for real so the composition itself is under test.
 * `useResponsive` is forced true so the desktop fixed rail (and the rail offset)
 * render — jsdom can't evaluate the real breakpoint.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("@/components/nav-section", () => ({
  NavSectionVertical: () => <div data-testid="nav-vertical" />,
  NavSectionMini: () => <div data-testid="nav-mini" />,
}));
vi.mock("@/components/logo", () => ({
  __esModule: true,
  default: ({ full }: { full?: boolean }) => (
    <div data-testid={full ? "wordmark" : "mark"} />
  ),
}));
vi.mock("@/hooks/use-responsive", () => ({ useResponsive: () => true }));
vi.mock("@/layouts/dashboard/config-navigation", () => ({
  useNavData: () => [{ items: [] }],
}));

// The app record is still loading — the branch AppGuard gates content on.
vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: () => ({ app: undefined, loading: true }),
}));

import DashboardLayout from "../index";
import AppGuard from "@/auth/guard/app-guard";
import { ShellNavProvider } from "../../shell-nav-context";

function renderLoadingChrome() {
  return render(
    <ThemeProvider theme={createTheme()}>
      <ShellNavProvider>
        <DashboardLayout>
          <AppGuard>
            <div data-testid="page">app page</div>
          </AppGuard>
        </DashboardLayout>
      </ShellNavProvider>
    </ThemeProvider>,
  );
}

describe("dashboard chrome during app load", () => {
  it("mounts the rail with its logo (not a brandless empty strip)", () => {
    renderLoadingChrome();
    // Expanded rail carries the wordmark — the fix's whole point is that this
    // renders DURING load, not only after the app resolves.
    expect(screen.getByTestId("wordmark")).toBeInTheDocument();
  });

  it("renders the loader inside the offset content frame, and gates the page", () => {
    renderLoadingChrome();

    const main = screen.getByRole("main");
    const loader = screen.getByRole("progressbar");
    // The loader lives inside <main> (LayoutMain — the header-offset,
    // rail-reserving content pane), so it centers in the visible area rather
    // than against the full viewport.
    expect(main).toContainElement(loader);
    // Page content stays gated until the app record resolves.
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();
  });
});
