import "server-only";

import { getAdminDataClient } from "./admin-client";

/**
 * The service-role side of `features/oauth-grants` — `list_current_user_oauth_grants`
 * and `revoke_current_user_oauth_grant` (`68-oauth-grants.sql`) take the
 * target user id as a parameter rather than reading `auth.uid()` internally,
 * so only the service-role client can execute them
 * (`96-function-execution-grants.sql`). Every caller here MUST resolve the
 * user id server-side from the authenticated session (`loadPreTenantActor`/
 * `preTenantAction`'s actor) — never from request input — since that id is
 * the only thing scoping either RPC to the caller's own grants.
 */

export interface OAuthGrantRow {
  session_id: string;
  client_id: string;
  client_name: string | null;
  scopes: string | null;
  created_at: string;
  refreshed_at: string | null;
}

export async function listOAuthGrantsForUser(userId: string): Promise<OAuthGrantRow[]> {
  const { data, error } = await getAdminDataClient().rpc("list_current_user_oauth_grants", {
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`list_current_user_oauth_grants failed: ${error.message}`);
  }
  return (data ?? []) as OAuthGrantRow[];
}

/** Returns `true` iff a session was actually deleted — `false` covers both
 * "already gone" and "not this user's own grant" (the RPC scopes the
 * delete to the given user id, so those two cases are indistinguishable by
 * design and both fail closed). */
export async function revokeOAuthGrantForUser(userId: string, sessionId: string): Promise<boolean> {
  const { data, error } = await getAdminDataClient().rpc("revoke_current_user_oauth_grant", {
    p_user_id: userId,
    target_session_id: sessionId,
  });
  if (error) {
    throw new Error(`revoke_current_user_oauth_grant failed: ${error.message}`);
  }
  return data === true;
}
