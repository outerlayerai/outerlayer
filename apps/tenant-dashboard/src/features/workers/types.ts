/**
 * Server-side row shapes for the workers domain, projected to the columns the
 * dashboard actually renders. The list reads deliberately omit `raw_log` (the
 * capped tail of the agent's output) and the dispatch/machine internals: a
 * history row must not ship the heavy log per run.
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

type WorkerWorkspaceStatus = "creating" | "active" | "suspended" | "destroyed";

/** Stored metadata of a file the user attached to a run (never the bytes). */
export interface WorkerRunAttachmentMeta {
  name: string;
  mime: string;
  size_bytes: number;
}

/** The dispatched-run shell an RLS insert persists before compute is dispatched. */
export interface CreateWorkerRunInput {
  appId: string;
  environmentId: string | null;
  createdBy: string | null;
  agent: string;
  model: string | null;
  taskPrompt: string;
  attachments: WorkerRunAttachmentMeta[];
  baseBranch: string;
  dispatch: "fly" | "local";
  wallClockCapS: number;
}

/** The workspace shell an RLS insert persists; the machine step sets its paths. */
export interface CreateWorkerWorkspaceInput {
  appId: string;
  environmentId: string | null;
  createdBy: string | null;
  agent: string;
  model: string | null;
  baseBranch: string;
  substrate: "local" | "e2b" | "fly";
}

/** What a created run exposes back to its dispatch action. */
export interface CreatedWorkerRun {
  id: string;
  status: WorkerRunStatus;
  dispatch: "fly" | "local";
}

/** What a created workspace exposes back to its dispatch action. */
export interface CreatedWorkerWorkspace {
  id: string;
  substrate: "local" | "e2b" | "fly";
}

/** The fields a cancelled run's machine teardown needs. */
export interface CancelledWorkerRun {
  id: string;
  dispatch: "fly" | "local";
  machine_id: string | null;
  workspace_id: string | null;
}

/** A run as it appears in the history list and the environment turn thread. */
export interface WorkerRunSummary {
  id: string;
  agent: string;
  model: string | null;
  task_prompt: string;
  attachments: WorkerRunAttachmentMeta[];
  status: WorkerRunStatus;
  outcome: "changes" | "no_changes" | null;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  failure_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}

/** A single run's detail — the summary plus the fields the detail view adds. */
export interface WorkerRunDetail extends WorkerRunSummary {
  base_branch: string;
  cost_usd: number | null;
  num_turns: number | null;
  workspace_id: string | null;
}

export interface WorkerRunEvent {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface WorkerWorkspaceSummary {
  id: string;
  agent: string;
  model: string | null;
  base_branch: string;
  work_branch: string | null;
  substrate: "local" | "e2b" | "fly";
  status: WorkerWorkspaceStatus;
  current_run_id: string | null;
  session_ref: string | null;
  last_active_at: string | null;
  created_at: string;
}
