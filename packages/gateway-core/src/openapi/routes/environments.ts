/**
 * Environments OpenAPI Routes
 *
 * V1 CRUD surface for per-app named environments. The route handlers in this
 * file are THIN wrappers: they parse + validate the request, resolve auth,
 * delegate to a shared domain layer, and project the result onto the wire
 * shape. Env-lifecycle logic lives in `@repo/environments-service`. There is
 * no duplicated business logic here.
 *
 * There is no promote / rollback / deployment-saga list surface — env
 * deployments do not run from git events. Environments keep their
 * default-env posture; the future env design starts fresh.
 *
 * Auth model:
 *   - GET    /v1/environments                          environment.read
 *   - POST   /v1/environments                          environment.insert
 *   - GET    /v1/environments/{id}                     environment.read
 *   - DELETE /v1/environments/{id}                     environment.delete
 * Every route accepts api-key OR bearer auth uniformly.
 */

import {
  EnvironmentService,
  validateEnvironmentName,
} from '@repo/environments-service';
import {
  BaseRoute,
  type AppContext,
  errorResponse,
  getScopedSupabase,
  parseJsonBody,
  structuredError,
  z,
} from './_shared';
import {
  asServiceClient,
  type ServiceSupabaseClient,
} from '../../lib/system-client';
import type { GatewayPermission } from '../../lib/permissions';
import { buildEnvLimitCheck } from '../../lib/entitlements';

// ---------------------------------------------------------------------------
// Wire-shape Zod schemas
//
// Inline schemas for the route surface. These live here (not in
// `@repo/api-schemas`) until the env types stabilize and are
// promoted to the shared package alongside SDK codegen.
// ---------------------------------------------------------------------------

const EnvironmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  is_default: z.boolean(),
  current_version: z.number().int().nonnegative(),
  /**
   * The git commit SHA the env is pinned to — denormalized onto
   * `environment` and advanced by `advanceCommitPointers` on git
   * link/push/resync. NULL for an env that has never had a commit pointer
   * advance. Lets the dashboard pinned-env chip show the real commit + a
   * "View on git provider" deep link.
   */
  current_commit_sha: z.string().nullable(),
  fly_app_name: z.string().nullable(),
  /** Ephemeral PR preview env. */
  is_ephemeral: z.boolean(),
  /** PR number this ephemeral env previews; null for normal envs. */
  source_pr_number: z.number().int().nullable(),
  epoch: z.number().int(),
  created_at: z.string(),
  created_by_id: z.string().nullable(),
});

const CascadePreviewSchema = z.object({
  api_key_count: z.number().int().nonnegative(),
  /** Always 0 — the alert table is gone. Kept so existing clients still parse. */
  alert_count: z.number().int().nonnegative(),
  /** Always 0 — the deployment table is gone. Kept for the same reason. */
  deployment_count: z.number().int().nonnegative(),
});

const EnvironmentDetailSchema = EnvironmentSchema.extend({
  updated_at: z.string().nullable(),
  in_flight_saga_id: z.string().uuid().nullable(),
  cascade_preview: CascadePreviewSchema,
});

const EnvironmentsListResponseSchema = z.object({
  data: z.array(EnvironmentSchema),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  }),
});

const EnvironmentDetailResponseSchema = z.object({
  data: EnvironmentDetailSchema,
});

const EnvironmentCreateResponseSchema = z.object({
  data: EnvironmentSchema.extend({
    api_key_creation_url: z.string(),
  }),
});

const EnvironmentDeleteResponseSchema = z.object({
  data: z.object({
    id: z.string().uuid(),
    deleted_at: z.string(),
    cascade: z.object({
      api_keys_revoked: z.number().int().nonnegative(),
      alerts_deleted: z.number().int().nonnegative(),
      deployments_deleted: z.number().int().nonnegative(),
      fly_app_destroyed: z.boolean(),
    }),
  }),
});

const EnvironmentsListParamsSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const CreateEnvironmentBodySchema = z.object({
  name: z.string(),
});

const DeleteEnvironmentBodySchema = z.object({
  confirmation_name: z.string(),
});

const EnvironmentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Local row types — used only for wire projection of read endpoints.
//
// The generated `Database` types in `@repo/db-types` don't yet include the
// `environment` table (codegen pending). This mirrors the columns the read
// routes project; replace with the generated row type once `yarn codegen:db`
// lands.
// ---------------------------------------------------------------------------

interface EnvironmentRow {
  id: string;
  name: string;
  is_default: boolean;
  is_ephemeral: boolean;
  source_pr_number: number | null;
  current_version: number;
  /**
   * Denormalized git commit SHA this env is pinned to — a real column on
   * `environment`, advanced by `advanceCommitPointers` on git link/push/
   * resync. NULL for an env that has never had a commit pointer advance.
   */
  current_commit_sha: string | null;
  fly_app_name: string | null;
  epoch: number;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
}

// ---------------------------------------------------------------------------
// Wire projection helpers
// ---------------------------------------------------------------------------

/** Project an `environment` row onto the API wire shape. */
function rowToEnvironment(row: EnvironmentRow): z.infer<typeof EnvironmentSchema> {
  return {
    id: row.id,
    name: row.name,
    is_default: row.is_default,
    current_version: row.current_version,
    current_commit_sha: row.current_commit_sha,
    fly_app_name: row.fly_app_name,
    is_ephemeral: row.is_ephemeral,
    source_pr_number: row.source_pr_number,
    epoch: row.epoch,
    created_at: row.created_at,
    created_by_id: row.created_by,
  };
}

/**
 * Build the dashboard URL the post-creation modal points at:
 *   "Create an API key for this environment →"
 */
function buildApiKeyCreationUrl(c: AppContext, appId: string, envId: string): string {
  const base = c.env.DASHBOARD_BASE_URL.replace(/\/+$/, '');
  return `${base}/api-keys?app=${encodeURIComponent(appId)}&env=${encodeURIComponent(envId)}`;
}

/**
 * Resolve the `actor_id` value for a saga mutation. Bearer-auth callers have a
 * real `profile.id` in `gatewayUserId`; API-key callers have no profile, so we
 * pass `null` (the column is nullable — matches the orchestrator's
 * `actorId | null`).
 */
function resolveActorId(c: AppContext): string | null {
  const user = c.get('user');
  return user.authMode === 'bearer' ? user.gatewayUserId ?? null : null;
}

// ---------------------------------------------------------------------------
// Service composition roots
//
// The shared `@repo/environments-service` classes are stateless given their
// deps, so building one per request is cheap. These factories keep the route
// handlers free of any wiring detail.
// ---------------------------------------------------------------------------

/**
 * Build an {@link EnvironmentService}, wired with a `checkEnvLimit` that
 * enforces the `max_environments_per_app` tier limit on every env
 * create. Both the api-key and bearer paths reach env creation through this
 * one route, so enforcing here covers them uniformly.
 */
function buildEnvironmentService(
  c: AppContext,
  supabase: ServiceSupabaseClient,
): EnvironmentService {
  return new EnvironmentService({
    supabase,
    // Entitlement gate. `EnvironmentService.createEnvironment`
    // supplies the current env count; `buildEnvLimitCheck` resolves the
    // `max_environments_per_app` tier ceiling and applies the canonical quota
    // comparison. Inert on the non-create routes that share this builder —
    // the hook is only invoked by `createEnvironment`.
    checkEnvLimit: buildEnvLimitCheck(c.env),
  });
}


// ---------------------------------------------------------------------------
// GET /v1/environments
// ---------------------------------------------------------------------------

export class ListEnvironments extends BaseRoute {
  static requiredPermission: GatewayPermission = 'environment.read';

  schema = {
    tags: ['Environments'],
    summary: 'List environments',
    operationId: 'list-environments',
    description:
      'Returns environments for the authenticated application, default env first. Each env carries pin state (`current_version` — 0 when no-pin — plus `current_commit_sha`, the git commit of the pinned deployment, NULL when no-pin) and a stable `epoch` that distinguishes env instances across name reuse after delete.',
    request: { query: EnvironmentsListParamsSchema },
    responses: {
      200: {
        description: 'Paginated list of environments.',
        content: { 'application/json': { schema: EnvironmentsListResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'environment.read' permission."),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as {
      query: { limit: number; offset: number };
    };
    const { limit, offset } = data.query;

    const user = c.get('user');
    const supabase = asServiceClient(await getScopedSupabase(c));
    const service = new EnvironmentService({ supabase });

    // Pagination is pushed into PostgREST (`.range` + `{ count: 'exact' }`) —
    // the service never pages in memory and `total` is the exact row count.
    //
    // A genuine service error (Supabase down, RLS reject) is NOT swallowed
    // into a 200 + empty list: that is indistinguishable from "app has no
    // environments" and would make the dashboard redirect users off valid
    // environments. The error propagates and the gateway's `app.onError`
    // emits the canonical 500 error envelope. The only legitimate empty
    // result is the service returning `[]` without throwing.
    let listResult: Awaited<ReturnType<EnvironmentService['listEnvironments']>>;
    try {
      listResult = await service.listEnvironments(String(user.appId), {
        limit,
        offset,
      });
    } catch (err) {
      console.error('[GET /v1/environments]', err);
      return c.json(
        structuredError('internal_error', 'Failed to list environments'),
        500,
      );
    }

    const list = listResult.rows.map((r) =>
      rowToEnvironment(r as unknown as EnvironmentRow),
    );
    return c.json({
      data: list,
      pagination: { total: listResult.total, limit, offset },
    });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/environments
// ---------------------------------------------------------------------------

export class CreateEnvironment extends BaseRoute {
  static requiredPermission: GatewayPermission = 'environment.insert';

  schema = {
    tags: ['Environments'],
    summary: 'Create environment',
    operationId: 'create-environment',
    description:
      'Creates a new environment in the current app. The env starts in the no-pin state. No runtime is provisioned and no API key is auto-minted; the response includes `api_key_creation_url` for the post-create CTA.',
    request: {
      body: { content: { 'application/json': { schema: CreateEnvironmentBodySchema } } },
    },
    responses: {
      201: {
        description: 'Environment created.',
        content: { 'application/json': { schema: EnvironmentCreateResponseSchema } },
      },
      400: errorResponse('Invalid request body or env name.'),
      401: errorResponse('Missing or invalid API key.'),
      // NOTE: deliberately the generic error envelope, NOT
      // `entitlementRequiredResponse` — the env service emits
      // `code: 'env_limit_exceeded'` without an `entitlement` field, and the
      // documented schema must match the wire reality (schemathesis enforces
      // response_schema_conformance). Migrating this route to the canonical
      // entitlement envelope is a wire-format change deferred to a follow-up.
      402: errorResponse(
        "App has reached the environment limit for its tier ('env_limit_exceeded').",
      ),
      403: errorResponse("Caller lacks 'environment.insert' permission."),
      409: errorResponse('Env name already exists on this app.'),
    },
  };

  async handle(c: AppContext) {
    const raw = await parseJsonBody(c);
    const parsed = CreateEnvironmentBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(structuredError('invalid_request_body', 'Invalid request body'), 400);
    }
    const { name } = parsed.data;

    // Env name MUST be rejected at the API boundary with a clear
    // validation error BEFORE any state is written — and before the Fly
    // precheck below, so an invalid name always yields 400 env_name_invalid
    // regardless of whether Fly is configured on this deployment.
    const nameCheck = validateEnvironmentName(name);
    if (!nameCheck.valid) {
      return c.json(structuredError('env_name_invalid', nameCheck.message), 400);
    }

    const user = c.get('user');
    const supabase = asServiceClient(await getScopedSupabase(c));

    const service = buildEnvironmentService(c, supabase);

    const appId = String(user.appId);
    const result = await service.createEnvironment({
      tenantId: String(user.tenantId),
      appId,
      name,
      actorId: resolveActorId(c),
    });

    if (!result.ok) {
      switch (result.code) {
        case 'env_name_invalid':
          return c.json(
            structuredError('env_name_invalid', result.message, { field: 'name' }),
            400,
          );
        case 'env_name_conflict':
          return c.json(structuredError('env_name_conflict', result.message), 409);
        case 'env_limit_exceeded':
          return c.json(structuredError('env_limit_exceeded', result.message), 402);
        default:
          return c.json(
            structuredError('internal_error', 'Failed to create environment'),
            500,
          );
      }
    }

    const envView = rowToEnvironment(result.environment as unknown as EnvironmentRow);
    return c.json(
      {
        data: {
          ...envView,
          api_key_creation_url: buildApiKeyCreationUrl(c, appId, result.environment.id),
        },
      },
      201,
    );
  }
}

// ---------------------------------------------------------------------------
// GET /v1/environments/{id}
// ---------------------------------------------------------------------------

export class GetEnvironment extends BaseRoute {
  static requiredPermission: GatewayPermission = 'environment.read';

  schema = {
    tags: ['Environments'],
    summary: 'Get environment',
    operationId: 'get-environment',
    description:
      'Returns a single environment by id. Includes `cascade_preview` (the count of api_key rows that would be deleted on env delete; `alert_count` and `deployment_count` are always 0 and remain only for response-shape compatibility) and `in_flight_saga_id` (id of the most-recent pending/snapshotting/deploying saga deployment row, or null).',
    request: { params: EnvironmentIdParamsSchema },
    responses: {
      200: {
        description: 'Environment detail with cascade preview.',
        content: { 'application/json': { schema: EnvironmentDetailResponseSchema } },
      },
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'environment.read' permission."),
      404: errorResponse('Environment not found.'),
    },
  };

  async handle(c: AppContext) {
    const data = (await this.getValidatedData()) as { params: { id: string } };
    const { id } = data.params;

    const user = c.get('user');
    const supabase = asServiceClient(await getScopedSupabase(c));
    const service = new EnvironmentService({ supabase });

    const env = await service.getEnvironment(id);
    // Scope to the caller's app — the shared service does not filter by app.
    if (!env || env.app_id !== String(user.appId)) {
      return c.json(
        structuredError('not_found', `Environment '${id}' not found`),
        404,
      );
    }

    const cascade = await service.computeCascade(id);

    const envView = rowToEnvironment(env as unknown as EnvironmentRow);
    return c.json({
      data: {
        ...envView,
        updated_at: env.updated_at,
        // Always null — no env can have an in-flight saga: there is no
        // env-promotion machinery and no `deployment` table this field would
        // resolve from. See `EnvironmentService.getInFlightSaga`'s doc
        // comment.
        in_flight_saga_id: null,
        cascade_preview: {
          api_key_count: cascade.api_keys_revoked,
          alert_count: cascade.alerts_deleted,
          deployment_count: cascade.deployments_deleted,
        },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/environments/{id}
// ---------------------------------------------------------------------------

export class DeleteEnvironment extends BaseRoute {
  static requiredPermission: GatewayPermission = 'environment.delete';

  schema = {
    tags: ['Environments'],
    summary: 'Delete environment',
    operationId: 'delete-environment',
    description:
      'Hard-deletes a non-default environment after a typed-name confirmation. Cascade order: env row → CASCADE removes api_key. An environment owns no runtime, so nothing outside the database is torn down.',
    request: {
      params: EnvironmentIdParamsSchema,
      body: { content: { 'application/json': { schema: DeleteEnvironmentBodySchema } } },
    },
    responses: {
      200: {
        description: 'Environment deleted.',
        content: { 'application/json': { schema: EnvironmentDeleteResponseSchema } },
      },
      400: errorResponse('Confirmation name does not match the environment name.'),
      401: errorResponse('Missing or invalid API key.'),
      403: errorResponse("Caller lacks 'environment.delete' permission."),
      404: errorResponse('Environment not found.'),
      409: errorResponse('The default environment cannot be deleted.'),
    },
  };

  async handle(c: AppContext) {
    // chanfana validates `params` AND `body` against the route schema and
    // consumes the request body stream while doing so. Read both from the
    // validated data — calling `parseJsonBody` (c.req.json()) afterwards would
    // re-read an already-consumed stream and always yield `{}`.
    const data = (await this.getValidatedData()) as {
      params: { id: string };
      body: { confirmation_name: string };
    };
    const { id } = data.params;
    const { confirmation_name } = data.body;

    const user = c.get('user');
    const supabase = asServiceClient(await getScopedSupabase(c));

    const service = buildEnvironmentService(c, supabase);

    // Scope to the caller's app before deleting — the shared service filters on
    // `tenant_id` only, and under api-key auth the client is the `gateway` role
    // whose environment DELETE policy is likewise tenant-wide, so this is the
    // only app predicate on the path. The delete is destructive and
    // unrecoverable: the row is hard-deleted, `api_key.environment_id ON DELETE
    // CASCADE` revokes every key bound to it, and the Fly app is destroyed.
    //
    // The confirmation name is not a substitute — apps within one tenant may
    // freely reuse `staging`/`prod`. Mirrors the sibling GET's check.
    const target = await service.getEnvironment(id);
    if (!target || target.app_id !== String(user.appId)) {
      return c.json(
        structuredError('not_found', `Environment '${id}' not found`),
        404,
      );
    }

    const result = await service.deleteEnvironment({
      tenantId: String(user.tenantId),
      envId: id,
      confirmationName: confirmation_name,
      actorId: resolveActorId(c),
    });

    if (!result.ok) {
      switch (result.code) {
        case 'not_found':
          return c.json(structuredError('not_found', result.message), 404);
        case 'env_default_cannot_delete':
          return c.json(
            structuredError('env_default_cannot_delete', result.message),
            409,
          );
        case 'env_confirmation_mismatch':
          return c.json(
            structuredError('env_confirmation_mismatch', result.message),
            400,
          );
        default:
          return c.json(
            structuredError('internal_error', 'Failed to delete environment'),
            500,
          );
      }
    }

    return c.json({
      data: {
        id,
        deleted_at: new Date().toISOString(),
        cascade: result.cascade,
      },
    });
  }
}
