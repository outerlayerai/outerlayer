// @vitest-environment jsdom
/**
 * IconTile rendering contract.
 *
 * IconTile renders the hero marks on the auth and error pages. It must render
 * the requested line glyph, scale the
 * glyph to half the tile size, and stay decorative (aria-hidden) so the page
 * heading remains the accessible label.
 */
import React from "react";
import { render } from "@testing-library/react";

// The global setup mocks `@/components/iconify` to render nothing; override it
// here so the glyph name and width it receives are observable.
vi.mock("@/components/iconify", () => ({
  __esModule: true,
  default: ({ icon, width }: { icon: string; width?: number }) => (
    <span data-testid="glyph" data-icon={icon} data-width={String(width)} />
  ),
}));

import IconTile from "../icon-tile";

describe("IconTile", () => {
  it("renders the requested glyph at half the default tile size, decorative", () => {
    const { container, getByTestId } = render(<IconTile icon="mdi:lock-outline" />);

    const glyph = getByTestId("glyph");
    expect(glyph.getAttribute("data-icon")).toBe("mdi:lock-outline");
    // default size 96 → glyph width 48
    expect(glyph.getAttribute("data-width")).toBe("48");

    // The tile is decorative; the surrounding heading carries the meaning.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("scales the glyph to half the given size", () => {
    const { getByTestId } = render(<IconTile icon="eva:question-mark-circle-outline" size={120} />);

    const glyph = getByTestId("glyph");
    expect(glyph.getAttribute("data-icon")).toBe("eva:question-mark-circle-outline");
    // size 120 → glyph width 60
    expect(glyph.getAttribute("data-width")).toBe("60");
  });
});
