// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import Logo from "../logo";

function renderLogo(ui: React.ReactElement) {
  return render(<ThemeProvider theme={createAppTheme()}>{ui}</ThemeProvider>);
}

describe("Logo", () => {
  it("renders the brand mark as a home link by default", () => {
    renderLogo(<Logo />);

    const img = screen.getByRole("img", { name: "OuterLayer" });
    expect(img.getAttribute("src")).toBe("/assets/outerlayer-logo.svg");

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/");
    // The image is wrapped by the link.
    expect(link).toContainElement(img);
  });

  it("drops the home link when disabledLink is set", () => {
    renderLogo(<Logo disabledLink />);

    expect(screen.getByRole("img", { name: "OuterLayer" }).getAttribute("src")).toBe(
      "/assets/outerlayer-logo.svg",
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the full wordmark when full is set", () => {
    renderLogo(<Logo full />);

    expect(screen.getByRole("img", { name: "OuterLayer" }).getAttribute("src")).toBe(
      "/assets/outerlayer-full-logo.svg",
    );
  });

  it("keeps the square mark when full is not set", () => {
    renderLogo(<Logo />);

    expect(screen.getByRole("img", { name: "OuterLayer" }).getAttribute("src")).toBe(
      "/assets/outerlayer-logo.svg",
    );
  });
});
