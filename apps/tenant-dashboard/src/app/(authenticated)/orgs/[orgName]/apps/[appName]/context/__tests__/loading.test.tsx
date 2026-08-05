// @vitest-environment jsdom
/**
 * Context loading surface.
 *
 * The whole context tree is read on the server before first paint, so what
 * stands in while it resolves is this segment's fallback. Without one the
 * nearest boundary is the app-tab fallback, whose content is a page-sized
 * spinner — it says nothing about what is arriving and reflows the page
 * wholesale once it does.
 */
import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

import ContextLoading from "../loading";

describe("context — segment fallback", () => {
  function renderLoading() {
    return render(
      <ThemeProvider theme={createTheme()}>
        <ContextLoading />
      </ThemeProvider>,
    );
  }

  it("stands in with the two-pane shape, not a page-sized spinner", () => {
    renderLoading();

    const skeleton = screen.getByTestId("page-skeleton");
    // The destination is a fixed rail beside a flex editor pane; a generic
    // stack of bars would reflow both panes once the tree lands.
    expect(skeleton).toHaveAttribute("data-variant", "two-pane");
    expect(screen.getByTestId("page-skeleton-rail")).toBeInTheDocument();
    // A spinner is reserved for auth and boot, where no destination shape is
    // known. Here it is known, so a spinner would be a regression.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    // Announced while it stands in rather than a silent blank region.
    expect(skeleton).toHaveTextContent("Loading");
  });

  it("reserves the header itself instead of letting the skeleton stack a second one", () => {
    renderLoading();

    // The real page header carries a resync control and a view toggle on its
    // trailing edge, which the skeleton's generic header block does not model —
    // so this file reserves the header and the skeleton must not add its own.
    expect(screen.queryByTestId("page-skeleton-header")).not.toBeInTheDocument();
    expect(screen.getByTestId("page-skeleton-rail")).toBeInTheDocument();
  });
});
