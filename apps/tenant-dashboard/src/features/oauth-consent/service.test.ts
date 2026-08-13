/**
 * `oauthConsentService` calls Supabase Auth's `/auth/v1/oauth/*` REST
 * endpoints directly (supabase-js has no typed wrapper for them), so these
 * tests stub `global.fetch` rather than going through the shared MSW
 * Supabase handlers, which model PostgREST (`/rest/v1/*`) traffic only.
 *
 * The response bodies below are transcribed from a live GoTrue instance with
 * `[auth.oauth_server]` enabled — including the two details a
 * documentation-shaped guess gets wrong, and which a stub can silently keep
 * wrong forever: the client's display name arrives as `client.name`, and the
 * decision POST goes to `…/authorizations/{id}/consent` (the bind URL itself
 * is GET-only and 405s a POST).
 */

import { oauthConsentService } from "./service";

const SUPABASE_URL = "http://localhost:54321";

function stubFetchOnce(response: { status: number; body: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(response.body), { status: response.status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuthConsentService.bindAuthorization", () => {
  it("reads the client display name from client.name", async () => {
    // Verbatim live pending-bind shape.
    stubFetchOnce({
      status: 200,
      body: {
        authorization_id: "auth-1",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        client: { id: "353d3dcb-a8dd-496c-92ba-2fd7551cf892", name: "Claude" },
        user: { id: "74b99666-96cc-4a3d-93ff-11ecc1484b3b", email: "user@example.com" },
        scope: "openid email offline_access",
      },
    });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    // `redirect_uri` on a pending bind is the connector's registered uri, NOT
    // an approval outcome — reading it as one would auto-approve every
    // first-time connect without ever showing the user a consent screen.
    // The response's `scope` is deliberately dropped: Supabase does not
    // enforce it, so parsing it into the result would let the consent view
    // display a scope-shaped promise nothing backs.
    expect(result).toEqual({
      status: "pending",
      authorizationId: "auth-1",
      clientName: "Claude",
      resource: null,
      redirectHost: "claude.ai",
    });
  });

  it("returns auto-approved with the redirect url on a repeat connect", async () => {
    stubFetchOnce({ status: 200, body: { redirect_url: "https://connector.example.com/callback?code=abc" } });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result).toEqual({
      status: "auto-approved",
      redirectUrl: "https://connector.example.com/callback?code=abc",
    });
  });

  it("falls back to a placeholder client name when the response carries none", async () => {
    stubFetchOnce({ status: 200, body: { scope: "" } });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result).toEqual({
      status: "pending",
      authorizationId: "auth-1",
      clientName: "Unnamed connector",
      resource: null,
      redirectHost: null,
    });
  });

  it("forwards the access token as a bearer header and hits the authorization-id URL", async () => {
    const fetchMock = stubFetchOnce({ status: 200, body: { scope: "" } });

    await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPABASE_URL}/auth/v1/oauth/authorizations/auth-1`,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer token-1" },
      }),
    );
  });

  it("throws on a non-ok response", async () => {
    stubFetchOnce({ status: 404, body: { message: "not found" } });

    await expect(
      oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1"),
    ).rejects.toThrow(/404/);
  });

  it("treats a non-string redirect_url as absent — stays pending rather than auto-approving", async () => {
    stubFetchOnce({ status: 200, body: { redirect_url: 12345, scope: "" } });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result.status).toBe("pending");
  });

  it("ignores a non-string client_name on the nested client object, falling through to the top-level or the placeholder", async () => {
    stubFetchOnce({ status: 200, body: { client: { client_name: 42 }, scope: "" } });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result.status === "pending" && result.clientName).toBe("Unnamed connector");
  });

  it("falls through an empty nested client_name to the top-level client_name field", async () => {
    stubFetchOnce({ status: 200, body: { client: { client_name: "" }, client_name: "Top-Level Name", scope: "" } });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result.status === "pending" && result.clientName).toBe("Top-Level Name");
  });

  it("ignores a non-string top-level client_name too, falling through to the placeholder", async () => {
    stubFetchOnce({ status: 200, body: { client_name: 42, scope: "" } });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result.status === "pending" && result.clientName).toBe("Unnamed connector");
  });

  // A client can name itself anything ("Claude"), so the display name alone
  // lets a lookalike impersonate a trusted connector — redirectHost is the
  // part a spoofed name can't fake, so these pin its extraction directly.
  describe("redirectHost extraction", () => {
    it("extracts the bare hostname from a standard https redirect_uri", async () => {
      stubFetchOnce({ status: 200, body: { redirect_uri: "https://evil.example/callback", scope: "" } });

      const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

      expect(result.status === "pending" && result.redirectHost).toBe("evil.example");
    });

    it("keeps a non-default port in the displayed host", async () => {
      stubFetchOnce({ status: 200, body: { redirect_uri: "http://localhost:4173/callback", scope: "" } });

      const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

      expect(result.status === "pending" && result.redirectHost).toBe("localhost:4173");
    });

    it("keeps an IP-literal host as-is, without resolving or rewriting it", async () => {
      stubFetchOnce({ status: 200, body: { redirect_uri: "http://203.0.113.5:8080/callback", scope: "" } });

      const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

      expect(result.status === "pending" && result.redirectHost).toBe("203.0.113.5:8080");
    });

    it("omits the host for a redirect_uri that doesn't parse as a URL, rather than crashing", async () => {
      stubFetchOnce({ status: 200, body: { redirect_uri: "not-a-url", scope: "" } });

      const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

      expect(result.status).toBe("pending");
      expect(result.status === "pending" && result.redirectHost).toBeNull();
    });

    it("returns a null host when the server doesn't echo redirect_uri at all", async () => {
      stubFetchOnce({ status: 200, body: { scope: "" } });

      const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

      expect(result.status === "pending" && result.redirectHost).toBeNull();
    });
  });
});

describe("OAuthConsentService.submitConsent", () => {
  it("POSTs the decision and returns the redirect url", async () => {
    const fetchMock = stubFetchOnce({
      status: 200,
      body: { redirect_url: "https://connector.example.com/callback?code=xyz" },
    });

    const result = await oauthConsentService.submitConsent(SUPABASE_URL, "token-1", "auth-1", "approve");

    expect(result).toEqual({ redirectUrl: "https://connector.example.com/callback?code=xyz" });
    // The `/consent` suffix is load-bearing: the bare authorization URL
    // answers `Allow: GET` and 405s this POST.
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPABASE_URL}/auth/v1/oauth/authorizations/auth-1/consent`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
    );
  });

  it("treats a denial as a successful call and returns its error-carrying redirect", async () => {
    // Live deny response: 200 with an access_denied redirect, not an HTTP error.
    stubFetchOnce({
      status: 200,
      body: {
        redirect_url:
          "https://claude.ai/api/mcp/auth_callback?error=access_denied&error_description=User+denied+the+request&state=s4",
      },
    });

    const result = await oauthConsentService.submitConsent(SUPABASE_URL, "token-1", "auth-1", "deny");

    expect(result).toEqual({
      redirectUrl:
        "https://claude.ai/api/mcp/auth_callback?error=access_denied&error_description=User+denied+the+request&state=s4",
    });
  });

  it("throws when the response carries no redirect_url", async () => {
    stubFetchOnce({ status: 200, body: {} });

    await expect(
      oauthConsentService.submitConsent(SUPABASE_URL, "token-1", "auth-1", "deny"),
    ).rejects.toThrow(/redirect_url/);
  });

  it("throws on a non-ok response", async () => {
    stubFetchOnce({ status: 500, body: { message: "server error" } });

    await expect(
      oauthConsentService.submitConsent(SUPABASE_URL, "token-1", "auth-1", "approve"),
    ).rejects.toThrow(/500/);
  });

  it("treats a non-string redirect_url as absent and throws", async () => {
    stubFetchOnce({ status: 200, body: { redirect_url: 12345 } });

    await expect(
      oauthConsentService.submitConsent(SUPABASE_URL, "token-1", "auth-1", "approve"),
    ).rejects.toThrow(/redirect_url/);
  });
});
