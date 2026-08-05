// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildOAuthRedirectTarget } from "../oauth-redirect";

describe("buildOAuthRedirectTarget", () => {
  it("appends return_to to the callback URL when a destination is set", () => {
    expect(
      buildOAuthRedirectTarget("https://app.agentmark.co", "/auth/accept-invite?id=abc-123"),
    ).toBe(
      "https://app.agentmark.co/auth/callback?return_to=%2Fauth%2Faccept-invite%3Fid%3Dabc-123",
    );
  });

  it("returns the bare callback URL when no destination is set", () => {
    expect(buildOAuthRedirectTarget("https://app.agentmark.co", null)).toBe(
      "https://app.agentmark.co/auth/callback",
    );
  });
});
