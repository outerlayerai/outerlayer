/**
 * Shared between `openapi/routes/oauth.ts` (serves the metadata) and
 * `openapi/middleware.ts` (points the MCP 401 challenge at it) — kept in
 * one place so the served path and the advertised path can never drift.
 */

/**
 * The request's effective origin behind a TLS-terminating reverse proxy.
 * `c.req.url`'s protocol reflects what this process saw on the wire, which
 * is `http:` whenever a proxy in front of it (a cloudflared tunnel today;
 * nginx/Caddy for a self-hoster) terminates TLS and forwards plain HTTP —
 * every self-referential URL this gateway serves would then advertise
 * itself over the wrong scheme, breaking any client that validates it
 * (an MCP client matching a protected-resource `resource` field against
 * the URL it actually connected to over https).
 *
 * Trusts `X-Forwarded-Proto`'s first comma-separated value for the SCHEME
 * only, when it is exactly `http` or `https` (case-insensitive, trimmed) —
 * anything else falls back to the request URL's own protocol. The host
 * always comes from the request URL; nothing in this gateway trusts
 * `X-Forwarded-Host` today, and a proto-only fix doesn't need to start —
 * a spoofed `X-Forwarded-Proto` can only flip a scheme string in a public,
 * unauthenticated metadata document, never redirect a client to a
 * different host.
 */
export function requestOrigin(req: { url: string; header(name: string): string | undefined }): string {
  const url = new URL(req.url);
  const forwardedProto = req.header('X-Forwarded-Proto')?.split(',')[0]?.trim().toLowerCase();
  const protocol =
    forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : url.protocol.replace(':', '');
  return `${protocol}://${url.host}`;
}

/** RFC 9728 protected-resource metadata path. */
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

export function buildOAuthProtectedResourceMetadataUrl(origin: string): string {
  return `${origin}${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`;
}

/**
 * RFC 9728 §3.1 path-insertion form for the per-app MCP mount
 * (`/v1/apps/{appId}/mcp`) — that mount's `resource` value differs from the
 * bare `/v1/mcp` mount's, so an audience-validating client needs a metadata
 * document at a distinct URL, not the same one both mounts point at.
 */
export function buildAppScopedOAuthProtectedResourceMetadataPath(appId: string): string {
  return `${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}/v1/apps/${appId}/mcp`;
}

export function buildAppScopedOAuthProtectedResourceMetadataUrl(origin: string, appId: string): string {
  return `${origin}${buildAppScopedOAuthProtectedResourceMetadataPath(appId)}`;
}
