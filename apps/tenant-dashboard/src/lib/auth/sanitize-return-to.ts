/**
 * Sanitize a `return_to` URL search param to a safe relative path.
 *
 * Used by the auth login flow to honor a post-login redirect destination
 * carried through OAuth (`/auth/login?return_to=...` →
 * `signInWithOAuth({ redirectTo: '/auth/callback?return_to=...' })` →
 * `/auth/callback` re-deposits the user at `return_to` after exchanging
 * the OAuth code for a session).
 *
 * The threat model: an attacker emails a victim a URL like
 * `https://app.agentmark.co/auth/login?return_to=//evil.example.com/`
 * hoping to bounce the victim through a successful login then off-site.
 * This sanitizer blocks every off-site or scheme-relative form so the
 * post-login redirect can only land on the dashboard itself.
 *
 * Allowed:  `/orgs/foo`, `/auth/github/callback?installation_id=…&state=…`
 * Blocked:  `https://evil.com`, `//evil.com`, `/\evil.com`, `/@user`,
 *           strings with control bytes or null bytes
 *
 * Returns the cleaned string when safe, `null` when not. Callers should
 * substitute their default destination (typically `/orgs`) on null.
 */
export function sanitizeReturnTo(input: string | null | undefined): string | null {
  if (!input) return null;
  // Strip control characters and null bytes that some parsers/browsers
  // interpret in ways that bypass the prefix checks below.
  const stripped = input.replace(/[\x00-\x1f\x7f]/g, "");
  if (!stripped.startsWith("/")) return null;
  // `//evil.com` and `/\evil.com` parse as protocol-relative URLs in
  // browsers and would send the user off-site.
  if (stripped.startsWith("//") || stripped.startsWith("/\\")) return null;
  // Catch other weird prefixes like `/@user` or `/:foo` that some
  // browsers resolve as absolute. The character class permits only
  // word chars, `-`, or `/` immediately after the leading slash, which
  // covers every legitimate route on the dashboard.
  if (/^\/[^\w\-/]/.test(stripped)) return null;
  return stripped;
}

/**
 * Resolve the `next` param of `/auth/confirm` to a safe same-site path.
 *
 * `next` arrives in two shapes:
 * - a relative path baked into an email template (e.g. `/auth/new-password`)
 * - a full URL from GoTrue's `{{ .RedirectTo }}` (the `emailRedirectTo`
 *   passed to `signUp`), e.g. `https://app.agentmark.co/auth/accept-invite?id=…`
 *
 * Full URLs are only honored when same-origin and are reduced to
 * path + query. Everything else falls through `sanitizeReturnTo`, so
 * off-site and scheme-relative values can never become a redirect target.
 *
 * `origins` takes every origin the deployment answers to (behind a proxy
 * the request URL's origin and the public `x-forwarded-host` origin can
 * differ — a full URL matching either is ours).
 *
 * Returns path + query (e.g. `/auth/accept-invite?id=abc`), or the
 * `fallback` (default `/`) when the value is missing or unsafe.
 */
export function resolveNextPath(
  input: string | null | undefined,
  origins: readonly string[],
  fallback = "/",
): string {
  if (!input) return fallback;
  let candidate = input;
  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return fallback;
    }
    if (!origins.includes(url.origin)) return fallback;
    candidate = url.pathname + url.search;
  }
  return sanitizeReturnTo(candidate) ?? fallback;
}

/**
 * Every origin a request legitimately belongs to: the request URL's own
 * origin plus, behind the reverse proxy, the public origin reconstructed
 * from `x-forwarded-host`. Feeds the `origins` allow-list of
 * `resolveNextPath`.
 */
export function requestAllowedOrigins(
  requestOrigin: string,
  forwardedHost: string | null,
): string[] {
  return forwardedHost ? [requestOrigin, `https://${forwardedHost}`] : [requestOrigin];
}
