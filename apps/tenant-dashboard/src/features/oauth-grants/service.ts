/**
 * OAuthGrantsService — connector grants over `auth.sessions`
 * (`oauth_client_id` joined to `auth.oauth_clients`), read/revoked through
 * the SECURITY DEFINER RPCs in `68-oauth-grants.sql`
 * (`list_current_user_oauth_grants`, `revoke_current_user_oauth_grant`).
 * Those RPCs scope to `auth.uid()` server-side, so this service — unlike
 * `api_key`'s RLS-scoped table reads — never needs a tenant: a connector
 * grant belongs to the user, not any one org.
 *
 * Revoking deletes the session row — the verified kill switch (refresh
 * dies immediately). It does NOT touch `auth.oauth_consents.revoked_at`;
 * that column does not stop refresh on Supabase's OAuth server, so writing
 * it here would be a UI control that looks like revocation but isn't one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OAuthGrant } from "./types";

interface OAuthGrantRow {
  session_id: string;
  client_id: string;
  client_name: string | null;
  scopes: string | null;
  created_at: string;
  refreshed_at: string | null;
}

class OAuthGrantsService {
  async list(db: SupabaseClient): Promise<OAuthGrant[]> {
    const { data, error } = await db.rpc("list_current_user_oauth_grants");
    if (error) {
      throw new Error(`list_current_user_oauth_grants failed: ${error.message}`);
    }
    return ((data ?? []) as OAuthGrantRow[]).map((row) => ({
      sessionId: row.session_id,
      clientId: row.client_id,
      clientName: row.client_name,
      scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : [],
      createdAt: row.created_at,
      refreshedAt: row.refreshed_at,
    }));
  }

  /** Returns `true` iff a session was actually deleted — `false` covers
   * both "already gone" and "not the caller's own grant" (the RPC scopes
   * the delete to `auth.uid()`, so those two cases are indistinguishable
   * by design and both fail closed). */
  async revoke(db: SupabaseClient, sessionId: string): Promise<boolean> {
    const { data, error } = await db.rpc("revoke_current_user_oauth_grant", {
      target_session_id: sessionId,
    });
    if (error) {
      throw new Error(`revoke_current_user_oauth_grant failed: ${error.message}`);
    }
    return data === true;
  }
}

export const oauthGrantsService = new OAuthGrantsService();
