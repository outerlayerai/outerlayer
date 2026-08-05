// @vitest-environment jsdom
/**
 * Tests for the platform-admin route's Suspense fallback.
 *
 * This route has no layout flex chain, so the loader must carry an explicit
 * viewport height to center within — pins the fix from a top-pinned bespoke
 * Stack to the shared, full-viewport-centered LoadingScreen.
 */

import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

import PlatformAdminLoading from "../loading";

function renderLoading() {
  return render(
    <ThemeProvider theme={createTheme()}>
      <PlatformAdminLoading />
    </ThemeProvider>,
  );
}

describe("PlatformAdminLoading", () => {
  it("centers a single loader on the full viewport", () => {
    renderLoading();

    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    const box = screen.getByRole("progressbar").parentElement as HTMLElement;
    expect(box).toHaveStyle({
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    // getComputedStyle resolves viewport lengths to pixels, so 100vh reads
    // back as jsdom's 768px viewport height — asserted separately because
    // toHaveStyle compares the unresolved "100vh" text and can never match.
    expect(getComputedStyle(box).minHeight).toBe("768px");
  });
});
