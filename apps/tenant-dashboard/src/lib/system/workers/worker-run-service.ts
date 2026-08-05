import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Persistence for cloud worker runs. A run is created (queued) at
 * dispatch, moved through provisioning/running/pushing by the runner callbacks,
 * and reaches a terminal state (completed/failed/cancelled/timed_out). Backs the
 * Workers list, the polled run detail, and cancel. Mirrors
 * supabase/schemas/73-worker-run.sql.
 *
 * Worker-side transitions (running/pushing/terminal) go through the internal
 * routes on the service-role client; this service is the dashboard-facing
 * (user-RLS) surface: create, read, and user-initiated cancel.
 */

type WorkerRunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "pushing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

const TERMINAL: readonly WorkerRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

/**
 * What the run row remembers about an uploaded file — name/type/size only.
 * The bytes ride to the runner in the dispatch params and are never stored.
 */
interface WorkerRunAttachmentMeta {
  name: string;
  mime: string;
  size_bytes: number;
}

/** Project dispatch attachments (with content) down to the stored metadata. */
export function attachmentMetaFrom(
  attachments: Array<{ name: string; mime: string; content: string }> | undefined,
): WorkerRunAttachmentMeta[] {
  return (attachments ?? []).map((a) => ({
    name: a.name,
    mime: a.mime,
    // Base64 length → decoded size; validation upstream guarantees well-formed
    // content, so the padding arithmetic is exact.
    size_bytes: Math.floor((a.content.length / 4) * 3) -
      (a.content.endsWith("==") ? 2 : a.content.endsWith("=") ? 1 : 0),
  }));
}

interface WorkerRunRow {
  id: string;
  app_id: string;
  tenant_id: string;
  environment_id: string | null;
  agent: string;
  /** Model the agent ran (adapter alias); NULL = the agent CLI's default. */
  model: string | null;
  task_prompt: string;
  attachments: WorkerRunAttachmentMeta[];
  base_branch: string;
  status: WorkerRunStatus;
  dispatch: "fly" | "local";
  machine_id: string | null;
  outcome: "changes" | "no_changes" | null;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  failure_code: string | null;
  error_message: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  wall_clock_cap_s: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  /** Persistent-environment turn linkage (NULL = one-shot). */
  workspace_id: string | null;
  turn_index: number;
}

interface CreateWorkerRunInput {
  appId: string;
  tenantId: string;
  environmentId?: string | null;
  createdBy?: string | null;
  agent: string;
  /** Resolved model alias; NULL/omitted = the agent CLI's default. */
  model?: string | null;
  taskPrompt: string;
  /** Metadata of the user's uploads (content never touches the database). */
  attachments?: WorkerRunAttachmentMeta[];
  baseBranch: string;
  dispatch: "fly" | "local";
  wallClockCapS: number;
  /** Persistent-environment turn linkage. */
  workspaceId?: string | null;
  turnIndex?: number;
}

// `worker_run` reaches the DB through an untyped client until `yarn codegen:db`
// adds it to the generated Database type; the queries are exercised by MSW
// tests and the cast collapses once codegen runs.
type UntypedClient = SupabaseClient<any, any, any>;

export class WorkerRunService {
  constructor(private readonly supabase: UntypedClient) {}

  private table() {
    return this.supabase.from("worker_run");
  }

  async create(input: CreateWorkerRunInput): Promise<WorkerRunRow> {
    const { data, error } = await this.table()
      .insert({
        app_id: input.appId,
        tenant_id: input.tenantId,
        environment_id: input.environmentId ?? null,
        created_by: input.createdBy ?? null,
        agent: input.agent,
        model: input.model ?? null,
        task_prompt: input.taskPrompt,
        attachments: input.attachments ?? [],
        base_branch: input.baseBranch,
        dispatch: input.dispatch,
        wall_clock_cap_s: input.wallClockCapS,
        workspace_id: input.workspaceId ?? null,
        turn_index: input.turnIndex ?? 0,
        status: "queued",
      })
      .select("*")
      .single();
    if (error) throw new Error(`create worker_run failed: ${error.message}`);
    return data as WorkerRunRow;
  }

  async get(appId: string, runId: string): Promise<WorkerRunRow | null> {
    const { data, error } = await this.table()
      .select("*")
      .eq("app_id", appId)
      .eq("id", runId)
      .limit(1);
    if (error) throw new Error(`get worker_run failed: ${error.message}`);
    return ((data as WorkerRunRow[])?.[0] as WorkerRunRow) ?? null;
  }

  async list(appId: string, limit = 50): Promise<WorkerRunRow[]> {
    const { data, error } = await this.table()
      .select("*")
      .eq("app_id", appId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`list worker_run failed: ${error.message}`);
    return (data as WorkerRunRow[]) ?? [];
  }

  /** A persistent environment's turns, oldest-first (the thread). */
  async listByEnvironment(appId: string, workspaceId: string): Promise<WorkerRunRow[]> {
    const { data, error } = await this.table()
      .select("*")
      .eq("app_id", appId)
      .eq("workspace_id", workspaceId)
      .order("turn_index", { ascending: true });
    if (error) throw new Error(`list environment turns failed: ${error.message}`);
    return (data as WorkerRunRow[]) ?? [];
  }

  /** Count the tenant's non-terminal runs — the concurrency entitlement input. */
  async countActiveForTenant(tenantId: string): Promise<number> {
    const { count, error } = await this.table()
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .in("status", ["queued", "provisioning", "running", "pushing"]);
    if (error) throw new Error(`count worker_run failed: ${error.message}`);
    return count ?? 0;
  }

  /** Sum duration of the tenant's runs since `sinceIso` — the minutes-cap input. */
  async sumDurationMsForTenantSince(tenantId: string, sinceIso: string): Promise<number> {
    const { data, error } = await this.table()
      .select("duration_ms")
      .eq("tenant_id", tenantId)
      .gte("created_at", sinceIso);
    if (error) throw new Error(`sum worker_run duration failed: ${error.message}`);
    return ((data as Array<{ duration_ms: number | null }>) ?? []).reduce(
      (acc, r) => acc + (r.duration_ms ?? 0),
      0,
    );
  }

  /** Record the machine id + provisioning transition after dispatch. */
  async markProvisioning(appId: string, runId: string, machineId: string | null): Promise<void> {
    await this.patch(appId, runId, { status: "provisioning", machine_id: machineId });
  }

  /**
   * User-initiated cancel. Only from a non-terminal state; idempotent against a
   * completion race (the `.in(nonTerminal)` filter makes a late cancel a no-op).
   * Returns the row if it transitioned, else null.
   */
  async cancel(appId: string, runId: string): Promise<WorkerRunRow | null> {
    const { data, error } = await this.table()
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("app_id", appId)
      .eq("id", runId)
      .in("status", ["queued", "provisioning", "running", "pushing"])
      .select("*");
    if (error) throw new Error(`cancel worker_run failed: ${error.message}`);
    return ((data as WorkerRunRow[])?.[0] as WorkerRunRow) ?? null;
  }

  /** Terminal failure from the dispatch path (before any machine reported in). */
  async fail(appId: string, runId: string, failureCode: string, message: string): Promise<void> {
    await this.patch(appId, runId, {
      status: "failed",
      failure_code: failureCode,
      error_message: message.slice(0, 2000),
      completed_at: new Date().toISOString(),
    });
  }

  static isTerminal(status: WorkerRunStatus): boolean {
    return TERMINAL.includes(status);
  }

  private async patch(appId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.table()
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("app_id", appId)
      .eq("id", runId);
    if (error) throw new Error(`update worker_run failed: ${error.message}`);
  }
}
