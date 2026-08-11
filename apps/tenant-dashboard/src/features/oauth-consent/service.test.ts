/**
 * `oauthConsentService` calls Supabase Auth's `/auth/v1/oauth/*` REST
 * endpoints directly (supabase-js has no typed wrapper for them), so these
 * tests stub `global.fetch` rather than going through the shared MSW
 * Supabase handlers, which model PostgREST (`/rest/v1/*`) traffic only.
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
  it("returns a pending authorization with parsed client name and space-delimited scopes", async () => {
    stubFetchOnce({
      status: 200,
      body: { client: { client_name: "Claude" }, scope: "mcp:read mcp:tools", resource: "https://api.example.com/v1/apps/app-1/mcp" },
    });

    const result = await oauthConsentService.bindAuthorization(SUPABASE_URL, "token-1", "auth-1");

    expect(result).toEqual({
      status: "pending",
      authorizationId: "auth-1",
      clientName: "Claude",
      scopes: ["mcp:read", "mcp:tools"],
      resource: "https://api.example.com/v1/apps/app-1/mcp",
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
      scopes: [],
      resource: null,
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
});

describe("OAuthConsentService.submitConsent", () => {
  it("POSTs the decision and returns the redirect url", async () => {
    const fetchMock = stubFetchOnce({
      status: 200,
      body: { redirect_url: "https://connector.example.com/callback?code=xyz" },
    });

    const result = await oauthConsentService.submitConsent(SUPABASE_URL, "token-1", "auth-1", "approve");

    expect(result).toEqual({ redirectUrl: "https://connector.example.com/callback?code=xyz" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${SUPABASE_URL}/auth/v1/oauth/authorizations/auth-1`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
    );
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
});
