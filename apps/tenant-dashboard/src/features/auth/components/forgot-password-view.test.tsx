// @vitest-environment jsdom
/**
 * SupabaseForgotPasswordView rendering.
 *
 * The hero mark is a bordered-flat line glyph, not a raster asset. Pin that:
 * the page renders its heading and the lock glyph, with no <img> element.
 */
import React from "react";
import { render } from "@testing-library/react";

vi.mock("@/components/iconify", () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import SupabaseForgotPasswordView from "./forgot-password-view";

describe("SupabaseForgotPasswordView", () => {
  it("renders the heading and the lock glyph, no <img>", () => {
    const { getByText, container } = render(<SupabaseForgotPasswordView />);

    expect(getByText("auth.forgotPassword.title")).toBeInTheDocument();
    expect(container.querySelector('[data-icon="mdi:lock-outline"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
