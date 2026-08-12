/**
 * OAuthGrantsService — connector grants over `auth.sessions`
 * (`oauth_client_id` joined to `auth.oauth_clients`), read/revoked through
 * the SECURITY DEFINER RPCs in `68-oauth-grants.sql`
 * (`list_current_user_oauth_grants`, `revoke_current_user_oauth_grant`),
 * called via the service-role admin client in `lib/system/oauth-grants.ts`
 * — those RPCs take the target user id as a parameter rather than reading
 * `auth.uid()` internally, so only the service-role client can execute
 * them; the caller's id must come from the authenticated session, never
 * request input. Unlike `api_key`'s RLS-scoped table reads, this service
 * never needs a tenant: a connector grant belongs to the user, not any one
 * org.
 *
 * Revoking deletes the session row — the verified kill switch (refresh
 * dies immediately). It does NOT touch `auth.oauth_consents.revoked_at`;
 * that column does not stop refresh on Supabase's OAuth server, so writing
 * it here would be a UI control that looks like revocation but isn't one.
 */

import { listOAuthGrantsForUser, revokeOAuthGrantForUser, type OAuthGrantRow } from "@/lib/system/oauth-grants";

import type { OAuthGrant } from "./types";

function toOAuthGrant(row: OAuthGrantRow): OAuthGrant {
  return {
    sessionId: row.session_id,
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : [],
    createdAt: row.created_at,
    refreshedAt: row.refreshed_at,
  };
}

class OAuthGrantsService {
  async list(userId: string): Promise<OAuthGrant[]> {
    const rows = await listOAuthGrantsForUser(userId);
    return rows.map(toOAuthGrant);
  }

  /** Returns `true` iff a session was actually deleted — `false` covers
   * both "already gone" and "not the caller's own grant" (the RPC scopes
   * the delete to the given user id, so those two cases are
   * indistinguishable by design and both fail closed). */
  async revoke(userId: string, sessionId: string): Promise<boolean> {
    return revokeOAuthGrantForUser(userId, sessionId);
  }
}

export const oauthGrantsService = new OAuthGrantsService();
