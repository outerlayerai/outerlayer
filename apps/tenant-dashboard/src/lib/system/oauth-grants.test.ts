/**
 * `listOAuthGrantsForUser` / `revokeOAuthGrantForUser` — the service-role
 * side of `features/oauth-grants`. The RPCs behind them
 * (`list_current_user_oauth_grants` / `revoke_current_user_oauth_grant`,
 * `68-oauth-grants.sql`) take the target user id as a parameter rather than
 * reading `auth.uid()` internally, so only the service-role client can
 * execute them (`96-function-execution-grants.sql`) — these pin that both
 * functions call through `getAdminDataClient()` with the given userId as
 * `p_user_id`, never anything read off the RPC response or ambient state.
 */
const mockRpc = vi.hoisted(() => vi.fn());
const mockGetAdminDataClient = vi.hoisted(() => vi.fn(() => ({ rpc: mockRpc })));
vi.mock("./admin-client", () => ({
  getAdminDataClient: mockGetAdminDataClient,
}));

import { listOAuthGrantsForUser, revokeOAuthGrantForUser } from "./oauth-grants";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listOAuthGrantsForUser", () => {
  it("calls list_current_user_oauth_grants via the admin client with the given userId as p_user_id", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listOAuthGrantsForUser("user-1");

    // mockRpc is the object mockGetAdminDataClient() returns, so a call
    // reaching it already proves the admin client was constructed and used.
    expect(mockRpc).toHaveBeenCalledWith("list_current_user_oauth_grants", { p_user_id: "user-1" });
  });

  it("returns the RPC rows unchanged", async () => {
    const rows = [
      {
        session_id: "session-1",
        client_id: "client-1",
        client_name: "Claude",
        scopes: "mcp:read",
        created_at: "2026-08-01T00:00:00Z",
        refreshed_at: null,
      },
    ];
    mockRpc.mockResolvedValue({ data: rows, error: null });

    const result = await listOAuthGrantsForUser("user-1");

    expect(result).toEqual(rows);
  });

  it("returns an empty array when the RPC reports null data", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    expect(await listOAuthGrantsForUser("user-1")).toEqual([]);
  });

  it("throws a named error when the RPC reports one, instead of returning it as data", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    await expect(listOAuthGrantsForUser("user-1")).rejects.toThrow(
      "list_current_user_oauth_grants failed: permission denied",
    );
  });
});

describe("revokeOAuthGrantForUser", () => {
  it("calls revoke_current_user_oauth_grant via the admin client with the given userId as p_user_id and the sessionId as target_session_id", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    await revokeOAuthGrantForUser("user-1", "session-1");

    // mockRpc is the object mockGetAdminDataClient() returns, so a call
    // reaching it already proves the admin client was constructed and used.
    expect(mockRpc).toHaveBeenCalledWith("revoke_current_user_oauth_grant", {
      p_user_id: "user-1",
      target_session_id: "session-1",
    });
  });

  it("returns true when a row was deleted", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    expect(await revokeOAuthGrantForUser("user-1", "session-1")).toBe(true);
  });

  it("returns false when the RPC reports no matching row (not this user's grant, or already gone)", async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    expect(await revokeOAuthGrantForUser("user-1", "session-1")).toBe(false);
  });

  it("throws a named error when the RPC reports one, instead of returning it as a revoked=false result", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    await expect(revokeOAuthGrantForUser("user-1", "session-1")).rejects.toThrow(
      "revoke_current_user_oauth_grant failed: permission denied",
    );
  });
});
