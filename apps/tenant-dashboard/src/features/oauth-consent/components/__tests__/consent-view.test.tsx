// @vitest-environment jsdom
/**
 * OAuthConsentView — a client can set its display name to anything, so the
 * consent screen must also show the connector's actual redirect host: a
 * lookalike connector named "Claude" pointing at an attacker-controlled
 * redirect_uri should be visibly wrong even though the name reads clean.
 */

import { render, screen } from "@testing-library/react";

vi.mock("@outerlayer/locales", () => ({
  useTranslate: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(",")}` : key,
  }),
}));

vi.mock("../../actions", () => ({
  decideOAuthConsentAction: vi.fn(),
}));

import { OAuthConsentView } from "../consent-view";

describe("OAuthConsentView", () => {
  it("renders the redirect host alongside the client name", () => {
    render(
      <OAuthConsentView
        authorizationId="auth-1"
        clientName="Claude"
        resource={null}
        redirectHost="evil.example"
      />,
    );

    expect(screen.getByText("auth.oauthConsent.redirectsTo:host=evil.example")).toBeInTheDocument();
  });

  it("omits the redirect-host row when no host was resolved", () => {
    render(
      <OAuthConsentView authorizationId="auth-1" clientName="Claude" resource={null} redirectHost={null} />,
    );

    expect(screen.queryByText(/redirectsTo/)).not.toBeInTheDocument();
  });
});
