/**
 * `OAuthGrantsService` — the row→OAuthGrant mapping over
 * `lib/system/oauth-grants.ts`'s admin-client RPC calls. The RPC call
 * itself (admin client, `p_user_id` binding, error surfacing) is pinned in
 * `lib/system/oauth-grants.test.ts`; this suite only pins the mapping.
 */
const mockListOAuthGrantsForUser = vi.hoisted(() => vi.fn());
const mockRevokeOAuthGrantForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/system/oauth-grants", () => ({
  listOAuthGrantsForUser: mockListOAuthGrantsForUser,
  revokeOAuthGrantForUser: mockRevokeOAuthGrantForUser,
}));

import { oauthGrantsService } from "./service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OAuthGrantsService.list", () => {
  it("passes the userId straight through to listOAuthGrantsForUser", async () => {
    mockListOAuthGrantsForUser.mockResolvedValue([]);

    await oauthGrantsService.list("user-1");

    expect(mockListOAuthGrantsForUser).toHaveBeenCalledWith("user-1");
  });

  it("maps RPC rows to OAuthGrant, splitting the space-delimited scopes string", async () => {
    mockListOAuthGrantsForUser.mockResolvedValue([
      {
        session_id: "session-1",
        client_id: "client-1",
        client_name: "Claude",
        scopes: "mcp:read mcp:tools",
        created_at: "2026-08-01T00:00:00Z",
        refreshed_at: "2026-08-02T00:00:00Z",
      },
    ]);

    const grants = await oauthGrantsService.list("user-1");

    expect(grants).toEqual([
      {
        sessionId: "session-1",
        clientId: "client-1",
        clientName: "Claude",
        scopes: ["mcp:read", "mcp:tools"],
        createdAt: "2026-08-01T00:00:00Z",
        refreshedAt: "2026-08-02T00:00:00Z",
      },
    ]);
  });

  it("returns an empty scopes array for a null scopes column", async () => {
    mockListOAuthGrantsForUser.mockResolvedValue([
      {
        session_id: "session-1",
        client_id: "client-1",
        client_name: null,
        scopes: null,
        created_at: "2026-08-01T00:00:00Z",
        refreshed_at: null,
      },
    ]);

    const grants = await oauthGrantsService.list("user-1");

    expect(grants[0]?.scopes).toEqual([]);
    expect(grants[0]?.clientName).toBeNull();
  });

  it("returns an empty list when the caller has no connector grants", async () => {
    mockListOAuthGrantsForUser.mockResolvedValue([]);

    const grants = await oauthGrantsService.list("user-1");

    expect(grants).toEqual([]);
  });

  it("filters out empty tokens left by collapsing whitespace in a scopes string, not just splitting it", async () => {
    mockListOAuthGrantsForUser.mockResolvedValue([
      {
        session_id: "session-1",
        client_id: "client-1",
        client_name: "Claude",
        scopes: "  mcp:read   mcp:tools  ",
        created_at: "2026-08-01T00:00:00Z",
        refreshed_at: null,
      },
    ]);

    const grants = await oauthGrantsService.list("user-1");

    expect(grants[0]?.scopes).toEqual(["mcp:read", "mcp:tools"]);
  });

  it("propagates a thrown error from listOAuthGrantsForUser unchanged", async () => {
    mockListOAuthGrantsForUser.mockRejectedValue(new Error("list_current_user_oauth_grants failed: permission denied"));

    await expect(oauthGrantsService.list("user-1")).rejects.toThrow(
      "list_current_user_oauth_grants failed: permission denied",
    );
  });
});

describe("OAuthGrantsService.revoke", () => {
  it("passes the userId and sessionId straight through to revokeOAuthGrantForUser", async () => {
    mockRevokeOAuthGrantForUser.mockResolvedValue(true);

    const revoked = await oauthGrantsService.revoke("user-1", "session-1");

    expect(mockRevokeOAuthGrantForUser).toHaveBeenCalledWith("user-1", "session-1");
    expect(revoked).toBe(true);
  });

  it("returns false unchanged when the grant wasn't the caller's own", async () => {
    mockRevokeOAuthGrantForUser.mockResolvedValue(false);

    const revoked = await oauthGrantsService.revoke("user-1", "session-1");

    expect(revoked).toBe(false);
  });

  it("propagates a thrown error from revokeOAuthGrantForUser unchanged", async () => {
    mockRevokeOAuthGrantForUser.mockRejectedValue(
      new Error("revoke_current_user_oauth_grant failed: permission denied"),
    );

    await expect(oauthGrantsService.revoke("user-1", "session-1")).rejects.toThrow(
      "revoke_current_user_oauth_grant failed: permission denied",
    );
  });
});
