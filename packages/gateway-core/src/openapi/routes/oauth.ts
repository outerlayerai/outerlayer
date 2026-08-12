/**
 * RFC 9728 OAuth protected-resource metadata.
 *
 * Supabase Auth serves the OAuth 2.1 authorization server (dynamic client
 * registration, authorize, token, JWKS) — it does not serve protected-
 * resource metadata, since that describes the RESOURCE (this gateway), not
 * the AS. This route fills that gap so an MCP client can discover, from a
 * single unauthenticated GET, which authorization server issues tokens
 * this gateway accepts.
 */

import { z, BaseRoute, type AppContext } from './_shared';
import { requestOrigin } from '../../lib/oauth-metadata';

const OAuthProtectedResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
});

export class GetOAuthProtectedResourceMetadata extends BaseRoute {
  schema = {
    tags: ['OAuth'],
    summary: 'OAuth protected-resource metadata',
    operationId: 'oauth-protected-resource-metadata',
    description:
      'RFC 9728 protected-resource metadata for the MCP endpoints. Points MCP ' +
      'clients at the Supabase-backed authorization server; unauthenticated.',
    security: [],
    responses: {
      200: {
        description: 'Protected-resource metadata.',
        content: {
          'application/json': {
            schema: OAuthProtectedResourceMetadataSchema,
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const origin = requestOrigin(c.req);
    return c.json(
      {
        resource: `${origin}/v1/mcp`,
        authorization_servers: [c.env.SUPABASE_API_BASE_URL],
      },
      200,
    );
  }
}

/**
 * RFC 9728 §3.1 path-insertion form for the per-app MCP mount
 * (`/v1/apps/{appId}/mcp`) — a spec-conformant client validating the
 * resource audience needs a metadata document whose `resource` matches THIS
 * mount, not the bare `/v1/mcp` one {@link GetOAuthProtectedResourceMetadata}
 * serves. Discovery is unauthenticated and precedes any DB lookup, so the
 * `appId` segment is echoed straight through — never checked against the
 * apps table — the same way the mount's own auth middleware treats it as an
 * opaque path segment before authentication resolves the real app.
 */
export class GetAppScopedOAuthProtectedResourceMetadata extends BaseRoute {
  schema = {
    tags: ['OAuth'],
    summary: 'OAuth protected-resource metadata for the per-app MCP mount',
    operationId: 'oauth-protected-resource-metadata-app-scoped',
    description:
      'RFC 9728 protected-resource metadata for /v1/apps/{appId}/mcp. Points MCP ' +
      'clients at the Supabase-backed authorization server; unauthenticated.',
    request: {
      params: z.object({ appId: z.string().min(1) }),
    },
    security: [],
    responses: {
      200: {
        description: 'Protected-resource metadata for this app\'s MCP mount.',
        content: {
          'application/json': {
            schema: OAuthProtectedResourceMetadataSchema,
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const data = await this.getValidatedData();
    const { appId } = data.params as { appId: string };
    const origin = requestOrigin(c.req);
    return c.json(
      {
        resource: `${origin}/v1/apps/${appId}/mcp`,
        authorization_servers: [c.env.SUPABASE_API_BASE_URL],
      },
      200,
    );
  }
}
