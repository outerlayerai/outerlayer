/**
 * Shared between `openapi/routes/oauth.ts` (serves the metadata) and
 * `openapi/middleware.ts` (points the MCP 401 challenge at it) — kept in
 * one place so the served path and the advertised path can never drift.
 */

/** RFC 9728 protected-resource metadata path. */
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

export function buildOAuthProtectedResourceMetadataUrl(origin: string): string {
  return `${origin}${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`;
}
