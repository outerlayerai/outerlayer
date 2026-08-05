// @vitest-environment jsdom
/**
 * Tests for the org route's Suspense fallback.
 *
 * Unlike the platform-admin fallback, this one mounts inside AppLayout, whose
 * LayoutMain supplies the full-height flex column — so the shared LoadingScreen
 * centers with its default in-frame contract (flexGrow + minHeight:1) rather
 * than an explicit viewport height. Pins the swap from a top-aligned 50vh Stack
 * to the shared loader, kept wrapped in AppLayout so the chrome stays mounted.
 *
 * AppLayout is a seam here: a passthrough mock avoids booting the real Header
 * and its auth/settings contexts.
 */

import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../../../../../layouts/app/app-layout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">{children}</div>
  ),
}));

import OrgLoading from "../loading";

function renderLoading() {
  return render(
    <ThemeProvider theme={createTheme()}>
      <OrgLoading />
    </ThemeProvider>,
  );
}

describe("OrgLoading", () => {
  it("renders the shared loader inside AppLayout using the in-frame contract", () => {
    renderLoading();

    const layout = screen.getByTestId("app-layout");
    const bar = screen.getByRole("progressbar");
    expect(layout).toContainElement(bar);

    const box = bar.parentElement as HTMLElement;
    expect(box).toHaveStyle({
      flexGrow: "1",
      minHeight: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
  });
});
