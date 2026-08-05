// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "@mui/material/styles";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import Label from "../label";

function renderLabel(ui: React.ReactElement) {
  return render(<ThemeProvider theme={createAppTheme()}>{ui}</ThemeProvider>);
}

describe("Label", () => {
  it("renders its children inside a span", () => {
    renderLabel(<Label>active</Label>);
    const el = screen.getByText("active");
    expect(el.tagName).toBe("SPAN");
  });

  it("renders the startIcon adornment only when one is provided", () => {
    const { rerender } = renderLabel(
      <Label startIcon={<span data-testid="adornment" />}>running</Label>,
    );
    expect(screen.getByTestId("adornment")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();

    rerender(
      <ThemeProvider theme={createAppTheme()}>
        <Label>running</Label>
      </ThemeProvider>,
    );
    expect(screen.queryByTestId("adornment")).not.toBeInTheDocument();
  });
});
