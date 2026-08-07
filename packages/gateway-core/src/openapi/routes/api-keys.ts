/**
 * API Keys OpenAPI Routes
 *
 * The gateway and dashboard share `@repo/api-key-service` for minting keys:
 * it generates the plaintext, writes the `api_key` metadata row, and stores
 * the peppered-HMAC digest in `private.api_key_secret` (the Postgres
 * key-store). This route owns the gateway-specific plumbing: pepper lookup,
 * Supabase writes via the system admin client, and rollback on DB failure.
 * The plaintext is returned ONCE and never stored — only its digest is.
 *
 * Routes:
 *   - GET    /v1/api-keys           — list metadata (no plaintext)
 *   - POST   /v1/api-keys           — create + return plaintext ONCE
 *   - DELETE /v1/api-keys/{apiKeyId} — revoke (delete row → CASCADE drops digest)
 *
 * Permissions: `api_key.read`, `api_key.insert`, `api_key.delete`
 * (gateway-side aliases of the OpenAPI doc's read/create/revoke).
 */

import { mintApiKey } from '@repo/api-key-service';
import { createSystemAdminClient } from '../../lib/system-client';
import { captureActivationEvent } from '../../lib/posthog';
import {
  ApiKeySchema,
  ApiKeyCreateResponseSchema,
  ApiKeysListParamsSchema,
  ApiKeysListResponseSchema,
  CreateApiKeyParamsSchema,
} from '@repo/api-schemas';
import {
  BaseRoute,
  type AppContext,
  errorResponse,
  entitlementRequiredResponse,
  getScopedSupabase,
  parseJsonBody,
  structuredError,
  z,
} from './_shared';
import type { GatewayPermission } from '../../lib/permissions';
import { toIsoTimestamp } from '../../lib/iso-date';
import { GATEWAY_PERMISSIONS } from '../../lib/permissions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set of permission strings the gateway recognizes — used to validate input. */
const VALID_PERMISSION_KEYS: ReadonlySet<string> = new Set(GATEWAY_PERMISSIONS);

/**
 * The permissions the CURRENT caller effectively holds for `appId`.
 *
 * The two auth modes carry authority in completely different places, which is
 * why this cannot be read off one field:
 *
 *   api-key — the key's own stored `permissions` array IS its authority.
 *   bearer  — `UserMeta.permissions` is deliberately EMPTY on this path (see
 *             verify-bearer.ts: authz is resolved by RLS). The real set lives in
 *             the database, so ask it, through the caller's own client so the
 *             answer is the caller's and not the service role's.
 *
 * Fails CLOSED: an RPC error yields an empty set, which makes any non-empty
 * request 403 rather than pass unchecked.
 */
async function resolveCallerPermissions(
  c: AppContext,
  appId: string,
): Promise<ReadonlySet<string>> {
  const user = c.get('user');

  if (user.authMode !== 'bearer') {
    return new Set(user.permissions ?? []);
  }

  const supabase = await getScopedSupabase(c);
  const { data, error } = await supabase.rpc('get_current_user_app_permissions', {
    target_app_id: appId,
  });
  if (error) {
    console.error('[api-keys] get_current_user_app_permissions failed', error.message);
    return new Set();
  }
  // The RPC is set-returning, so PostgREST hands back an array of scalars.
  return new Set((Array.isArray(data) ? data : []).map((p) => String(p)));
}

/**
 * Does the caller hold `permission` on `appId`? Used only for an app id the
 * caller supplied explicitly, which the route's own permission check does not
 * cover — that one is evaluated against the caller's bound app.
 *
 * Fails closed on any error.
 */
async function callerHoldsPermissionForApp(
  c: AppContext,
  permission: GatewayPermission,
  appId: string,
): Promise<boolean> {
  const user = c.get('user');

  if (user.authMode !== 'bearer') {
    // An api-key caller is bound to one app at mint time and `verify-key` already
    // cross-checks the request's app id against it, so a DIFFERENT app id is out
    // of that key's scope by construction — there is no wider set to consult.
    return false;
  }

  const supabase = await getScopedSupabase(c);
  const { data, error } = await supabase.rpc('app_authorize', {
    requested_permission: permission,
    target_app_id: appId,
  });
  if (error) {
    console.error('[api-keys] app_authorize failed', error.message);
    return false;
  }
  return data === true;
}

/**
 * PostgREST surfaces Postgres unique-constraint violations as
 * `{ code: '23505' }` with the constraint name in `details`/`message`.
 * Same shape as the AppsService/AlertsService private helpers.
 */
function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const e = error as { code?: string; details?: string; message?: string } | null;
  if (e?.code !== '23505') return false;
  return (
    (e.details?.includes(constraintName) ?? false) ||
    (e.message?.includes(constraintName) ?? false)
  );
}

/** Strip a single SQL-row down to the public ApiKey response shape. */
function rowToApiKey(row: {
  id: string;
  app_id: string;
  name: string;
  created_at: string | null;
  environment_id?: string | null;
  key_prefix?: string | null;
  permissions?: string[] | null;
  expires_at?: string | null;
}): z.infer<typeof ApiKeySchema> {
  return {
    id: row.id,
    name: row.name,
    app_id: row.app_id,
    // The bound environment (api_key.environment_id). Surfaced so callers can
    // see which env a key writes to. `?? null` tolerates legacy pre-env rows.
    environment_id: row.environment_id ?? null,
    // Permissions now live on the api_key row (enum[] column), so the list is a
    // single SELECT — no per-key provider round-trip.
    permissions: row.permissions ?? [],
    // The recognizable leading segment stored at mint time.
    key_prefix: row.key_prefix ?? null,
    // PostgREST timestamptz → ISO-8601 UTC (ApiKeySchema declares it as
    // z.string().datetime()). NULL falls back to epoch ISO (also conformant).
    created_at: row.created_at == null ? new Date(0).toISOString() : toIsoTimestamp(row.created_at),
    last_used_at: null,
    revoked_at: null,
    expires_at: row.expires_at == null ? null : toIsoTimestamp(row.expires_at),
  };
}

// ---------------------------------------------------------------------------
// GET /v1/api-keys
// ---------------------------------------------------------------------------

export class ListApiKeys extends BaseRoute {
  static requiredPermission: GatewayPermission = 'api_key.read';

  schema = {
    tags: ['API Keys'],
    summary: 'List API keys',
    operationId: 'list-api-keys',
    description:
      "Returns API keys for the authenticated tenant. Plaintext is never returned on this endpoint — record it at creation time.",
    request: { query: ApiKeysListParamsSchema },
    responses: {
      200: {
        description: 'Paginated list of API keys.',
        content: { 'application/json': { schema: ApiKeysListResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'api_key.read' permission."),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as {
      query: { limit: number; offset: number };
    };
    const { limit, offset } = data.query;

    const supabase = await getScopedSupabase(c);
    const user = c.get('user');

    // RLS scopes the read to keys the caller may see; we still pin app_id
    // for defense-in-depth (gateway API keys are app-scoped).
    //
    // Scope the listing to the API-key-bound environment's keys
    // only. To get the environment_id (UUID), we look up the caller's own api_key
    // row — it carries the environment_id FK directly. This avoids having to join
    // through the environment table from the listing query.
    let envId: string | undefined;
    if (user.apiKeyId) {
      // TODO(codegen): drop once yarn codegen:db includes the new columns
      const { data: callerKey, error: callerKeyError } = await (supabase as any)
        .from('api_key')
        .select('environment_id')
        .eq('api_key_id', user.apiKeyId)
        .maybeSingle();

      // Distinguish "DB threw" from "row not found" — both end up with no
      // envId, but the operator needs the DB error in logs to debug. Without
      // this, a transient Supabase failure was indistinguishable from a
      // missing-row in the downstream "returning empty" warning, and the
      // root cause stayed hidden.
      if (callerKeyError) {
        console.error(
          '[GET /v1/api-keys] failed to look up caller api_key row:',
          callerKeyError,
        );
      }

      envId = (callerKey as Record<string, unknown> | null)?.['environment_id'] as string | undefined;

      // Api_key.environment_id is NOT NULL post-migration. If envId is
      // still undefined here (the caller's own key row was not found — e.g. a
      // transient DB error or an impossible pre-migration key), we must NOT
      // fall open and return all-environment API keys. Return an empty page
      // instead so the caller does not silently receive cross-env data.
      if (!envId) {
        console.warn('[GET /v1/api-keys] caller api_key row missing environment_id — returning empty');
        return c.json({
          data: [],
          pagination: { total: 0, limit, offset },
        });
      }
    }

    // TODO(codegen): drop once yarn codegen:db includes the new columns
    let apiKeysQuery = (supabase as any)
      .from('api_key')
      .select('id, app_id, name, created_at, environment_id, key_prefix, permissions, expires_at', { count: 'exact' })
      .eq('app_id', user.appId)
      // Machine-minted keys (managed build / deployment SDK keys) never appear in
      // the user-facing list.
      .eq('is_machine', false);

    if (envId) {
      apiKeysQuery = apiKeysQuery.eq('environment_id', envId);
    }

    const { data: rows, error, count } = await apiKeysQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // PostgREST PGRST103 fires when `range()` starts past the total row
    // count — that's an empty-page-overflow case, not a server error. The
    // explicit branch ensures `total` reflects the real count (which
    // PostgREST still returns in the headers).
    if (error && (error as { code?: string }).code === 'PGRST103') {
      return c.json({
        data: [],
        pagination: { total: count ?? 0, limit, offset },
      });
    }
    if (error) {
      // Log and return empty — list endpoints don't document a 500 status.
      console.error('[GET /v1/api-keys]', error);
    }

    const list = (rows ?? []).map((r: { id: string; app_id: string; name: string; created_at: string | null; environment_id: string | null; key_prefix: string | null; permissions: string[] | null; expires_at: string | null }) => rowToApiKey(r));

    return c.json({
      data: list,
      pagination: { total: count ?? list.length, limit, offset },
    });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/api-keys
// ---------------------------------------------------------------------------

export class CreateApiKey extends BaseRoute {
  static requiredPermission: GatewayPermission = 'api_key.insert';

  schema = {
    tags: ['API Keys'],
    summary: 'Create API key',
    operationId: 'create-api-key',
    description:
      'Creates a new API key. The plaintext key is returned EXACTLY ONCE in `data.plaintext_key` — record it immediately. Subsequent reads expose only metadata.',
    request: {
      body: {
        content: { 'application/json': { schema: CreateApiKeyParamsSchema } },
      },
    },
    responses: {
      201: {
        description: 'API key created.',
        content: { 'application/json': { schema: ApiKeyCreateResponseSchema } },
      },
      400: errorResponse('Invalid request body, or no environment with the given `environment_name` on this app.'),
      401: errorResponse('Missing or invalid API key.'),
      402: entitlementRequiredResponse(
        "Tenant has reached the 'max_api_keys' limit for its tier.",
      ),
      403: errorResponse("Caller lacks 'api_key.insert' permission."),
      409: errorResponse('An API key with this name already exists on this app.'),
      500: errorResponse('Failed to create API key.'),
    },
  };

  async handle(c: AppContext) {
    const raw = await parseJsonBody(c);
    const parsed = CreateApiKeyParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(structuredError('invalid_request_body', 'Invalid request body'), 400);
    }
    const body = parsed.data;

    // Validate every requested permission against the gateway allowlist.
    // Mirrors the dashboard server action's check.
    const invalid = body.permissions.filter((p) => !VALID_PERMISSION_KEYS.has(p));
    if (invalid.length > 0) {
      return c.json(
        structuredError(
          'invalid_field_value',
          `Invalid permissions: ${invalid.join(', ')}`,
          { field: 'permissions' },
        ),
        400,
      );
    }

    const user = c.get('user');
    const tenantId = String(user.tenantId);

    // `body.app_id` is caller-supplied, and the route's declared permission is
    // checked against the caller's OWN app, so an explicit app id has to be
    // authorized on its own. Nothing downstream does it: the gateway role's
    // INSERT policy is tenant-wide and carries no app predicate.
    const appId = body.app_id ?? String(user.appId);
    if (body.app_id && body.app_id !== String(user.appId)) {
      const allowed = await callerHoldsPermissionForApp(c, 'api_key.insert', body.app_id);
      if (!allowed) {
        // 403, not 404: the caller already knows this app id — they sent it.
        return c.json(
          structuredError('forbidden', 'Not authorized to create keys for that app', {
            field: 'app_id',
          }),
          403,
        );
      }
    }

    // Clamp the requested permissions to what the CALLER holds. A minted key may
    // reproduce the caller's authority or narrow it, never widen it — and this
    // is the only place that holds: the stored array IS the authorization model
    // for api-key traffic, since the gateway role's RLS policies are tenant-wide
    // with no permission awareness.
    //
    // Rejecting rather than silently trimming is deliberate. A trim would hand
    // back a key quietly weaker than the one requested, and the caller would
    // discover it as a 403 somewhere else entirely.
    const callerPermissions = await resolveCallerPermissions(c, appId);
    const surplus = body.permissions.filter((p) => !callerPermissions.has(p));
    if (surplus.length > 0) {
      return c.json(
        structuredError(
          'forbidden',
          `Cannot grant permissions you do not hold: ${surplus.sort().join(', ')}`,
          { field: 'permissions' },
        ),
        403,
      );
    }

    const pepper = c.env.API_KEY_PEPPER;
    if (!pepper) {
      console.error('[api-keys] API_KEY_PEPPER not configured');
      return c.json(
        structuredError('api_key_creation_failed', 'API key service is not configured'),
        500,
      );
    }

    // Two clients: the RLS-scoped client owns the api_key row insert (its INSERT
    // policy gates on api_key.insert + tenant match); the admin client writes the
    // digest through set_api_key_secret. That RPC targets the private
    // api_key_secret table, which has NO grants and is reachable only by a
    // service-role DEFINER call — a scoped client cannot write it, so this is the
    // sanctioned system-admin escape hatch (createSystemAdminClient).
    const supabase = await getScopedSupabase(c);
    const adminClient = createSystemAdminClient(c.env);

    // Resolve which env the new key binds to BEFORE minting it — the env id now
    // travels in the Unkey token meta (the gateway reads env off the token).
    // Precedence:
    //   1. explicit `environment_name` in the body → that named env (validated
    //      against the app). Lets a session/bearer caller mint a key for a
    //      SPECIFIC env (e.g. production) instead of always the default.
    //   2. else the CALLER's env (key-auth) — a writer holding an env=prod key
    //      mints env=prod children.
    //   3. else (bearer auth, no name) the app's default env.
    // Resolving first means a failure here returns before any Unkey key exists
    // — no rollback needed. The resolved id is stored on the api_key row below,
    // the same `environment_id` column the dashboard CTA and managed deployment
    // write.
    let environmentId: string | undefined;
    let envError: { message?: string } | null;
    let envNameNotFound = false;
    if (body.environment_name) {
      const { data: namedEnv, error: namedErr } = await supabase
        .from('environment')
        .select('id')
        .eq('app_id', appId)
        .eq('name', body.environment_name)
        .maybeSingle();
      envError = namedErr;
      environmentId = namedEnv?.id;
      // A clean lookup that matched nothing is a caller error (unknown env
      // name), not a server fault — flag it so we return 400, not 500. The
      // app_id filter also guarantees a caller can't bind a key to another
      // app's environment.
      if (!namedErr && !environmentId) envNameNotFound = true;
    } else if (user.apiKeyId) {
      // TODO(codegen): drop once yarn codegen:db includes the new columns
      const { data: callerKey, error: callerErr } = await (supabase as any)
        .from('api_key')
        .select('environment_id')
        .eq('api_key_id', user.apiKeyId)
        .maybeSingle();
      envError = callerErr;
      environmentId = (callerKey as Record<string, unknown> | null)?.[
        'environment_id'
      ] as string | undefined;
    } else {
      const { data: defaultEnv, error: defaultErr } = await supabase
        .from('environment')
        .select('id')
        .eq('app_id', appId)
        .eq('is_default', true)
        .maybeSingle();
      envError = defaultErr;
      environmentId = defaultEnv?.id;
    }

    if (envNameNotFound) {
      return c.json(
        structuredError(
          'env_not_found',
          `No environment named "${body.environment_name}" on this app`,
          { field: 'environment_name' },
        ),
        400,
      );
    }

    if (envError || !environmentId) {
      // Fail closed. If the caller has an apiKeyId but the row lookup
      // failed/returned nothing, we MUST NOT silently bind the new key to the
      // default env — that's the bug class this branch is regressing against.
      console.error('[api-keys] environment resolution failed for create', {
        hasApiKeyId: !!user.apiKeyId,
        err: envError,
      });
      return c.json(
        structuredError('api_key_creation_failed', 'Failed to create API key'),
        500,
      );
    }

    // `@repo/api-key-service.mintApiKey` owns the whole mint: generate the
    // plaintext, hash it with the pepper, INSERT the api_key row via the scoped
    // client (raw PostgREST error surfaces so we keep the 23505→409 mapping),
    // then write the digest via set_api_key_secret on the admin client — rolling
    // the row back if that RPC fails. Gateway-issued keys have no human profile,
    // so created_by is null (matches the past gateway-system-user removal).
    let mintResult: { plaintext: string; row: Record<string, unknown> & { id: string; api_key_id: string } };
    try {
      mintResult = await mintApiKey({
        rowClient: supabase,
        adminClient,
        pepper,
        tenantId,
        appId,
        name: body.name,
        environmentId,
        permissions: body.permissions,
        createdBy: null,
      });
    } catch (err) {
      // `uc_api_key UNIQUE (name, app_id)` — a duplicate name is caller error,
      // not a server fault. The constraint is the authoritative uniqueness check
      // (a SELECT-then-INSERT pre-check would be racy), so classify after the
      // fact from the Postgres error code.
      if (isUniqueViolation(err, 'uc_api_key')) {
        return c.json(
          structuredError(
            'duplicate_api_key_name',
            'An API key with this name already exists on this app',
            { field: 'name' },
          ),
          409,
        );
      }
      console.error('[api-keys] mintApiKey failed', err);
      return c.json(
        structuredError('api_key_creation_failed', 'Failed to create API key'),
        500,
      );
    }

    const apiKeyView = rowToApiKey(
      mintResult.row as unknown as {
        id: string;
        app_id: string;
        name: string;
        created_at: string | null;
        environment_id: string | null;
        key_prefix: string | null;
        permissions: string[] | null;
        expires_at: string | null;
      },
    );

    // Stryker disable all: analytics call-site; captureActivationEvent tested in lib/__tests__/posthog.test.ts
    const _posthogPromise = captureActivationEvent(c.env, 'org_api_key_created', `tenant:${tenantId}`, tenantId, { app_id: appId });
    c.get('gtx').waitUntil(_posthogPromise);
    // Stryker restore all

    return c.json(
      {
        data: {
          ...apiKeyView,
          permissions: body.permissions,
          plaintext_key: mintResult.plaintext,
        },
      },
      201,
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/api-keys/{apiKeyId}
// ---------------------------------------------------------------------------

const ApiKeyIdParamsSchema = z.object({
  apiKeyId: z.string().min(1),
});

export class RevokeApiKey extends BaseRoute {
  static requiredPermission: GatewayPermission = 'api_key.delete';

  schema = {
    tags: ['API Keys'],
    summary: 'Revoke API key',
    operationId: 'revoke-api-key',
    description:
      'Revokes the API key and removes its local metadata row. Note: a brief revocation lag may occur — the gateway caches verified credentials for a short TTL, so a freshly-revoked key may still verify until the cache expires.',
    request: { params: ApiKeyIdParamsSchema },
    responses: {
      204: { description: 'API key revoked.' },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'api_key.delete' permission."),
      404: errorResponse('API key not found.'),
      500: errorResponse('Failed to revoke API key.'),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as { params: { apiKeyId: string } };
    const { apiKeyId } = data.params;

    const supabase = await getScopedSupabase(c);
    const user = c.get('user');

    // Look up by row id (UUID) per the OpenAPI contract. RLS enforces tenant.
    const { data: row, error: lookupErr } = await supabase
      .from('api_key')
      .select('id, app_id')
      .eq('id', apiKeyId)
      .eq('app_id', user.appId)
      .maybeSingle();

    if (lookupErr) {
      console.error('[api-keys] lookup failed', lookupErr);
      return c.json(structuredError('api_key_not_found', 'API key not found'), 404);
    }
    if (!row) {
      return c.json(structuredError('api_key_not_found', 'API key not found'), 404);
    }

    // Revocation IS row deletion. The private.api_key_secret digest cascades
    // (ON DELETE CASCADE), so the key stops verifying on the next userMeta cache
    // miss. There is no external provider to fall out of sync with, so the
    // visible-state-matches-auth-state invariant holds by construction: if the
    // delete fails, the key still authenticates AND still shows in the list, and
    // we surface a 500 so the caller retries.
    const { error: deleteErr } = await supabase
      .from('api_key')
      .delete()
      .eq('id', row.id);

    if (deleteErr) {
      console.error('[api-keys] DB delete failed', deleteErr);
      return c.json(
        structuredError('api_key_revoke_failed', 'Failed to revoke API key'),
        500,
      );
    }

    return new Response(null, { status: 204 });
  }
}
