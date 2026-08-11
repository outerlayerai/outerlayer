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
    }
  | { status: "auto-approved"; redirectUrl: string };

export type ConsentDecision = "approve" | "deny";

export interface SubmitConsentResult {
  redirectUrl: string;
}
