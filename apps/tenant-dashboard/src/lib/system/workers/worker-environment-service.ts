import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Persistence for persistent worker environments.
 *
 * A worker_workspace owns durable compute (a local workspace in dev, an E2B
 * sandbox or suspend/resumable Fly machine in prod) across turns. Many
 * worker_run rows (turns) execute against one environment, serialized by the
 * current_run_id lock, resuming the agent session between turns.
 */

type WorkerEnvironmentStatus = "creating" | "active" | "suspended" | "destroyed";

export interface WorkerEnvironmentRow {
  id: string;
  tenant_id: string;
  app_id: string;
  environment_id: string | null;
  agent: string;
  /** Model this environment's turns run (adapter alias); NULL = CLI default. */
  model: string | null;
  base_branch: string;
  work_branch: string | null;
  substrate: "local" | "e2b" | "fly";
  machine_ref: string | null;
  workspace_ref: string | null;
  session_ref: string | null;
  status: WorkerEnvironmentStatus;
  current_run_id: string | null;
  idle_ttl_s: number;
  last_active_at: string | null;
  failure_reason: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
}

interface CreateEnvironmentInput {
  appId: string;
  tenantId: string;
  environmentId?: string | null;
  createdBy?: string | null;
  agent: string;
  model?: string | null;
  baseBranch: string;
  workBranch: string;
  substrate: "local" | "e2b" | "fly";
  workspaceRef: string;
}

type UntypedClient = SupabaseClient<any, any, any>;

export class WorkerEnvironmentService {
  constructor(private readonly supabase: UntypedClient) {}

  private table() {
    return this.supabase.from("worker_workspace");
  }

  async create(input: CreateEnvironmentInput): Promise<WorkerEnvironmentRow> {
    const { data, error } = await this.table()
      .insert({
        app_id: input.appId,
        tenant_id: input.tenantId,
        environment_id: input.environmentId ?? null,
        created_by: input.createdBy ?? null,
        agent: input.agent,
        model: input.model ?? null,
        base_branch: input.baseBranch,
        work_branch: input.workBranch,
        substrate: input.substrate,
        workspace_ref: input.workspaceRef,
        status: "creating",
      })
      .select("*")
      .single();
    if (error) throw new Error(`create worker_workspace failed: ${error.message}`);
    return data as WorkerEnvironmentRow;
  }

  async get(appId: string, envId: string): Promise<WorkerEnvironmentRow | null> {
    const { data, error } = await this.table().select("*").eq("app_id", appId).eq("id", envId).limit(1);
    if (error) throw new Error(`get worker_workspace failed: ${error.message}`);
    return ((data as WorkerEnvironmentRow[])?.[0] as WorkerEnvironmentRow) ?? null;
  }

  async list(appId: string, limit = 50): Promise<WorkerEnvironmentRow[]> {
    const { data, error } = await this.table()
      .select("*")
      .eq("app_id", appId)
      .neq("status", "destroyed")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`list worker_workspace failed: ${error.message}`);
    return (data as WorkerEnvironmentRow[]) ?? [];
  }

  /** Count a tenant's live (non-destroyed) environments — the entitlement input. */
  async countActiveForTenant(tenantId: string): Promise<number> {
    const { count, error } = await this.table()
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .neq("status", "destroyed");
    if (error) throw new Error(`count worker_workspace failed: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Acquire the single-turn lock: atomically set current_run_id iff the
   * environment is currently free (NULL) and not destroyed. Returns the row on
   * success, null if it was busy — so callers serialize turns per environment.
   */
  async acquireForTurn(appId: string, envId: string, runId: string): Promise<WorkerEnvironmentRow | null> {
    const { data, error } = await this.table()
      .update({ current_run_id: runId, status: "active", updated_at: new Date().toISOString() })
      .eq("app_id", appId)
      .eq("id", envId)
      .is("current_run_id", null)
      .neq("status", "destroyed")
      .select("*");
    if (error) throw new Error(`acquire worker_workspace failed: ${error.message}`);
    return ((data as WorkerEnvironmentRow[])?.[0] as WorkerEnvironmentRow) ?? null;
  }

  /**
   * Release the lock and persist the turn's result: the (possibly new) agent
   * session handle to resume next time, and last_active_at for the reaper.
   */
  async completeTurn(envId: string, sessionRef: string | null): Promise<void> {
    const patch: Record<string, unknown> = {
      current_run_id: null,
      last_active_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (sessionRef) patch.session_ref = sessionRef;
    const { error } = await this.table().update(patch).eq("id", envId);
    if (error) throw new Error(`complete worker_workspace turn failed: ${error.message}`);
  }

  async markMachine(envId: string, machineRef: string | null): Promise<void> {
    const { error } = await this.table()
      .update({ machine_ref: machineRef, updated_at: new Date().toISOString() })
      .eq("id", envId);
    if (error) throw new Error(`mark worker_workspace machine failed: ${error.message}`);
  }

  /**
   * Promote a `local` environment to `fly` once cloud workers become available
   * — the substrate is a cache of what compute existed at creation, not a
   * permanent pin. The local durable state (host tmpdir workspace + session
   * files) can't move onto a fresh Fly volume, so the workspace resets to the
   * volume path and the session handle is dropped; the promoting turn
   * re-clones and starts a fresh agent session (see dispatchEnvironmentTurn).
   * machine_ref is left to markMachine, which records the new machine.
   */
  async upgradeToFly(envId: string, workspaceRef: string): Promise<void> {
    const { error } = await this.table()
      .update({
        substrate: "fly",
        workspace_ref: workspaceRef,
        session_ref: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", envId);
    if (error) throw new Error(`upgrade worker_workspace substrate failed: ${error.message}`);
  }

  /** Terminal teardown — no longer counts against the environment cap. */
  async destroy(envId: string, reason?: string): Promise<void> {
    const { error } = await this.table()
      .update({
        status: "destroyed",
        current_run_id: null,
        failure_reason: reason ? reason.slice(0, 2000) : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", envId);
    if (error) throw new Error(`destroy worker_workspace failed: ${error.message}`);
  }

  async fail(envId: string, reason: string): Promise<void> {
    const { error } = await this.table()
      .update({
        status: "suspended",
        current_run_id: null,
        failure_reason: reason.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", envId);
    if (error) throw new Error(`fail worker_workspace failed: ${error.message}`);
  }
}
