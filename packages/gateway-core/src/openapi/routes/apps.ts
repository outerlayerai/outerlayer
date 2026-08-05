/**
 * Apps OpenAPI Routes
 *
 * Public /v1/apps/* surface. Designed primarily for headless LLM agent
 * provisioning — the prerequisite for every other resource (api keys,
 * environments, traces) hanging off an app row.
 *
 * Auth model:
 *   - GET    /v1/apps                app.read
 *   - POST   /v1/apps                app.insert
 *   - GET    /v1/apps/{appId}        app.read
 *   - PATCH  /v1/apps/{appId}        app.update
 *   - DELETE /v1/apps/{appId}        app.delete
 *
 * Why PATCH (not PUT) for update: app fields are independent — rename
 * without touching runtime, change runtime without touching entry_point,
 * etc. PATCH semantics map directly. A resource whose fields constrain each
 * other would want full-body validation instead.
 *
 * Tenant scoping: every operation uses `user.tenantId`, NOT
 * `user.appId`. Apps are tenant-level resources.
 *
 * `X-Outerlayer-App-Id` header rules:
 *   - **Bearer (session JWT) auth on POST/GET /v1/apps**: header is OPTIONAL.
 *     The middleware's `TENANT_SCOPED_V1_ROUTES` allowlist lets these two
 *     routes through without an app-id header, so headless agents can call
 *     `POST /v1/apps` on a cold tenant (no app exists yet).
 *   - **API-key auth**: the header is REQUIRED — API keys are bound to
 *     an `appId` and the auth middleware uses it to resolve userMeta. The
 *     value is otherwise ignored inside this handler.
 *   - **Per-app routes** (`/v1/apps/:appId`, `/v1/apps/:appId/git*`): the
 *     header is required for both auth modes. The handler cross-checks
 *     `:appId` against `user.tenantId` via the apps service.
 */

import {
  CreateAppBodySchema,
  UpdateAppBodySchema,
  AppsListParamsSchema,
  AppListResponseSchema,
  AppDetailResponseSchema,
  GitConnectionStatusResponseSchema,
  StartGitConnectBodySchema,
  GitConnectAuthorizationResponseSchema,
  LinkAppRepositoryBodySchema,
  LinkAppRepositoryResponseSchema,
  ListAppGitBranchesQuerySchema,
  ListAppGitBranchesResponseSchema,
  ListAppGitRepositoriesResponseSchema,
  type CreateAppBody,
  type LinkAppRepositoryBody,
  type StartGitConnectBody,
  type UpdateAppBody,
} from '@repo/api-schemas';
import {
  BaseRoute,
  type AppContext,
  errorResponse,
  entitlementRequiredResponse,
  getScopedSupabase,
  structuredError,
  parseJsonBody,
  z,
} from './_shared';
import { ApiException, InputValidationException } from 'chanfana';
import {
  AppsService,
  AppNotFoundError,
  DuplicateAppNameError,
  GitConnectionMissingError,
  RepoBranchAlreadyLinkedError,
} from '../../services/apps-service';
import {
  GitConnectService,
  GitConnectConfigurationError,
} from '../../services/git-connect-service';
import { createGitProvider } from '../../git/factory';
import { UnsupportedGitProviderError } from '../../git/types';
import type { GitFileProvider, GitProviderType } from '../../git/types';
import type { GatewayPermission } from '../../lib/permissions';
import { getGithubAppSlug } from '../../lib/github-app-slug';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getService(c: AppContext): Promise<AppsService> {
  const supabase = await getScopedSupabase(c);
  return new AppsService(supabase as any);
}

function getTenantScope(c: AppContext) {
  const user = c.get('user');
  return {
    tenantId: String(user.tenantId),
    // Bearer auth gives a real profile.id; api-key auth gives the
    // system-user id (which may not satisfy the `app.created_by →
    // profile.id` FK). Null is the safe fallback for headless agents.
    userId: (user as { gatewayUserId?: string | null }).gatewayUserId ?? null,
  };
}

function handleDomainError(c: AppContext, error: unknown, context: string) {
  if (error instanceof ApiException || error instanceof InputValidationException) {
    throw error;
  }
  if (error instanceof AppNotFoundError) {
    return c.json(structuredError('app_not_found', error.message), 404);
  }
  if (error instanceof DuplicateAppNameError) {
    return c.json(structuredError('duplicate_app_name', error.message), 409);
  }
  if (error instanceof GitConnectionMissingError) {
    return c.json(structuredError('git_connection_missing', error.message), 409);
  }
  if (error instanceof RepoBranchAlreadyLinkedError) {
    return c.json(structuredError('repo_branch_already_linked', error.message), 409);
  }
  if (error instanceof UnsupportedGitProviderError) {
    return c.json(
      structuredError('unsupported_git_provider', error.message, { provider: error.provider }),
      409,
    );
  }
  if (error instanceof GitConnectConfigurationError) {
    // Provider OAuth config missing or unusable — the GitHub App slug
    // couldn't be resolved from GET /app. 503:
    // agent should retry later / surface to ops. The error.message is
    // operator-facing and safe to log; the response body intentionally
    // hides the specific cause.
    console.error(`[${context}] git-connect config error:`, error.message);
    return c.json(
      structuredError(
        'git_connect_not_configured',
        'Git provider OAuth is not configured for this environment',
      ),
      503,
    );
  }
  console.error(`[${context}]`, error);
  return c.json(structuredError('internal_error', 'Internal server error'), 500);
}

const AppIdParamsSchema = z.object({ appId: z.string().uuid() });

/**
 * Build a GitFileProvider for the app's current git_connection.
 *
 * Reads the GitHub installation_id and constructs the provider
 * implementation. Returns null when the OAuth handshake hasn't run
 * yet — callers should surface this as a 409 with
 * `git_connection_missing` rather than a 500.
 */
async function buildProviderForApp(
  c: AppContext,
  appId: string,
): Promise<GitFileProvider | null> {
  const supabase = await getScopedSupabase(c);
  const { data, error } = await (supabase as any)
    .from('git_connection')
    .select('provider, installation_id')
    .eq('app_id', appId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return createGitProvider(
    {
      provider: data.provider as GitProviderType,
      installationId: data.installation_id ?? undefined,
    },
    c.env,
  );
}

// ===========================================================================
// GET /v1/apps
// ===========================================================================

export class ListApps extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.read';
  schema = {
    tags: ['Apps'],
    summary: 'List apps',
    operationId: 'list-apps',
    description:
      'Returns apps for the authenticated tenant, newest first. Use `?name=<exact>` to look up a specific app by name without paginating.\n\n**Auth headers:** `X-Outerlayer-App-Id` is OPTIONAL for bearer (session JWT) auth — the listing is tenant-scoped, so headless agents on a cold tenant can call this without supplying any app id. API-key callers still send the header (API keys are app-scoped), but its value is ignored by this handler.',
    request: {
      query: AppsListParamsSchema,
    },
    responses: {
      200: {
        description: 'Paginated list of apps.',
        content: { 'application/json': { schema: AppListResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.read' permission."),
    },
  };

  async handle(c: AppContext) {
    try {
      const data = (await this.getValidatedData()) as {
        query: z.infer<typeof AppsListParamsSchema>;
      };
      const { tenantId } = getTenantScope(c);
      const result = await (await getService(c)).listApps(tenantId, {
        name: data.query.name,
        limit: data.query.limit,
        offset: data.query.offset,
      });
      return c.json({
        data: result.data,
        pagination: {
          total: result.total,
          limit: data.query.limit,
          offset: data.query.offset,
        },
      });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// POST /v1/apps
// ===========================================================================

export class CreateApp extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.insert';
  schema = {
    tags: ['Apps'],
    summary: 'Create app',
    operationId: 'create-app',
    description:
      'Creates a new app in the authenticated tenant. `runtime` defaults to `nodejs` if omitted.\n\nReturns 409 `duplicate_app_name` when the tenant already has an app with the supplied `name`.\n\nReturns 402 `entitlement_required` with `entitlement: "max_apps"`, `limit`, and `current` when the tenant has hit their app quota — agents can branch on this to prompt a tier upgrade.',
    request: {
      body: { content: { 'application/json': { schema: CreateAppBodySchema } } },
    },
    responses: {
      201: {
        description: 'App created.',
        content: { 'application/json': { schema: AppDetailResponseSchema } },
      },
      400: errorResponse('Invalid request body.'),
      401: errorResponse('Missing or invalid API key.'),
      402: entitlementRequiredResponse(
        "Tenant has reached the 'max_apps' quota for their tier.",
      ),
      403: errorResponse("Caller lacks 'app.insert' permission."),
      409: errorResponse('An app with this name already exists for the tenant.'),
    },
  };

  async handle(c: AppContext) {
    const raw: unknown = await parseJsonBody(c);
    const parsed = CreateAppBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          issue?.message ?? 'Invalid request body',
          { field: issue?.path?.join('.') ?? undefined },
        ),
        400,
      );
    }
    try {
      const { tenantId, userId } = getTenantScope(c);
      const app = await (await getService(c)).createApp(
        tenantId,
        parsed.data as CreateAppBody,
        userId,
      );
      return c.json({ data: app }, 201);
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// GET /v1/apps/:appId
// ===========================================================================

export class GetApp extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.read';
  schema = {
    tags: ['Apps'],
    summary: 'Get app',
    operationId: 'get-app',
    description: 'Returns a single app by ID.',
    request: { params: AppIdParamsSchema },
    responses: {
      200: {
        description: 'App detail.',
        content: { 'application/json': { schema: AppDetailResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.read' permission."),
      404: errorResponse('App not found.'),
    },
  };

  async handle(c: AppContext) {
    const { params } = (await this.getValidatedData()) as { params: { appId: string } };
    try {
      const { tenantId } = getTenantScope(c);
      const app = await (await getService(c)).getApp(tenantId, params.appId);
      return c.json({ data: app });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// PATCH /v1/apps/:appId
// ===========================================================================

export class UpdateApp extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.update';
  schema = {
    tags: ['Apps'],
    summary: 'Update app',
    operationId: 'update-app',
    description:
      'Updates writable fields on an app. PATCH semantics — any subset of `name`, `display_name`, `runtime`, `entry_point` may be sent. `display_name` is the optional free-form UI label; send `null` to clear it and fall back to `name`. An empty body is rejected with 400.\n\nReturns 409 `duplicate_app_name` if renaming would collide with another app in the same tenant.',
    request: {
      params: AppIdParamsSchema,
      body: { content: { 'application/json': { schema: UpdateAppBodySchema } } },
    },
    responses: {
      200: {
        description: 'App updated.',
        content: { 'application/json': { schema: AppDetailResponseSchema } },
      },
      400: errorResponse('Invalid request body.'),
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.update' permission."),
      404: errorResponse('App not found.'),
      409: errorResponse('An app with this name already exists for the tenant.'),
    },
  };

  async handle(c: AppContext) {
    // `getValidatedData` is the single body read. The workerd stream is
    // one-shot, so calling both `parseJsonBody` and `getValidatedData`
    // swallows the body before chanfana sees it.
    const data = (await this.getValidatedData()) as {
      params: { appId: string };
      body?: unknown;
    };
    const parsed = UpdateAppBodySchema.safeParse(data.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          issue?.message ?? 'Invalid request body',
          { field: issue?.path?.join('.') ?? undefined },
        ),
        400,
      );
    }
    try {
      const { tenantId, userId } = getTenantScope(c);
      const app = await (await getService(c)).updateApp(
        tenantId,
        data.params.appId,
        parsed.data as UpdateAppBody,
        userId,
      );
      return c.json({ data: app });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// GET /v1/apps/:appId/git
//
// Read-only git connection status. The companion POST .../git/connect
// mints a GitHub App install URL with a signed state token for CSRF
// defense — see StartGitConnect below.
// ===========================================================================

export class GetAppGitConnection extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.read';
  schema = {
    tags: ['Apps'],
    summary: 'Get git connection status for an app',
    operationId: 'get-app-git-connection',
    description:
      'Returns the current git connection state. `connected: true` means a `git_connection` row exists (OAuth handshake completed). `repository` is null between OAuth-done and repo-picked.\n\nHeadless flow: after sending a human to the install URL, poll this endpoint until `connected: true`.',
    request: { params: AppIdParamsSchema },
    responses: {
      200: {
        description: 'Git connection status (may report `connected: false` if no connection exists yet).',
        content: { 'application/json': { schema: GitConnectionStatusResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.read' permission."),
      404: errorResponse('App not found.'),
    },
  };

  async handle(c: AppContext) {
    const { params } = (await this.getValidatedData()) as { params: { appId: string } };
    try {
      const { tenantId } = getTenantScope(c);
      const status = await (await getService(c)).getGitConnection(tenantId, params.appId);
      return c.json({ data: status });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// POST /v1/apps/:appId/git/connect
//
// Mints a per-provider OAuth authorization URL with an HMAC-signed state
// token. The caller (typically a headless agent) hands the URL to a
// human for one-click install. The dashboard OAuth callback validates
// the state token and persists the connection. Companion endpoint:
// GET /v1/apps/:appId/git for polling connection status.
//
// State signing: stateless HMAC with a 10-minute TTL. See
// `lib/git-connect-state.ts` for the envelope format and rationale.
// ===========================================================================

export class StartGitConnect extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.update';
  schema = {
    tags: ['Apps'],
    summary: 'Mint an OAuth authorization URL for git-provider connect',
    operationId: 'start-app-git-connect',
    description:
      'Returns a GitHub App install authorization URL plus a signed state token. Headless flow:\n\n1. Headless agent POSTs `{ provider }`.\n2. Gateway returns `{ authorization_url, state, expires_at }`.\n3. Agent surfaces the URL to a human (Slack DM, console output, etc.).\n4. Human clicks; GitHub redirects to the dashboard OAuth callback.\n5. Callback validates the state token and writes the `git_connection` row.\n6. Agent polls `GET /v1/apps/:appId/git` until `{ connected: true }`.\n\nThe `state` token is HMAC-signed (10-minute TTL) and binds the OAuth callback to the originating app + tenant + provider. Each call mints a fresh nonce — no replay across attempts.\n\nReturns 503 `git_connect_not_configured` when the GitHub App slug cannot be resolved from `GET /app`.',
    request: {
      params: AppIdParamsSchema,
      body: { content: { 'application/json': { schema: StartGitConnectBodySchema } } },
    },
    responses: {
      201: {
        description: 'Authorization URL minted.',
        content: { 'application/json': { schema: GitConnectAuthorizationResponseSchema } },
      },
      400: errorResponse('Invalid request body.'),
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.update' permission."),
      404: errorResponse('App not found.'),
      503: errorResponse('Git provider OAuth is not configured on this environment.'),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as {
      params: { appId: string };
      body?: unknown;
    };
    const parsed = StartGitConnectBodySchema.safeParse(data.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          issue?.message ?? 'Invalid request body',
          { field: issue?.path?.join('.') ?? undefined },
        ),
        400,
      );
    }

    try {
      const { tenantId } = getTenantScope(c);

      // Existence check — return 404 (not silent 500) for stale appIds.
      // The AppsService getApp also enforces tenant_id scoping via the
      // gateway-role RLS policies, so this doubles as the cross-tenant
      // safety net.
      await (await getService(c)).getApp(tenantId, data.params.appId);

      const gitConnect = new GitConnectService({
        oauthStateSecret: c.env.OAUTH_STATE_SECRET,
        // Slug is derived from the App itself (GET /app), memoized per
        // isolate — not a hand-set env var. See lib/github-app-slug.ts.
        resolveGithubAppSlug: () => getGithubAppSlug(c.env),
      });

      const { authorizationUrl, state, expiresAt } = await gitConnect.buildAuthorizationUrl({
        appId: data.params.appId,
        tenantId,
        provider: (parsed.data as StartGitConnectBody).provider,
      });

      return c.json(
        {
          data: {
            authorization_url: authorizationUrl,
            state,
            expires_at: expiresAt,
          },
        },
        201,
      );
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// GET /v1/apps/:appId/git/repositories
//
// List repositories accessible to the linked git installation. Used by
// dashboards + headless agents to populate a repo picker after OAuth
// install completes but before `POST /v1/apps/:appId/git/link` runs.
// ===========================================================================

export class ListAppGitRepositories extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.read';
  schema = {
    tags: ['Apps'],
    summary: 'List repositories accessible to the app\'s git installation',
    operationId: 'list-app-git-repositories',
    description:
      'Returns repositories the linked GitHub App installation can see (the App\'s `/installation/repositories`).\n\nReturns 409 `git_connection_missing` when the OAuth handshake hasn\'t completed yet — call `POST /v1/apps/:appId/git/connect` first and have a human click through.',
    request: { params: AppIdParamsSchema },
    responses: {
      200: {
        description: 'Repositories accessible to the installation.',
        content: { 'application/json': { schema: ListAppGitRepositoriesResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.read' permission."),
      404: errorResponse('App not found.'),
      409: errorResponse('No git connection on this app yet.'),
    },
  };

  async handle(c: AppContext) {
    const { params } = (await this.getValidatedData()) as { params: { appId: string } };
    try {
      const { tenantId } = getTenantScope(c);
      // Existence + tenant check first so a stale appId 404s instead of
      // missing the git_connection lookup.
      await (await getService(c)).getApp(tenantId, params.appId);

      const resolved = await buildProviderForApp(c, params.appId);
      if (!resolved) throw new GitConnectionMissingError(params.appId);

      const repos = await resolved.listRepositories();
      return c.json({
        data: repos.map((r) => ({
          full_name: r.fullName,
          name: r.name,
          default_branch: r.defaultBranch,
        })),
      });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// GET /v1/apps/:appId/git/branches?repository=X
// ===========================================================================

export class ListAppGitBranches extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.read';
  schema = {
    tags: ['Apps'],
    summary: 'List branches in a repository',
    operationId: 'list-app-git-branches',
    description:
      'Returns the list of branch names for `repository` (passed as a query param because the value contains a slash). Use after `list-app-git-repositories` to populate a branch picker before linking.\n\nReturns 409 `git_connection_missing` when no OAuth install exists for this app.',
    request: {
      params: AppIdParamsSchema,
      query: ListAppGitBranchesQuerySchema,
    },
    responses: {
      200: {
        description: 'Branch names in the requested repository.',
        content: { 'application/json': { schema: ListAppGitBranchesResponseSchema } },
      },
      400: errorResponse('Missing or malformed `repository` query param.'),
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.read' permission."),
      404: errorResponse('App not found.'),
      409: errorResponse('No git connection on this app yet.'),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as {
      params: { appId: string };
      query: { repository: string };
    };
    try {
      const { tenantId } = getTenantScope(c);
      await (await getService(c)).getApp(tenantId, data.params.appId);

      const resolved = await buildProviderForApp(c, data.params.appId);
      if (!resolved) throw new GitConnectionMissingError(data.params.appId);

      const branches = await resolved.listBranches(data.query.repository);
      return c.json({ data: branches });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// POST /v1/apps/:appId/git/link
//
// Set the repository + branch the app's deploy pipeline should watch.
// Writes git_connection.repository, upserts git_branch, seeds
// app.commit_sha. Does NOT trigger initial template import — that runs
// on the next git push via the existing GitHub webhook orchestrator
// (deferred to a follow-up endpoint that moves the orchestrator to the
// gateway, per the parity audit).
// ===========================================================================

export class LinkAppRepository extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.update';
  schema = {
    tags: ['Apps'],
    summary: 'Link a repository and branch to an app',
    operationId: 'link-app-repository',
    description:
      'Persists the chosen repository + branch onto the app\'s existing git_connection. The next push to `branch` triggers the deploy webhook which materializes templates and datasets.\n\nRequires an existing OAuth install (returns 409 `git_connection_missing` otherwise). A repo+branch pair can be watched by only one app per organization — linking a pair already linked to another app returns 409 `repo_branch_already_linked`. Idempotent — re-linking the same repo+branch is a no-op aside from a commit_sha refresh.',
    request: {
      params: AppIdParamsSchema,
      body: { content: { 'application/json': { schema: LinkAppRepositoryBodySchema } } },
    },
    responses: {
      200: {
        description: 'Repository linked.',
        content: { 'application/json': { schema: LinkAppRepositoryResponseSchema } },
      },
      400: errorResponse('Invalid request body.'),
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.update' permission."),
      404: errorResponse('App not found.'),
      409: errorResponse(
        'No git connection on this app yet (`git_connection_missing`), or the repo+branch is already linked to another app in this organization (`repo_branch_already_linked`).',
      ),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as {
      params: { appId: string };
      body?: unknown;
    };
    const parsed = LinkAppRepositoryBodySchema.safeParse(data.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        structuredError(
          'invalid_request_body',
          issue?.message ?? 'Invalid request body',
          { field: issue?.path?.join('.') ?? undefined },
        ),
        400,
      );
    }

    try {
      const { tenantId } = getTenantScope(c);
      const service = await getService(c);

      const resolved = await buildProviderForApp(c, data.params.appId);
      if (!resolved) throw new GitConnectionMissingError(data.params.appId);

      const { userId } = getTenantScope(c);
      const result = await service.linkRepository(
        tenantId,
        data.params.appId,
        parsed.data as LinkAppRepositoryBody,
        resolved,
        userId,
      );

      return c.json({ data: result });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// DELETE /v1/apps/:appId/git/link
//
// Disconnect the linked repo+branch while preserving the underlying
// OAuth install. Template/storage cleanup is deferred to a follow-up
// endpoint that needs an admin Supabase client (RLS-scoped clients
// can't reliably purge per-tenant storage paths).
// ===========================================================================

export class UnlinkAppRepository extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.update';
  schema = {
    tags: ['Apps'],
    summary: 'Clear the linked repository and branch',
    operationId: 'unlink-app-repository',
    description:
      'Clears `git_connection.repository` and removes the `git_branch` row. The OAuth install is preserved so the user can re-link without re-clicking the install URL.\n\nDoes NOT delete stored objects for the app — callers that want a full reset should delete the app and recreate it.',
    request: { params: AppIdParamsSchema },
    responses: {
      204: { description: 'Repository unlinked.' },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.update' permission."),
      404: errorResponse('App not found.'),
      409: errorResponse('No git connection on this app yet.'),
    },
  };

  async handle(c: AppContext) {
    const { params } = (await this.getValidatedData()) as { params: { appId: string } };
    try {
      const { tenantId } = getTenantScope(c);
      const service = await getService(c);

      await service.unlinkRepository(tenantId, params.appId);

      return new Response(null, { status: 204 });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}

// ===========================================================================
// DELETE /v1/apps/:appId
// ===========================================================================

export class DeleteApp extends BaseRoute {
  static requiredPermission: GatewayPermission = 'app.delete';
  schema = {
    tags: ['Apps'],
    summary: 'Delete app',
    operationId: 'delete-app',
    description:
      'Deletes an app. Cascades to all child rows via ON DELETE CASCADE (git_connection, git_branch, api_key, environment, etc.).\n\n**Headless callers note:** API key rows are NOT cleaned up by this endpoint — the dashboard wraps DELETE + key-revoke separately. Headless agents that delete apps should either accept some orphan API key rows or call the API-key revoke endpoint directly with the keys they minted.',
    request: { params: AppIdParamsSchema },
    responses: {
      204: { description: 'App deleted.' },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'app.delete' permission."),
      404: errorResponse('App not found.'),
    },
  };

  async handle(c: AppContext) {
    const { params } = (await this.getValidatedData()) as { params: { appId: string } };
    try {
      const { tenantId } = getTenantScope(c);
      await (await getService(c)).deleteApp(tenantId, params.appId);
      return new Response(null, { status: 204 });
    } catch (error) {
      return handleDomainError(c, error, `${c.req.method} ${c.req.path}`);
    }
  }
}
