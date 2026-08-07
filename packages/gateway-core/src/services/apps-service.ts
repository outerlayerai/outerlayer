/**
 * Apps service — Supabase-backed CRUD over `public.app`.
 *
 * Powers the public `/v1/apps/*` surface. Designed primarily for headless
 * agent provisioning (no dashboard UI), but also feeds the dashboard's
 * apps-page client so there is one source of truth.
 *
 * Tenant isolation:
 *   - RLS on `app` filters by `tenant_id = public.tenant_id()` for the
 *     gateway role. The route handlers also pass `tenantId` explicitly
 *     as defense-in-depth so a misconfigured policy can't leak rows.
 *   - Bearer auth routes through the dashboard's existing
 *     `app_authorize()` policies (no gateway-role permission translation).
 *
 * What this service does NOT do:
 *   - Unkey API key cleanup on delete — kept on the dashboard side in
 *     `sections/apps/actions.ts::deleteApiKeysForApp` so we don't have
 *     to introduce an outbound Unkey call from a Cloudflare Worker.
 *     The dashboard client orchestrates: gateway DELETE row → existing
 *     Unkey sweep server action. Headless callers without dashboard
 *     access will leave orphan Unkey keys until a separate sweep runs.
 *   - Entitlement / quota enforcement — handled by the gateway's
 *     `enforceQuota` middleware in `openapi/index.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  App,
  AppRuntime,
  CreateAppBody,
  GitConnectionStatus,
  LinkAppRepositoryResult,
  UpdateAppBody,
} from '@repo/api-schemas';
import type { GitFileProvider } from '../git/types';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class AppNotFoundError extends Error {
  constructor(message = 'App not found') {
    super(message);
    this.name = 'AppNotFoundError';
  }
}

export class DuplicateAppNameError extends Error {
  constructor(name: string) {
    super(`App with name "${name}" already exists for this tenant`);
    this.name = 'DuplicateAppNameError';
  }
}

/**
 * Raised by link/unlink/list-repos/list-branches when the app has no
 * `git_connection` row yet. Callers should mint an install URL via
 * `POST /v1/apps/:appId/git/connect` and have a human complete the
 * OAuth handshake before retrying.
 */
export class GitConnectionMissingError extends Error {
  constructor(appId: string) {
    super(`No git connection for app ${appId}. Complete the OAuth install first.`);
    this.name = 'GitConnectionMissingError';
  }
}

/**
 * Raised by linkRepository when the requested repo+branch pair is already
 * watched by another app in the same tenant. `git_branch` enforces
 * `UNIQUE (repo, branch_name, tenant_id)` because the push webhook maps
 * repo+branch to a single app — two apps cannot watch the same branch.
 */
export class RepoBranchAlreadyLinkedError extends Error {
  constructor(repository: string, branch: string) {
    super(
      `Branch "${branch}" of ${repository} is already linked to another app in your organization. Unlink it from that app first, or choose a different branch.`,
    );
    this.name = 'RepoBranchAlreadyLinkedError';
  }
}

// ---------------------------------------------------------------------------
// Row → API transformer
//
// The app table has more columns than the API exposes (we intentionally
// hide nothing here — all readable columns flow through). The transformer
// exists so the API contract is decoupled from whatever the DB happens
// to store today.
// ---------------------------------------------------------------------------

interface AppRow {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string | null;
  runtime: string | null;
  entry_point: string | null;
  commit_sha: string | null;
  created_at: string | null;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

function toApp(row: AppRow): App {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    display_name: row.display_name,
    runtime: row.runtime as AppRuntime | null,
    entry_point: row.entry_point,
    commit_sha: row.commit_sha,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ListAppsOptions {
  name?: string;
  limit: number;
  offset: number;
}

export class AppsService {
  constructor(private readonly supabase: SupabaseClient<any, any>) {}

  async listApps(
    tenantId: string,
    options: ListAppsOptions,
  ): Promise<{ data: App[]; total: number }> {
    let query = this.supabase
      .from('app')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId);

    if (options.name) query = query.eq('name', options.name);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(options.offset, options.offset + options.limit - 1);

    // PGRST103 — range start past total. Same empty-page-overflow handling
    // as alerts/api-keys/deployments.
    if (error && (error as { code?: string }).code === 'PGRST103') {
      return { data: [], total: count ?? 0 };
    }
    if (error) throw error;
    return {
      data: (data ?? []).map((row) => toApp(row as AppRow)),
      total: count ?? 0,
    };
  }

  async getApp(tenantId: string, appId: string): Promise<App> {
    const { data, error } = await this.supabase
      .from('app')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', appId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new AppNotFoundError();
    return toApp(data as AppRow);
  }

  async createApp(
    tenantId: string,
    input: CreateAppBody,
    userId: string | null = null,
  ): Promise<App> {
    // Same attribution + RETAINED retry net as alerts (deliberate, not dead).
    // Set `created_by` explicitly: the bearer user for a human request,
    // NULL for a machine write. There is no `DEFAULT auth.uid()` on this
    // column, because a gateway-role default resolves to the JWT sub rather
    // than a real profile; the trigger nulls an omitted value. The retry below
    // guards the case where a non-null userId names a profile that does not
    // exist. The column is ON DELETE SET NULL, so NULL is a valid
    // steady-state for headless agents.
    const buildPayload = (createdBy: string | null) => ({
      tenant_id: tenantId,
      name: input.name,
      display_name: input.display_name ?? null,
      runtime: input.runtime ?? 'nodejs',
      entry_point: input.entry_point ?? null,
      created_by: createdBy,
    });

    let { data, error } = await this.supabase
      .from('app')
      .insert(buildPayload(userId))
      .select('*')
      .single();

    if (
      error &&
      userId !== null &&
      this.isFkViolation(error, 'app_created_by_fkey')
    ) {
      const retry = await this.supabase
        .from('app')
        .insert(buildPayload(null))
        .select('*')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      if (this.isUniqueViolation(error, 'unique_name_per_tenant')) {
        throw new DuplicateAppNameError(input.name);
      }
      throw error;
    }
    return toApp(data as AppRow);
  }

  async updateApp(
    tenantId: string,
    appId: string,
    input: UpdateAppBody,
    userId: string | null = null,
  ): Promise<App> {
    // Distinguish "not found" from "RLS denied update" by reading first.
    // Same pattern as alerts.
    await this.getApp(tenantId, appId);

    // Build a sparse payload: only include fields the caller actually sent.
    // Avoids overwriting `entry_point: null` if they only meant to rename.
    const buildPayload = (updatedBy: string | null) => {
      const payload: Record<string, unknown> = { updated_by: updatedBy };
      if (input.name !== undefined) payload.name = input.name;
      if (input.display_name !== undefined) payload.display_name = input.display_name;
      if (input.runtime !== undefined) payload.runtime = input.runtime;
      if (input.entry_point !== undefined) payload.entry_point = input.entry_point;
      return payload;
    };

    let { data, error } = await this.supabase
      .from('app')
      .update(buildPayload(userId))
      .eq('tenant_id', tenantId)
      .eq('id', appId)
      .select('*')
      .single();

    if (
      error &&
      userId !== null &&
      this.isFkViolation(error, 'app_updated_by_fkey')
    ) {
      const retry = await this.supabase
        .from('app')
        .update(buildPayload(null))
        .eq('tenant_id', tenantId)
        .eq('id', appId)
        .select('*')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      if (this.isUniqueViolation(error, 'unique_name_per_tenant')) {
        throw new DuplicateAppNameError(input.name ?? '<unknown>');
      }
      throw error;
    }
    return toApp(data as AppRow);
  }

  /**
   * Read git connection status for an app. Returns `connected: false` with
   * null fields when no row exists yet. Used by headless callers polling
   * after a human has been pointed at the OAuth install URL.
   *
   * Joins `git_connection` (provider/repo/installation) with `git_branch`
   * (watched branch) on `app_id`. Both tables are gateway-readable.
   */
  async getGitConnection(
    tenantId: string,
    appId: string,
  ): Promise<GitConnectionStatus> {
    // Confirm the app exists in this tenant first — otherwise a poller
    // with a stale appId would get `connected: false` and silently retry
    // forever instead of seeing a 404.
    await this.getApp(tenantId, appId);

    const { data: connection, error: connErr } = await this.supabase
      .from('git_connection')
      .select('provider, repository, installation_id')
      .eq('app_id', appId)
      .maybeSingle();
    if (connErr) throw connErr;

    if (!connection) {
      return {
        connected: false,
        provider: null,
        repository: null,
        branch: null,
        installation_id: null,
      };
    }

    // Latest git_branch row (one per repo today; ordered to be safe).
    const { data: branchRow, error: branchErr } = await this.supabase
      .from('git_branch')
      .select('branch_name')
      .eq('app_id', appId)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (branchErr && (branchErr as { code?: string }).code !== 'PGRST116') {
      throw branchErr;
    }

    // `connected` = the OAuth handshake completed and a `git_connection`
    // row exists. The row carries `installation_id` once GitHub's App
    // install completes. A row may exist before a repository is picked —
    // that still counts as "connected". `provider` reads whatever the DB
    // carries (including a legacy value the schema still allows), not the
    // narrower set a new connect request may target.
    return {
      connected: true,
      provider: connection.provider as GitConnectionStatus['provider'],
      repository: connection.repository ?? null,
      branch: branchRow?.branch_name ?? null,
      installation_id: connection.installation_id ?? null,
    };
  }

  /**
   * Link a repository + branch to an app.
   *
   * Writes `git_connection.repository` (the row already exists from
   * the OAuth callback) and upserts a `git_branch` row keyed by
   * `app_id`. Also seeds `app.commit_sha` with the latest commit on
   * the chosen branch when the provider can supply one — that gives
   * dashboards a non-null "current commit" display before the first
   * deploy runs.
   *
   * Does NOT trigger an initial template import inline. The first
   * git push to `branch` runs the existing webhook orchestrator,
   * which materializes templates + datasets. Headless agents push a
   * starter commit (or trigger a fresh deploy via `POST /v1/apps/:appId/git/sync`
   * in a follow-up PR) to populate the app.
   */
  async linkRepository(
    tenantId: string,
    appId: string,
    input: { repository: string; branch: string },
    provider: GitFileProvider,
    userId: string | null = null,
  ): Promise<LinkAppRepositoryResult> {
    // Confirm the app exists in this tenant. Without this, a stale
    // appId would 404 silently when the git_connection update affects
    // zero rows.
    await this.getApp(tenantId, appId);

    // Confirm the provider OAuth handshake has happened. Otherwise the
    // git_connection update below would silently match no row.
    const { data: connection, error: connErr } = await this.supabase
      .from('git_connection')
      .select('app_id, provider')
      .eq('app_id', appId)
      .maybeSingle();
    if (connErr) throw connErr;
    if (!connection) throw new GitConnectionMissingError(appId);

    // Auxiliary fetch — link should succeed even if this fails.
    const commitSha = await provider.getLatestCommitSha(input.repository, input.branch);

    // Stamp the repository onto the existing git_connection row.
    const { error: updErr } = await this.supabase
      .from('git_connection')
      .update({ repository: input.repository })
      .eq('app_id', appId);
    if (updErr) throw updErr;

    // Upsert git_branch. There's one row per app today (the schema
    // technically allows multiple via the `branch_name`/`repo`
    // composite but the dashboard pattern is "single watched branch
    // per app" so we mirror it).
    const { data: existing, error: existingErr } = await this.supabase
      .from('git_branch')
      .select('id')
      .eq('app_id', appId)
      .maybeSingle();
    if (existingErr && (existingErr as { code?: string }).code !== 'PGRST116') {
      throw existingErr;
    }

    let branchId: string;
    if (existing?.id) {
      const { error: branchUpdErr } = await this.supabase
        .from('git_branch')
        .update({ branch_name: input.branch, repo: input.repository })
        .eq('app_id', appId);
      if (branchUpdErr) {
        if (this.isUniqueViolation(branchUpdErr, 'unique_git_repo_branch_constraint')) {
          throw new RepoBranchAlreadyLinkedError(input.repository, input.branch);
        }
        throw branchUpdErr;
      }
      branchId = existing.id;
    } else {
      // Same FK-retry pattern as createApp:
      // `git_branch.created_by` defaults to `auth.uid()` which under the
      // gateway-role JWT resolves to the system user id — that id has
      // no `profile` row, so the FK to `profile(id)` (constraint
      // `git_branch_created_by_fkey`) fires. The column is
      // ON DELETE SET NULL, so explicit null is a valid steady state
      // for headless API-key callers. We try with userId first to
      // preserve attribution for bearer-auth callers (who DO have a
      // profile), and fall back to null only when the FK fails.
      const buildBranchPayload = (createdBy: string | null) => ({
        app_id: appId,
        tenant_id: tenantId,
        branch_name: input.branch,
        repo: input.repository,
        created_by: createdBy,
      });

      let inserted: { id: string } | null;
      let insErr: unknown;
      ({ data: inserted, error: insErr } = await this.supabase
        .from('git_branch')
        .insert(buildBranchPayload(userId))
        .select('id')
        .single());

      if (
        insErr &&
        userId !== null &&
        this.isFkViolation(insErr, 'git_branch_created_by_fkey')
      ) {
        const retry = await this.supabase
          .from('git_branch')
          .insert(buildBranchPayload(null))
          .select('id')
          .single();
        inserted = retry.data;
        insErr = retry.error;
      }
      if (insErr) {
        if (this.isUniqueViolation(insErr, 'unique_git_repo_branch_constraint')) {
          throw new RepoBranchAlreadyLinkedError(input.repository, input.branch);
        }
        throw insErr;
      }
      branchId = (inserted as { id: string }).id;
    }

    // Best-effort seed of the commit SHA. The deploy webhook will
    // overwrite this on the next push.
    if (commitSha) {
      const { error: shaErr } = await this.supabase
        .from('app')
        .update({ commit_sha: commitSha })
        .eq('id', appId);
      // Don't fail the whole call if this update misses — the SHA is
      // a display hint, and the deploy pipeline does not read it.
      if (shaErr) {
        console.warn('[apps-service] failed to seed commit_sha', {
          appId,
          message: (shaErr as Error)?.message,
        });
      }
    }

    return {
      repository: input.repository,
      branch: input.branch,
      branch_id: branchId,
      commit_sha: commitSha,
    };
  }

  /**
   * Clear the linked repository + branch.
   *
   * Resets `git_connection.repository` to `null` and removes the
   * `git_branch` row. The underlying OAuth install (GitHub
   * `installation_id`) is preserved so the user can re-link without
   * re-clicking the install URL.
   *
   * Does NOT delete template rows or storage objects today — those
   * writes need an admin Supabase client (RLS-scoped clients can't
   * reliably purge per-tenant storage paths). Template cleanup will
   * land in a follow-up endpoint or via the existing dashboard
   * `removeGitFiles` server action.
   */
  async unlinkRepository(tenantId: string, appId: string): Promise<void> {
    await this.getApp(tenantId, appId);

    const { data: connection, error: connErr } = await this.supabase
      .from('git_connection')
      .select('app_id')
      .eq('app_id', appId)
      .maybeSingle();
    if (connErr) throw connErr;
    if (!connection) throw new GitConnectionMissingError(appId);

    const { error: updErr } = await this.supabase
      .from('git_connection')
      .update({ repository: null })
      .eq('app_id', appId);
    if (updErr) throw updErr;

    const { error: delErr } = await this.supabase
      .from('git_branch')
      .delete()
      .eq('app_id', appId);
    if (delErr) throw delErr;
  }

  async deleteApp(tenantId: string, appId: string): Promise<void> {
    // Confirm existence so we return 404 instead of a silent no-op when
    // the caller has a stale ID. RLS would also let the DELETE succeed-as-
    // zero-rows; the explicit read makes the error path observable.
    await this.getApp(tenantId, appId);

    // Cascade behavior is enforced at the DB layer via ON DELETE CASCADE
    // on every child table that references app(id) — git_connection,
    // git_branch, api_key, environment, and so on. We do NOT
    // clean up Unkey-side API key rows here; the dashboard wraps this
    // call with a separate `deleteApiKeysForApp` server action so the
    // Unkey-SDK dependency stays out of the Cloudflare Worker bundle.
    // Headless callers without dashboard access will leave orphan Unkey
    // rows, slated for a background sweep job.
    const { error } = await this.supabase
      .from('app')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', appId);

    if (error) throw error;
  }

  // -------------------------------------------------------------------------
  // Helpers — same shape as AlertsService.
  // -------------------------------------------------------------------------

  private isFkViolation(error: unknown, constraintName: string): boolean {
    const e = error as { code?: string; details?: string; message?: string };
    if (e.code !== '23503') return false;
    return (
      (e.details?.includes(constraintName) ?? false) ||
      (e.message?.includes(constraintName) ?? false)
    );
  }

  private isUniqueViolation(error: unknown, constraintName: string): boolean {
    const e = error as { code?: string; details?: string; message?: string };
    if (e.code !== '23505') return false;
    return (
      (e.details?.includes(constraintName) ?? false) ||
      (e.message?.includes(constraintName) ?? false)
    );
  }
}
