import type { SupabaseClient } from "@supabase/supabase-js";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedOAuthGrantsMswState } from "@/test-helpers/msw-handlers";

import { oauthGrantsService } from "./service";

/** A minimal fake for the one `.rpc(...)` call each method makes, for
 * pinning the error-surfacing path — the MSW fixture models only success
 * responses. */
function dbWithRpcResult(result: { data: unknown; error: { message: string } | null }) {
  return { rpc: vi.fn().mockResolvedValue(result) } as unknown as SupabaseClient;
}

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

  it("throws a named error when the RPC reports one, instead of returning it as data", async () => {
    const db = dbWithRpcResult({ data: null, error: { message: "permission denied" } });

    await expect(oauthGrantsService.list(db)).rejects.toThrow(
      "list_current_user_oauth_grants failed: permission denied",
    );
  });

  it("filters out empty tokens left by collapsing whitespace in a scopes string, not just splitting it", async () => {
    seedOAuthGrantsMswState({
      grants: [
        {
          session_id: "session-1",
          client_id: "client-1",
          client_name: "Claude",
          scopes: "  mcp:read   mcp:tools  ",
          created_at: "2026-08-01T00:00:00Z",
          refreshed_at: null,
        },
      ],
    });

    const grants = await oauthGrantsService.list(createMswRestClient());

    expect(grants[0]?.scopes).toEqual(["mcp:read", "mcp:tools"]);
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

  it("throws a named error when the RPC reports one, instead of returning it as a revoked=false result", async () => {
    const db = dbWithRpcResult({ data: null, error: { message: "permission denied" } });

    await expect(oauthGrantsService.revoke(db, "session-1")).rejects.toThrow(
      "revoke_current_user_oauth_grant failed: permission denied",
    );
  });
});
