// @vitest-environment jsdom
/**
 * NotFoundView (404) rendering.
 *
 * The page hero is a bordered-flat line glyph, not a raster illustration.
 * This pins that: the page renders its heading and a glyph, and no <img>
 * element appears. The view self-gates on a mount effect
 * (SSR-skip for a hydration bug), so assertions wait for the mounted render.
 */
import React from "react";
import { render, waitFor } from "@testing-library/react";

vi.mock("@/components/iconify", () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) => <span data-testid="glyph" data-icon={icon} />,
}));

import NotFoundView from "../not-found-view";

describe("NotFoundView", () => {
  it("renders the heading and a line glyph, with no <img> to a deleted asset", async () => {
    const { getByText, getByTestId, container } = render(<NotFoundView />);

    await waitFor(() => expect(getByText("systemPages.notFound.title")).toBeInTheDocument());
    expect(getByTestId("glyph").getAttribute("data-icon")).toBe("eva:question-mark-circle-outline");
    expect(container.querySelector("img")).toBeNull();
  });
});
