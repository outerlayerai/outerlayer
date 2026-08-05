// @vitest-environment jsdom
/**
 * SupabaseVerifyView rendering.
 *
 * The hero mark is a bordered-flat line glyph, not a raster asset. Pin that:
 * the page renders its heading and the email glyph, with no <img> element.
 */
import React from "react";
import { render } from "@testing-library/react";

vi.mock("@/components/iconify", () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import SupabaseVerifyView from "./verify-view";

describe("SupabaseVerifyView", () => {
  it("renders the check-your-email heading and the email glyph, no <img>", () => {
    const { getByText, container } = render(<SupabaseVerifyView />);

    expect(getByText("Please check your email!")).toBeInTheDocument();
    expect(container.querySelector('[data-icon="mdi:email-outline"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
