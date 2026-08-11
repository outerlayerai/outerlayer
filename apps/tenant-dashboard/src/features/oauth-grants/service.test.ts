import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedOAuthGrantsMswState } from "@/test-helpers/msw-handlers";

import { oauthGrantsService } from "./service";

describe("OAuthGrantsService.list", () => {
  it("maps RPC rows to OAuthGrant, splitting the space-delimited scopes string", async () => {
    seedOAuthGrantsMswState({
      grants: [
        {
          session_id: "session-1",
          client_id: "client-1",
          client_name: "Claude",
          scopes: "mcp:read mcp:tools",
          created_at: "2026-08-01T00:00:00Z",
          refreshed_at: "2026-08-02T00:00:00Z",
        },
      ],
    });

    const grants = await oauthGrantsService.list(createMswRestClient());

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
    seedOAuthGrantsMswState({
      grants: [
        {
          session_id: "session-1",
          client_id: "client-1",
          client_name: null,
          scopes: null,
          created_at: "2026-08-01T00:00:00Z",
          refreshed_at: null,
        },
      ],
    });

    const grants = await oauthGrantsService.list(createMswRestClient());

    expect(grants[0]?.scopes).toEqual([]);
    expect(grants[0]?.clientName).toBeNull();
  });

  it("returns an empty list when the caller has no connector grants", async () => {
    seedOAuthGrantsMswState({ grants: [] });

    const grants = await oauthGrantsService.list(createMswRestClient());

    expect(grants).toEqual([]);
  });
});

describe("OAuthGrantsService.revoke", () => {
  it("returns true and removes the grant when the session id matches the caller's own", async () => {
    seedOAuthGrantsMswState({
      grants: [
        {
          session_id: "session-1",
          client_id: "client-1",
          client_name: "Claude",
          scopes: "mcp:read",
          created_at: "2026-08-01T00:00:00Z",
          refreshed_at: null,
        },
      ],
    });
    const db = createMswRestClient();

    const revoked = await oauthGrantsService.revoke(db, "session-1");
    expect(revoked).toBe(true);

    // The RPC scopes the delete to auth.uid() server-side — pin that a
    // second revoke of the same id now reports false, since the row is gone.
    const revokedAgain = await oauthGrantsService.revoke(db, "session-1");
    expect(revokedAgain).toBe(false);
  });

  it("returns false for a session id that isn't the caller's own grant (fails closed, not an error)", async () => {
    seedOAuthGrantsMswState({
      grants: [
        {
          session_id: "session-1",
          client_id: "client-1",
          client_name: "Claude",
          scopes: "mcp:read",
          created_at: "2026-08-01T00:00:00Z",
          refreshed_at: null,
        },
      ],
      revocableSessionIds: [],
    });

    const revoked = await oauthGrantsService.revoke(createMswRestClient(), "session-1");
    expect(revoked).toBe(false);
  });
});
