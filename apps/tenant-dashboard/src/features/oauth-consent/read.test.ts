/**
 * `loadOAuthConsent` — the read behind `/oauth/consent`. Resolves the
 * caller's own session and binds the authorization to it.
 */
const mockLoadPreTenantActorSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters")>()),
  loadPreTenantActorSession: mockLoadPreTenantActorSession,
}));

const mockBindAuthorization = vi.hoisted(() => vi.fn());
vi.mock("./service", () => ({
  oauthConsentService: { bindAuthorization: mockBindAuthorization },
}));

import { loadOAuthConsent } from "./read";

const ACTOR = { userId: "user-1", email: "user@example.com", raw: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadOAuthConsent", () => {
  it("returns unauthenticated and never calls bindAuthorization when there is no session", async () => {
    mockLoadPreTenantActorSession.mockResolvedValue(null);

    const result = await loadOAuthConsent("auth-1");

    expect(result).toEqual({ kind: "unauthenticated" });
    expect(mockBindAuthorization).not.toHaveBeenCalled();
  });

  it("binds the authorization using the session's own access token and the given authorizationId", async () => {
    mockLoadPreTenantActorSession.mockResolvedValue({ actor: ACTOR, accessToken: "token-xyz" });
    const authorization = {
      status: "pending" as const,
      authorizationId: "auth-1",
      clientName: "Claude",
      scopes: ["mcp:read"],
      resource: null,
    };
    mockBindAuthorization.mockResolvedValue(authorization);

    const result = await loadOAuthConsent("auth-1");

    expect(mockBindAuthorization).toHaveBeenCalledWith(expect.any(String), "token-xyz", "auth-1");
    expect(result).toEqual({ kind: "bound", authorization });
  });
});
