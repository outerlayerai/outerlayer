// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import LoadingScreen from "../loading-screen";
import SplashScreen from "../splash-screen";

function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider theme={createAppTheme()}>{ui}</ThemeProvider>);
}

describe("LoadingScreen", () => {
  it("renders a single progress indicator", () => {
    wrap(<LoadingScreen />);
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it("centers via the in-frame flex contract by default", () => {
    // Bare of an sx override, the loader relies on flexGrow filling the layout
    // column and minHeight:1 (=100%) so a bare mount inside LayoutMain centers.
    wrap(<LoadingScreen />);
    const box = screen.getByRole("progressbar").parentElement as HTMLElement;
    expect(box).toHaveStyle({
      flexGrow: "1",
      minHeight: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
  });

  it("lets a call site override the height for out-of-frame mounts", () => {
    // The app-guard / platform-admin fixes depend on this sx merge: passing
    // minHeight:100vh must win over the default minHeight:1 so a loader mounted
    // with no layout flex parent still has a viewport to center within.
    wrap(<LoadingScreen sx={{ minHeight: "100vh" }} />);
    const box = screen.getByRole("progressbar").parentElement as HTMLElement;
    expect(box).toHaveStyle({
      flexGrow: "1",
      alignItems: "center",
      justifyContent: "center",
    });
    // getComputedStyle resolves viewport lengths to pixels (jsdom viewport is
    // 768px tall), which both proves the sx override beat the default
    // minHeight:1 (= 100%) and is the only form toHaveStyle can't compare.
    expect(getComputedStyle(box).minHeight).toBe("768px");
  });
});

describe("SplashScreen", () => {
  it("renders the brand mark once mounted", () => {
    wrap(<SplashScreen />);
    const mark = screen.getByRole("img", { name: "OuterLayer" });
    expect(mark.getAttribute("src")).toBe("/assets/outerlayer-logo.svg");
    // It is the standalone mark, not a navigable home link.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
