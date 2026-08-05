/**
 * EnvironmentService — Environments & Promotion
 *
 * Business logic for env lifecycle lives here, not in route handlers.
 * Server actions and gateway route handlers delegate to this service.
 *
 * Dependencies are injected via the constructor for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { validateEnvironmentName } from './validate-environment-name';

/**
 * Explicit column list for `environment` reads — matches the {@link Environment}
 * interface. Avoids `select('*')` so a schema change cannot silently widen the
 * row shape past what the interface declares.
 *
 * `current_commit_sha` is a real denormalized column on `environment` —
 * advanced by `advanceCommitPointers` on git link/push/resync. It is
 * read as a plain column; no PostgREST embed / join is needed.
 * `latest_deployment_id` doesn't exist — the `deployment` table it pointed
 * at doesn't either.
 */
const ENVIRONMENT_COLUMNS =
  'id, tenant_id, app_id, name, is_default, is_ephemeral, source_pr_number, ' +
  'current_version, ' +
  'current_commit_sha, fly_app_name, fly_machine_id, ' +
  'epoch, created_at, created_by, updated_at, updated_by';

/**
 * Entitlement check seam (`max_environments_per_app`).
 *
 * `EntitlementService` lives in `apps/tenant-dashboard` and the gateway has
 * its own tier-config primitives — neither can be imported here (Constitution
 * III: packages MUST NOT import from apps). So the env-limit check is an
 * injected function dependency: the dashboard supplies an impl backed by its
 * `EntitlementService`, the gateway supplies one backed by `@repo/tier-config`.
 * When the dep is omitted, env creation is unrestricted (permissive default).
 */
export interface EnvLimitCheckInput {
  tenantId: string;
  appId: string;
  /** Current environment count for the app (default + non-default). */
  currentCount: number;
}

export interface EnvLimitCheckResult {
  allowed: boolean;
  limit: number;
  tierName?: string;
}

export type CheckEnvLimitFn = (
  input: EnvLimitCheckInput,
) => Promise<EnvLimitCheckResult>;

/**
 * The `environment` table row shape. Once `yarn codegen:db` runs against a
 * database that has the environment migrations applied, this can be replaced
 * with `Database['public']['Tables']['environment']['Row']`.
 */
export interface Environment {
  id: string;
  tenant_id: string;
  app_id: string;
  name: string;
  is_default: boolean;
  /** Ephemeral PR preview env — branch-backed, auto-torn-down. */
  is_ephemeral: boolean;
  /** PR number this ephemeral env previews; NULL for normal envs. */
  source_pr_number: number | null;
  current_version: number;
  /**
   * The git commit SHA this env is currently pinned to — denormalized onto
   * `environment` and advanced by `advanceCommitPointers` on git link/push/
   * resync. NULL for an env that has never had a commit pointer advance.
   */
  current_commit_sha: string | null;
  fly_app_name: string | null;
  fly_machine_id: string | null;
  epoch: number;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}


export interface EnvironmentServiceDeps {
  /** Service-role client. Skips RLS so service-layer writes (the default-env
   *  auto-create) work regardless of the caller's session. */
  supabase: SupabaseClient;

  /**
   * Optional env-limit check (`max_environments_per_app`). When
   * supplied, `createEnvironment` calls it before any DB write and returns
   * `env_limit_exceeded` if the tenant has hit its tier limit. When omitted,
   * env creation is unrestricted. See {@link CheckEnvLimitFn}.
   */
  checkEnvLimit?: CheckEnvLimitFn;
}

export interface CreateDefaultEnvironmentInput {
  tenantId: string;
  appId: string;
  /** Profile id of the actor (FK target for created_by). */
  actorId: string | null;
}

export interface CreateEnvironmentInput {
  tenantId: string;
  appId: string;
  name: string;
  actorId: string | null;
}

export type CreateEnvironmentResult =
  | { ok: true; environment: Environment }
  | {
      ok: false;
      code:
        | 'env_name_invalid'
        | 'env_name_conflict'
        | 'env_limit_exceeded';
      message: string;
      /** Populated only for `env_limit_exceeded` — surfaces the tier ceiling. */
      limit?: number;
      tierName?: string;
    };

export interface DeleteEnvironmentInput {
  tenantId: string;
  envId: string;
  /** User types env name to confirm. */
  confirmationName: string;
  actorId: string | null;
}

export interface DeleteEnvironmentCascade {
  api_keys_revoked: number;
  alerts_deleted: number;
  deployments_deleted: number;
  /** Always false — an environment owns no runtime to destroy. Kept so
   *  existing clients still parse, like the two counters above. */
  fly_app_destroyed: boolean;
}

export type DeleteEnvironmentResult =
  | { ok: true; cascade: DeleteEnvironmentCascade }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'env_default_cannot_delete'
        | 'env_confirmation_mismatch';
      message: string;
    };

export class EnvironmentService {
  constructor(private readonly deps: EnvironmentServiceDeps) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * List environments for an app, default env first.
   *
   * When `page` is supplied, the limit/offset are pushed into PostgREST
   * (`.range`) and an exact `total` is returned via `{ count: 'exact' }` — the
   * caller never pages in memory. When omitted, ALL rows are returned and
   * `total` equals the row count.
   */
  async listEnvironments(
    appId: string,
    page?: { limit: number; offset: number },
  ): Promise<{ rows: Environment[]; total: number }> {
    let query = this.client('environment')
      .select(ENVIRONMENT_COLUMNS, { count: 'exact' })
      .eq('app_id', appId)
      .order('is_default', { ascending: false }) // default env first
      .order('created_at', { ascending: true });

    if (page) {
      query = query.range(page.offset, page.offset + page.limit - 1);
    }

    const { data, error, count } = await query;

    if (error) {
      // PostgREST returns PGRST103 ("Requested range not satisfiable") when
      // `offset` is past the end of the result set. REST pagination convention
      // (and our OpenAPI contract) is an empty page + true total, not 500.
      // Re-query head-only to recover the actual count.
      if (error.code === 'PGRST103') {
        const { count: totalCount, error: countErr } = await this.client('environment')
          .select(ENVIRONMENT_COLUMNS, { count: 'exact', head: true })
          .eq('app_id', appId);
        if (countErr) {
          throw new Error(
            `listEnvironments(${appId}) count failed: ${countErr.message}`,
          );
        }
        return { rows: [], total: totalCount ?? 0 };
      }
      throw new Error(`listEnvironments(${appId}) failed: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as Environment[];
    return { rows, total: count ?? rows.length };
  }

  async getEnvironment(envId: string): Promise<Environment | null> {
    const { data, error } = await this.client('environment')
      .select(ENVIRONMENT_COLUMNS)
      .eq('id', envId)
      .maybeSingle();

    if (error) {
      throw new Error(`getEnvironment(${envId}) failed: ${error.message}`);
    }
    if (!data) return null;
    return data as unknown as Environment;
  }

  /**
   * FROZEN: there is no env-promotion saga and no `deployment` table for this
   * to query, so it always resolves `null` — no env can have an in-flight
   * saga. It remains a method so `in_flight_saga_id` keeps its place in the
   * gateway's wire contract; the field is permanently `null`.
   */
  async getInFlightSaga(_envId: string): Promise<null> {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Default env auto-create (called from app-creation server action)
  // ---------------------------------------------------------------------------

  /**
   * Every app has exactly one default env, in the
   * no-pin state, named `dev`. Does NOT provision a Fly app — the default env
   * has no pinned content to run, so the runtime is allocated lazily when a
   * non-default env is created or a promote targets a real runtime.
   *
   * Idempotent: as of the `on_create_seed_default_env` trigger (migration
   * 20260529221911), the default env is seeded automatically in the same
   * transaction as the app row, so by the time an explicit caller reaches here
   * the `dev` row usually already exists. This method therefore *ensures* the
   * default env exists rather than asserting it inserts exactly once — a unique
   * violation is resolved by returning the existing row.
   */
  async createDefaultEnvironment(
    input: CreateDefaultEnvironmentInput,
  ): Promise<Environment> {
    const { data, error } = await this.client('environment')
      .insert({
        tenant_id: input.tenantId,
        app_id: input.appId,
        name: 'dev',
        is_default: true,
        fly_app_name: null,
        created_by: input.actorId,
      })
      .select(ENVIRONMENT_COLUMNS)
      .single();

    if (!error) {
      return data as unknown as Environment;
    }

    // 23505 = unique_violation: the default `dev` env already exists for this
    // app (the seed trigger ran, or a prior call). Treat as success and return
    // the existing row — see the "ensures, not inserts-once" note above.
    if (error.code === '23505') {
      const existing = await this.client('environment')
        .select(ENVIRONMENT_COLUMNS)
        .eq('app_id', input.appId)
        .eq('is_default', true)
        .single();
      if (!existing.error && existing.data) {
        return existing.data as unknown as Environment;
      }
    }

    throw new Error(
      `createDefaultEnvironment failed for app ${input.appId}: ${error.message}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Create non-default env
  // ---------------------------------------------------------------------------

  async createEnvironment(
    input: CreateEnvironmentInput,
  ): Promise<CreateEnvironmentResult> {
    // 1. Validate the name before any DB write.
    const validation = validateEnvironmentName(input.name);
    if (!validation.valid) {
      return {
        ok: false,
        code: 'env_name_invalid',
        message: validation.message,
      };
    }

    // 1a. Entitlement gate (`max_environments_per_app`). Runs before
    //     any DB write or Fly call so a tier-capped tenant is rejected cleanly.
    //     The check is an injected dep — see {@link CheckEnvLimitFn}. When the
    //     dep is not wired, env creation is unrestricted.
    if (this.deps.checkEnvLimit) {
      const currentCount = await this.countEnvironments(input.appId);
      const limitCheck = await this.deps.checkEnvLimit({
        tenantId: input.tenantId,
        appId: input.appId,
        currentCount,
      });
      if (!limitCheck.allowed) {
        // User-facing copy: no internal identifiers or spec tags belong in
        // this string — a raw marker leaked into the dashboard's error alert
        // once before. Tier name is included when known
        // so the message names the plan the user is on
        // ("…limit (1) on the hobby tier — upgrade…").
        return {
          ok: false,
          code: 'env_limit_exceeded',
          message: `App has reached its environment limit (${limitCheck.limit})${
            limitCheck.tierName ? ` on the ${limitCheck.tierName} tier` : ''
          } — upgrade to add more.`,
          limit: limitCheck.limit,
          tierName: limitCheck.tierName,
        };
      }
    }

    // 2. Insert the env row. A single write: an environment is a scoping
    //    record (name, keys, env vars, traces, RLS), not a piece of
    //    infrastructure, so there is no external system to keep in step.
    const insertResult = await this.client('environment')
      .insert({
        tenant_id: input.tenantId,
        app_id: input.appId,
        name: input.name,
        is_default: false,
        fly_app_name: null,
        created_by: input.actorId,
      })
      .select(ENVIRONMENT_COLUMNS)
      .single();

    if (insertResult.error) {
      // 23505 = unique_violation (Postgres) — name already taken in this app.
      if (insertResult.error.code === '23505') {
        return {
          ok: false,
          code: 'env_name_conflict',
          message: `Environment named "${input.name}" already exists on this app`,
        };
      }
      throw new Error(
        `createEnvironment(${input.appId}/${input.name}) insert failed: ${insertResult.error.message}`,
      );
    }
    const envRow = insertResult.data as unknown as Environment;

    return {
      ok: true,
      environment: envRow,
    };
  }

  // ---------------------------------------------------------------------------
  // Delete env
  // ---------------------------------------------------------------------------

  async deleteEnvironment(
    input: DeleteEnvironmentInput,
  ): Promise<DeleteEnvironmentResult> {
    // 1. Look up the env. RLS won't apply (service-role); we just need the row.
    const env = await this.getEnvironment(input.envId);
    if (!env || env.tenant_id !== input.tenantId) {
      return {
        ok: false,
        code: 'not_found',
        message: `Environment ${input.envId} not found in this tenant`,
      };
    }

    // 2. Default-env protection. Server-side guard in addition
    //    to the trigger-level RAISE.
    if (env.is_default) {
      return {
        ok: false,
        code: 'env_default_cannot_delete',
        message: 'The default environment cannot be deleted',
      };
    }

    // 3. Confirmation name match. Case-sensitive — names are
    //    lowercase by validation, so this is straightforward.
    if (input.confirmationName !== env.name) {
      return {
        ok: false,
        code: 'env_confirmation_mismatch',
        message: 'Confirmation name does not match the environment name',
      };
    }

    // 4. Collect cascade preview counts before DELETE for the response body.
    const cascade = await this.computeCascade(input.envId);

    // 5. DELETE the env row. CASCADE on the api_key FK handles the keys.
    const { error: deleteError } = await this.client('environment')
      .delete()
      .eq('id', input.envId);

    if (deleteError) {
      throw new Error(
        `deleteEnvironment(${input.envId}) DELETE failed: ${deleteError.message}`,
      );
    }

    return {
      ok: true,
      cascade: { ...cascade, fly_app_destroyed: false },
    };
  }

  // ---------------------------------------------------------------------------
  // Cascade preview (used by both GET /v1/environments/:id and delete)
  // ---------------------------------------------------------------------------

  async computeCascade(
    envId: string,
  ): Promise<Omit<DeleteEnvironmentCascade, 'fly_app_destroyed'>> {
    const apiKeys = await this.countRows('api_key', envId);

    return {
      api_keys_revoked: apiKeys,
      // FROZEN at 0: the `alert` and `deployment` tables these counted are
      // gone, and nothing can write a row scoped to this env again. The fields
      // stay in the response so existing clients keep parsing it.
      alerts_deleted: 0,
      deployments_deleted: 0,
    };
  }

  /**
   * Count of user-created `environment` rows for an app (env-limit check
   * input).
   *
   * Ephemeral preview envs are EXCLUDED: they are system-created (one per open
   * PR, torn down on PR close) and are not part of the user's persistent
   * environment allotment. Counting them would let a tenant with several open
   * PRs hit `max_environments_per_app` and be refused creation of a legitimate
   * persistent env — and could block preview creation itself on a capped tier.
   * The cap governs the durable envs a user owns, not transient PR previews.
   */
  private async countEnvironments(appId: string): Promise<number> {
    const { count, error } = await this.client('environment')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', appId)
      .eq('is_ephemeral', false);
    if (error) {
      throw new Error(
        `countEnvironments(${appId}) failed: ${error.message}`,
      );
    }
    return count ?? 0;
  }

  private async countRows(table: string, envId: string): Promise<number> {
    const { count, error } = await this.client(table)
      .select('id', { count: 'exact', head: true })
      .eq('environment_id', envId);
    if (error) {
      throw new Error(`countRows(${table}, ${envId}) failed: ${error.message}`);
    }
    return count ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Cast helper — `from()` is untyped against the post-feature schema until
   *  `yarn codegen:db` runs. Replace with the typed call afterward. */
  private client(table: string): ReturnType<SupabaseClient['from']> {
    return this.deps.supabase.from(table);
  }
}
