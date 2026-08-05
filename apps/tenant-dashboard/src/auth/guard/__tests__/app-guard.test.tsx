// @vitest-environment jsdom
/**
 * Tests for `<AppGuard>` — the loading/authorization gate that wraps app pages.
 *
 * AppGuard renders INSIDE the dashboard chrome (LayoutMain's flex content
 * pane), so while the app record loads it gates only the content and shows the
 * shared LoadingScreen, which fills+centers within that pane — no viewport-height
 * override (that would overflow past the fixed header).
 *
 * A missing app (unreadable, deleted, or never existed) denies.
 * `useAppContext` is a seam — a `vi.fn` drives each branch. The
 * load-time chrome composition (rail + logo mounted, loader inside the offset
 * content frame) is pinned in
 * `layouts/dashboard/__tests__/dashboard-loading-chrome.test.tsx`.
 */

import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("@/lib/app-shell/app-context", () => ({
  useAppContext: vi.fn(),
}));
vi.mock("../../../sections/error/403-view", () => ({
  default: () => <div data-testid="forbidden-view" />,
}));

import { useAppContext } from "@/lib/app-shell/app-context";
import AppGuard from "../app-guard";

function renderGuard() {
  return render(
    <ThemeProvider theme={createTheme()}>
      <AppGuard>
        <div data-testid="app-child" />
      </AppGuard>
    </ThemeProvider>,
  );
}

describe("AppGuard", () => {
  it("gates the content and shows a centered loader that fills its pane while the app loads", () => {
    vi.mocked(useAppContext).mockReturnValue({
      app: undefined,
      loading: true,
    } as unknown as ReturnType<typeof useAppContext>);

    renderGuard();

    const box = screen.getByRole("progressbar").parentElement as HTMLElement;
    // Centers within — and fills (minHeight:100%) — its parent pane, rather than
    // forcing a 100vh box that would overflow past the fixed header.
    expect(box).toHaveStyle({
      minHeight: "100%",
      alignItems: "center",
      justifyContent: "center",
    });
    expect(box).not.toHaveStyle({ minHeight: "100vh" });
    expect(screen.queryByTestId("app-child")).not.toBeInTheDocument();
  });

  it("renders children once loading resolves and the app is present", () => {
    vi.mocked(useAppContext).mockReturnValue({
      app: { id: "app-1", tenant_id: "tenant-a" },
      loading: false,
    } as unknown as ReturnType<typeof useAppContext>);

    renderGuard();

    expect(screen.getByTestId("app-child")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("denies with ForbiddenView when loading resolves with no app in hand", () => {
    vi.mocked(useAppContext).mockReturnValue({
      app: undefined,
      loading: false,
    } as unknown as ReturnType<typeof useAppContext>);

    renderGuard();

    expect(screen.getByTestId("forbidden-view")).toBeInTheDocument();
    expect(screen.queryByTestId("app-child")).not.toBeInTheDocument();
  });
});
