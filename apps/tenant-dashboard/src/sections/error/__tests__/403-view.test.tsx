// @vitest-environment jsdom
/**
 * ForbiddenView (403) rendering.
 *
 * The page hero is a bordered-flat line glyph, not a raster illustration. This
 * pins that: the page renders its heading and a glyph, and no <img> element
 * appears anywhere in the tree.
 */
import React from "react";
import { render } from "@testing-library/react";

vi.mock("@/components/iconify", () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) => <span data-testid="glyph" data-icon={icon} />,
}));

import ForbiddenView from "../403-view";

describe("ForbiddenView", () => {
  it("renders the heading and a line glyph, with no <img> to a deleted asset", () => {
    const { getByText, getByTestId, container } = render(<ForbiddenView />);

    expect(getByText("systemPages.forbidden.title")).toBeInTheDocument();
    expect(getByTestId("glyph").getAttribute("data-icon")).toBe("mdi:shield-lock-outline");
    expect(container.querySelector("img")).toBeNull();
  });
});
