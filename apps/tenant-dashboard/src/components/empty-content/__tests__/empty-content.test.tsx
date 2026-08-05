// @vitest-environment jsdom
/**
 * Contract + a11y baseline for EmptyContent.
 *
 * EmptyContent renders on every "no rows yet" surface in the dashboard
 * (apps, datasets, api-keys, table no-data). These tests pin the exact text
 * it emits, the default vs. overridden image source, and the presence of an
 * action slot — the render contract every consumer relies on — plus a11y
 * across the states consumers actually mount.
 */
import { ThemeProvider } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createAppTheme } from "../../../theme/create-theme";
import { expectNoA11yViolations } from "../../../test-helpers/a11y";
import EmptyContent from "../empty-content";

function renderEC(ui: React.ReactElement) {
  return render(<ThemeProvider theme={createAppTheme()}>{ui}</ThemeProvider>);
}

describe("EmptyContent", () => {
  it("renders an inline SVG illustration (no <img>) when no imgUrl is given", () => {
    const { container } = renderEC(<EmptyContent />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("emits no licensed asset path in the default illustration", () => {
    const { container } = renderEC(<EmptyContent />);
    expect(container.innerHTML).not.toContain("ic_content");
    expect(container.innerHTML).not.toContain("/assets/");
  });

  it("uses a caller-supplied imgUrl in place of the default illustration", () => {
    const { container } = renderEC(<EmptyContent imgUrl="/custom/pic.svg" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/custom/pic.svg",
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders the title text exactly when provided", () => {
    renderEC(<EmptyContent title="No datasets yet" />);
    expect(screen.getByText("No datasets yet")).toBeInTheDocument();
  });

  it("renders the description text exactly when provided", () => {
    renderEC(
      <EmptyContent title="No traces" description="Send data to see traces." />,
    );
    expect(screen.getByText("Send data to see traces.")).toBeInTheDocument();
  });

  it("omits title and description nodes when neither prop is passed", () => {
    renderEC(<EmptyContent />);
    expect(screen.queryByText("No datasets yet")).toBeNull();
    expect(screen.queryByText("Send data to see traces.")).toBeNull();
  });

  it("renders a supplied action node", () => {
    renderEC(
      <EmptyContent
        title="No datasets"
        action={<button type="button">Create dataset</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Create dataset" }),
    ).toBeInTheDocument();
  });

  it("has no a11y violations in the image-only default state", async () => {
    const { container } = renderEC(<EmptyContent />);
    await expectNoA11yViolations(container);
  });

  it("has no a11y violations with title, description and an action", async () => {
    const { container } = renderEC(
      <EmptyContent
        title="No datasets"
        description="Create your first dataset to get started."
        action={<button type="button">Create dataset</button>}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
