/**
 * Client for Supabase Auth's OAuth 2.1 server consent endpoints
 * (`/auth/v1/oauth/authorizations/{id}`). `supabase-js` has no typed
 * wrapper for these — they're plain REST, called with the signed-in
 * user's own access token, never the service role.
 *
 * Response field names below (`client_name`, `scope`, `resource`,
 * `redirect_url`) follow the OAuth 2.1 / RFC 8707 conventions Supabase's
 * server is documented against. They have not been exercised against a
 * live instance with `[auth.oauth_server]` enabled in this environment —
 * treat as best-effort pending the pre-ship manual verification spec §5.4
 * calls for (a real connector over a tunnel).
 */

import type { BoundAuthorization, ConsentDecision, SubmitConsentResult } from "./types";

function authorizationUrl(supabaseApiBaseUrl: string, authorizationId: string): string {
  return `${supabaseApiBaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
}

class OAuthConsentService {
  /**
   * Binds the pending authorization to the signed-in user. On a repeat
   * connect for a client the user already approved, this call itself
   * auto-approves and the response carries a redirect URL — no consent
   * POST follows in that case.
   */
  async bindAuthorization(
    supabaseApiBaseUrl: string,
    accessToken: string,
    authorizationId: string,
  ): Promise<BoundAuthorization> {
    const response = await fetch(authorizationUrl(supabaseApiBaseUrl, authorizationId), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to bind OAuth authorization (${response.status})`);
    }
    const body = (await response.json()) as Record<string, unknown>;

    const redirectUrl = typeof body.redirect_url === "string" ? body.redirect_url : null;
    if (redirectUrl) {
      return { status: "auto-approved", redirectUrl };
    }

    const client = body.client as Record<string, unknown> | undefined;
    const clientName =
      (typeof client?.client_name === "string" && client.client_name) ||
      (typeof body.client_name === "string" && body.client_name) ||
      "Unnamed connector";
    const scopeString =
      (typeof body.scope === "string" && body.scope) ||
      (typeof body.scopes === "string" && body.scopes) ||
      "";
    const resource = typeof body.resource === "string" ? body.resource : null;

    return {
      status: "pending",
      authorizationId,
      clientName,
      scopes: scopeString.split(/\s+/).filter(Boolean),
      resource,
    };
  }

  /** Submits the user's approve/deny decision for a bound authorization. */
  async submitConsent(
    supabaseApiBaseUrl: string,
    accessToken: string,
    authorizationId: string,
    decision: ConsentDecision,
  ): Promise<SubmitConsentResult> {
    const response = await fetch(authorizationUrl(supabaseApiBaseUrl, authorizationId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: decision }),
    });
    if (!response.ok) {
      throw new Error(`Failed to submit OAuth consent decision (${response.status})`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const redirectUrl = typeof body.redirect_url === "string" ? body.redirect_url : null;
    if (!redirectUrl) {
      throw new Error("OAuth consent response carried no redirect_url");
    }
    return { redirectUrl };
  }
}

export const oauthConsentService = new OAuthConsentService();
