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
