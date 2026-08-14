/**
 * Client for Supabase Auth's OAuth 2.1 server consent endpoints.
 * `supabase-js` has no typed wrapper for these — they're plain REST, called
 * with the signed-in user's own access token, never the service role.
 *
 * The two endpoints are NOT the same URL with different verbs: binding is
 * `GET /auth/v1/oauth/authorizations/{id}` and the decision is
 * `POST …/authorizations/{id}/consent`. The bind URL answers `Allow: GET`
 * and 405s any POST, so collapsing them breaks consent outright.
 *
 * Field names, as the running server returns them:
 *   - pending  → `{ authorization_id, redirect_uri, client: { id, name },
 *                   user: { id, email }, scope }` — the client's display
 *                   name is `client.name`, and `redirect_uri` here is the
 *                   connector's REGISTERED uri, not a decision outcome.
 *   - approved → `{ redirect_url }` alone, on both the repeat-connect bind
 *                   and the consent POST. `redirect_url`'s presence is
 *                   therefore the auto-approve signal; `redirect_uri`'s is not.
 *
 * `scope` is part of the protocol response but is never parsed into
 * `BoundAuthorization` — Supabase's OAuth server does not enforce OAuth
 * scopes (every connector token is a full-power `authenticated` session,
 * confined only by the gateway's own MCP-mount check and the database's
 * RLS), so displaying the requested scope as if it bounded the grant would
 * be inaccurate. The consent view instead states the fixed, actual grant.
 */

import type { BoundAuthorization, ConsentDecision, SubmitConsentResult } from "./types";

function authorizationUrl(supabaseApiBaseUrl: string, authorizationId: string): string {
  return `${supabaseApiBaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
}

/** `host` (hostname, plus `:port` for a non-default one) of a redirect_uri
 * the server echoed back — an IP-literal host is kept as-is (URL.host does
 * not resolve or rewrite it). Returns null for a missing or unparseable
 * value rather than throwing; the consent view treats null the same as
 * "not shown". */
function extractRedirectHost(redirectUri: string | null): string | null {
  if (!redirectUri) return null;
  try {
    return new URL(redirectUri).host || null;
  } catch {
    return null;
  }
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
      (typeof client?.name === "string" && client.name) ||
      (typeof client?.client_name === "string" && client.client_name) ||
      (typeof body.client_name === "string" && body.client_name) ||
      "Unnamed connector";
    const resource = typeof body.resource === "string" ? body.resource : null;
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : null;

    return {
      status: "pending",
      authorizationId,
      clientName,
      resource,
      redirectHost: extractRedirectHost(redirectUri),
    };
  }

  /**
   * Submits the user's approve/deny decision for a bound authorization.
   * A denial is a successful call, not an error: the server answers 200 with
   * a `redirect_url` carrying `error=access_denied` back to the connector.
   */
  async submitConsent(
    supabaseApiBaseUrl: string,
    accessToken: string,
    authorizationId: string,
    decision: ConsentDecision,
  ): Promise<SubmitConsentResult> {
    const response = await fetch(`${authorizationUrl(supabaseApiBaseUrl, authorizationId)}/consent`, {
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
