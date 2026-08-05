/**
 * Build the OAuth callback URL with an optional `return_to` query param.
 * The callback at `/auth/callback/route.ts` honors `return_to` in the
 * registration/login branch and redirects there after exchanging the
 * OAuth code for a session — completing the "click a deep link → log
 * in or sign up → land back on the original destination" flow (CLI
 * handoff, invite links, git-connect callbacks).
 *
 * Shared by the login and register pages so both OAuth entry points
 * thread the destination the same way. `returnTo` must already be
 * sanitized (see `sanitize-return-to.ts`).
 */
export function buildOAuthRedirectTarget(origin: string, returnTo: string | null): string {
  const url = new URL("/auth/callback", origin);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return url.toString();
}
