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
    const origin = new URL(c.req.url).origin;
    return c.json(
      {
        resource: `${origin}/v1/mcp`,
        authorization_servers: [c.env.SUPABASE_API_BASE_URL],
      },
      200,
    );
  }
}
