/**
 * WorkersService — the dashboard-facing (user-RLS) surface for cloud worker
 * runs and persistent workspaces. Every method runs its queries through the
 * caller's RLS-scoped `ctx.db`: the `worker_run.read` / `worker_run.insert` /
 * `worker_run.update` policies plus the tenant match are enforced by the DB, so
 * a row outside the caller's tenant is indistinguishable from a missing one (no
 * oracle). The service opens no client of its own and reads no request state —
 * `ServiceContext` carries the tenant-scoped client and the actor.
 *
 * Worker-side transitions (running/pushing/terminal), Vault secret staging, and
 * Fly coordination are service-role machine work and live outside this service;
 * this surface is create / read / user-initiated cancel only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";

import type {
  CancelledWorkerRun,
  CreateWorkerRunInput,
  CreateWorkerWorkspaceInput,
  CreatedWorkerRun,
  CreatedWorkerWorkspace,
  WorkerRunAttachmentMeta,
  WorkerRunDetail,
  WorkerRunEvent,
  WorkerRunSummary,
  WorkerWorkspaceSummary,
} from "./types";

const NON_TERMINAL_STATUSES = ["queued", "provisioning", "running", "pushing"] as const;

/**
 * Project the runner-bound attachments (with content) down to the metadata the
 * run row stores — name/type/size only; the bytes ride to the runner in the
 * dispatch params and are never persisted. The base64 length maps to the
 * decoded size exactly, since validation upstream guarantees well-formed content.
 */
export function attachmentMetaFrom(
  attachments: Array<{ name: string; mime: string; content: string }> | undefined,
): WorkerRunAttachmentMeta[] {
  return (attachments ?? []).map((a) => ({
    name: a.name,
    mime: a.mime,
    size_bytes:
      Math.floor((a.content.length / 4) * 3) -
      (a.content.endsWith("==") ? 2 : a.content.endsWith("=") ? 1 : 0),
  }));
}

/**
 * List/thread projection — the columns the history list and the environment
 * turn thread render. Omits `raw_log` and the dispatch/machine internals so a
 * history row stays light.
 */
const RUN_SUMMARY_COLUMNS =
  "id, agent, model, task_prompt, attachments, status, outcome, branch_name, pr_url, pr_number, failure_code, error_message, duration_ms, created_at";

/** Run-detail projection — the summary plus the fields the detail view adds. */
const RUN_DETAIL_COLUMNS = `${RUN_SUMMARY_COLUMNS}, base_branch, cost_usd, num_turns, workspace_id`;

const WORKSPACE_SUMMARY_COLUMNS =
  "id, agent, model, base_branch, work_branch, substrate, status, current_run_id, session_ref, last_active_at, created_at";

const RUN_EVENT_COLUMNS = "seq, event_type, payload, created_at";

class WorkersService {
  /** Run history for an app, newest-first — the Workers list. */
  async listRuns(ctx: ServiceContext, appId: string, limit = 50): Promise<WorkerRunSummary[]> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_run")
      .select(RUN_SUMMARY_COLUMNS)
      .eq("app_id", appId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`worker_run list failed: ${error.message}`);
    return (data ?? []) as unknown as WorkerRunSummary[];
  }

  /** One run's detail, or null when no row is visible under RLS. */
  async getRun(ctx: ServiceContext, appId: string, runId: string): Promise<WorkerRunDetail | null> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_run")
      .select(RUN_DETAIL_COLUMNS)
      .eq("app_id", appId)
      .eq("id", runId)
      .maybeSingle();
    if (error) throw new Error(`worker_run get failed: ${error.message}`);
    return (data as unknown as WorkerRunDetail) ?? null;
  }

  /**
   * A run's normalized transcript, seq-ascending, for events after `afterSeq`
   * (default all). RLS-gated on `worker_run.read` via the parent app_id.
   */
  async getRunEvents(ctx: ServiceContext, runId: string, afterSeq = -1): Promise<WorkerRunEvent[]> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_run_event")
      .select(RUN_EVENT_COLUMNS)
      .eq("worker_run_id", runId)
      .gt("seq", Number.isFinite(afterSeq) ? afterSeq : -1)
      .order("seq", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`worker_run_event list failed: ${error.message}`);
    return (data ?? []) as unknown as WorkerRunEvent[];
  }

  /** An app's live (non-destroyed) workspaces, newest-first. */
  async listWorkspaces(
    ctx: ServiceContext,
    appId: string,
    limit = 50,
  ): Promise<WorkerWorkspaceSummary[]> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_workspace")
      .select(WORKSPACE_SUMMARY_COLUMNS)
      .eq("app_id", appId)
      .neq("status", "destroyed")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`worker_workspace list failed: ${error.message}`);
    return (data ?? []) as unknown as WorkerWorkspaceSummary[];
  }

  /** One workspace, or null when no row is visible under RLS. */
  async getWorkspace(
    ctx: ServiceContext,
    appId: string,
    workspaceId: string,
  ): Promise<WorkerWorkspaceSummary | null> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_workspace")
      .select(WORKSPACE_SUMMARY_COLUMNS)
      .eq("app_id", appId)
      .eq("id", workspaceId)
      .maybeSingle();
    if (error) throw new Error(`worker_workspace get failed: ${error.message}`);
    return (data as unknown as WorkerWorkspaceSummary) ?? null;
  }

  /** A workspace's turns, oldest-first — the thread. */
  async listRunsByWorkspace(
    ctx: ServiceContext,
    appId: string,
    workspaceId: string,
  ): Promise<WorkerRunSummary[]> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_run")
      .select(RUN_SUMMARY_COLUMNS)
      .eq("app_id", appId)
      .eq("workspace_id", workspaceId)
      .order("turn_index", { ascending: true });
    if (error) throw new Error(`worker_run thread list failed: ${error.message}`);
    return (data ?? []) as unknown as WorkerRunSummary[];
  }

  /** The app's default environment id, or null when it has none. */
  async defaultEnvironmentId(ctx: ServiceContext, appId: string): Promise<string | null> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("environment")
      .select("id")
      .eq("app_id", appId)
      .eq("is_default", true)
      .maybeSingle();
    if (error) throw new Error(`default environment lookup failed: ${error.message}`);
    return (data?.id as string | undefined) ?? null;
  }

  /**
   * Persist a queued run under the request tenant. The RLS INSERT policy admits
   * the actor only for an app it holds `worker_run.insert` on and only for its
   * own tenant, so `tenant_id` is stamped from the resolved context (the table
   * has no set_* trigger).
   */
  async createRun(ctx: ServiceContext, input: CreateWorkerRunInput): Promise<CreatedWorkerRun> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_run")
      .insert({
        app_id: input.appId,
        tenant_id: ctx.tenantId,
        environment_id: input.environmentId,
        created_by: input.createdBy,
        agent: input.agent,
        model: input.model,
        task_prompt: input.taskPrompt,
        attachments: input.attachments,
        base_branch: input.baseBranch,
        dispatch: input.dispatch,
        wall_clock_cap_s: input.wallClockCapS,
        status: "queued",
      })
      .select("id, status, dispatch")
      .single();
    if (error) throw new Error(`worker_run create failed: ${error.message}`);
    return data as unknown as CreatedWorkerRun;
  }

  /**
   * Persist a workspace shell under the request tenant. Its durable paths
   * (work_branch / workspace_ref) are set by the machine step once the id is
   * known, so the RLS insert stays free of compute detail.
   */
  async createWorkspace(
    ctx: ServiceContext,
    input: CreateWorkerWorkspaceInput,
  ): Promise<CreatedWorkerWorkspace> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_workspace")
      .insert({
        app_id: input.appId,
        tenant_id: ctx.tenantId,
        environment_id: input.environmentId,
        created_by: input.createdBy,
        agent: input.agent,
        model: input.model,
        base_branch: input.baseBranch,
        substrate: input.substrate,
        status: "creating",
      })
      .select("id, substrate")
      .single();
    if (error) throw new Error(`worker_workspace create failed: ${error.message}`);
    return data as unknown as CreatedWorkerWorkspace;
  }

  /**
   * User-initiated cancel. Moves a non-terminal run to cancelled; the
   * `.in(non-terminal)` filter makes a late cancel against a completion race a
   * no-op (returns null), same as a run RLS can't see. The returned fields drive
   * the machine teardown.
   */
  async cancelRun(ctx: ServiceContext, appId: string, runId: string): Promise<CancelledWorkerRun | null> {
    const db = ctx.db as SupabaseClient;
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("worker_run")
      .update({ status: "cancelled", completed_at: now, updated_at: now })
      .eq("app_id", appId)
      .eq("id", runId)
      .in("status", NON_TERMINAL_STATUSES as unknown as string[])
      .select("id, dispatch, machine_id, workspace_id")
      .maybeSingle();
    if (error) throw new Error(`worker_run cancel failed: ${error.message}`);
    return (data as unknown as CancelledWorkerRun) ?? null;
  }

  /** The tenant's in-flight run count — the concurrency entitlement input. */
  async countActiveRuns(ctx: ServiceContext): Promise<number> {
    const db = ctx.db as SupabaseClient;
    const { count, error } = await db
      .from("worker_run")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId)
      .in("status", NON_TERMINAL_STATUSES as unknown as string[]);
    if (error) throw new Error(`worker_run active count failed: ${error.message}`);
    return count ?? 0;
  }

  /** The tenant's live (non-destroyed) workspace count — the environment cap input. */
  async countActiveWorkspaces(ctx: ServiceContext): Promise<number> {
    const db = ctx.db as SupabaseClient;
    const { count, error } = await db
      .from("worker_workspace")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId)
      .neq("status", "destroyed");
    if (error) throw new Error(`worker_workspace active count failed: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Minutes the tenant's runs have consumed since `sinceIso` — the monthly-cap
   * input. Sums `duration_ms` app-side over the returned rows. The exact
   * DB-side aggregate (a PostgREST `sum()` or a helper function) needs
   * aggregate exposure the project does not enable, or new DDL, so it belongs to
   * the standalone DB follow-up, not this app-side pass.
   */
  async sumRunDurationMsSince(ctx: ServiceContext, sinceIso: string): Promise<number> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("worker_run")
      .select("duration_ms")
      .eq("tenant_id", ctx.tenantId)
      .gte("created_at", sinceIso);
    if (error) throw new Error(`worker_run duration sum failed: ${error.message}`);
    return ((data as Array<{ duration_ms: number | null }>) ?? []).reduce(
      (acc, r) => acc + (r.duration_ms ?? 0),
      0,
    );
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const workersService = new WorkersService();
