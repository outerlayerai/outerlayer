/** The two shapes Supabase's OAuth server returns from
 * `GET /auth/v1/oauth/authorizations/{id}`: a pending authorization to
 * render consent UI for, or an already-decided one (repeat connect) that
 * auto-approves and hands back a redirect target with no consent step. */
export type BoundAuthorization =
  | {
      status: "pending";
      authorizationId: string;
      clientName: string;
      /** The RFC 8707 `resource` the connector requested, when present —
       * shown so the user can see which URL/app was asked for. The current
       * server does not echo it back on the bind response, so this is null
       * in practice and the consent view simply omits the row. Not an
       * enforcement point either way: the gateway derives the app from the
       * path or key at request time regardless of what's echoed here. */
      resource: string | null;
      /** `host` (hostname, plus `:port` when the redirect_uri carries a
       * non-default one) of the connector's registered `redirect_uri`,
       * rendered alongside `clientName` — a client can set its display name
       * to anything, so the name alone lets a lookalike connector impersonate
       * a trusted one. Null when the server didn't echo `redirect_uri`, or
       * echoed a value that doesn't parse as a URL; the consent view omits
       * the row rather than guessing. Not an enforcement point — the same
       * caveat as `resource` above. */
      redirectHost: string | null;
    }
  | { status: "auto-approved"; redirectUrl: string };

export type ConsentDecision = "approve" | "deny";

export interface SubmitConsentResult {
  redirectUrl: string;
}
