/**
 * applyWorkerCallback — the DB-apply core for the runner's terminal report.
 *
 * Lives here (not in the route) so the gateway loopback applies callbacks
 * identically. The route owns auth + parse; this owns semantics:
 *
 *   - At-least-once tolerant: a replayed callback (or one racing a cancel)
 *     hits the terminal-state guard and is skipped — a late report must never
 *     resurrect or clobber a terminal run.
 *   - PR delivery is an injected hook (`landChanges`): the dashboard wires the
 *     git-provider service in; this package stays free of app imports.
 *   - Vault cleanup (one-time token + per-run secret) is best-effort and
 *     idempotent.
 */

import {
  workerSecretVaultName,
  workerTokenVaultName,
} from "./worker-adapter";
import type { Database } from "@repo/db-types";
import type { WorkerCallbackPayload, WorkerFileChange } from "./worker-payload";
import type { Logger, SupabaseClientType } from "./types";
import { TERMINAL_WORKER_RUN_STATUSES } from "./types";

export interface LandChangesContext {
  appId: string;
  workerRunId: string;
  taskPrompt: string;
  changes: WorkerFileChange[];
  /** Runner-suggested slug; implementations sanitize before use. */
  branchSlug?: string;
}

export interface LandChangesResult {
  branchName: string;
  prUrl: string | null;
  prNumber: number | null;
}

export interface EnsurePullRequestContext {
  appId: string;
  workerRunId: string;
  taskPrompt: string;
  /** The branch the persistent runner already pushed. */
  workBranch: string;
}

export interface ApplyWorkerCallbackDeps {
  /** Service-role client — status transitions bypass RLS by design. */
  supabase: SupabaseClientType;
  logger: Logger;
  /**
   * Lands the diff as a branch + PR via the git provider. Absent (e.g. in a
   * context with no git wiring) → a changes callback fails with push_failed
   * rather than silently dropping the diff.
   */
  landChanges?: (ctx: LandChangesContext) => Promise<LandChangesResult>;
  /**
   * Open-or-reuse a PR for a persistent turn's already-pushed work branch.
   * Absent → the branch is recorded with no PR (e.g. local dev).
   */
  ensurePullRequest?: (ctx: EnsurePullRequestContext) => Promise<LandChangesResult>;
  /** Cap re-enforced on raw_log before persisting. */
  maxRawLogChars?: number;
}

export type ApplyWorkerCallbackResult =
  | { applied: false; reason: "not_found" | "already_terminal" }
  | { applied: true; finalStatus: "completed" | "failed" | "timed_out" };

const DEFAULT_MAX_RAW_LOG_CHARS = 200_000;

const NON_TERMINAL_GUARD = `(${TERMINAL_WORKER_RUN_STATUSES.join(",")})`;

/**
 * Best-effort, idempotent Vault cleanup — the one-time token entry may already
 * be gone (consumed at boot / cleaned at dispatch failure). For persistent
 * turns the per-run secret is short-lived per turn too, so both are cleared.
 */
async function cleanupVault(supabase: SupabaseClientType, workerRunId: string): Promise<void> {
  for (const secretName of [
    workerTokenVaultName(workerRunId),
    workerSecretVaultName(workerRunId),
  ]) {
    try {
      await supabase.rpc("delete_secret", { secret_name: secretName });
    } catch {
      // Ignore — cleanup must never fail the callback.
    }
  }
}

export async function applyWorkerCallback(
  deps: ApplyWorkerCallbackDeps,
  payload: WorkerCallbackPayload,
): Promise<ApplyWorkerCallbackResult> {
  const { supabase } = deps;
  const maxRawLogChars = deps.maxRawLogChars ?? DEFAULT_MAX_RAW_LOG_CHARS;

  // The caller (route or gateway loopback) has already proven ownership of
  // `worker_run_id` via the per-run secret. The trusted app is the one on that
  // run's row, loaded here; `payload.app_id` is caller-supplied and is never
  // used to resolve the git connection / PR / Vault, so those stay bound to the
  // run's own app rather than a value the caller could name.
  const { data: run } = await supabase
    .from("worker_run")
    .select("id, status, task_prompt, app_id")
    .eq("id", payload.worker_run_id)
    .maybeSingle();

  if (!run) {
    await deps.logger.info("Worker callback for unknown run — dropped", {
      workerRunId: payload.worker_run_id,
    });
    return { applied: false, reason: "not_found" };
  }

  const appId = run.app_id as string;
  const logger = deps.logger.withAppId(appId);

  const commonFields = {
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    duration_ms: Math.round(payload.duration_ms),
    cost_usd: payload.cost_usd ?? null,
    num_turns: payload.num_turns ?? null,
    raw_log: payload.raw_log.slice(-maxRawLogChars),
  };

  let finalStatus: "completed" | "failed" | "timed_out";
  let terminalFields: Database["public"]["Tables"]["worker_run"]["Update"];

  // Persistent turn: the runner already committed + pushed its work_branch, so
  // there's nothing to land server-side. Record the branch (open/reuse a PR via
  // the injected hook if provided) and complete.
  if (payload.status === "succeeded" && payload.outcome === "changes" && payload.work_branch) {
    const { data: claimed } = await supabase
      .from("worker_run")
      .update({ status: "pushing", updated_at: new Date().toISOString() })
      .eq("id", payload.worker_run_id)
      .eq("app_id", appId)
      .not("status", "in", NON_TERMINAL_GUARD)
      .neq("status", "pushing")
      .select("id");
    if (!claimed || claimed.length === 0) {
      return { applied: false, reason: "already_terminal" };
    }
    let pr: LandChangesResult = { branchName: payload.work_branch, prUrl: null, prNumber: null };
    try {
      if (deps.ensurePullRequest) {
        pr = await deps.ensurePullRequest({
          appId,
          workerRunId: payload.worker_run_id,
          taskPrompt: run.task_prompt,
          workBranch: payload.work_branch,
        });
      }
    } catch (error) {
      await logger.info("ensurePullRequest failed; recording branch only", {
        workerRunId: payload.worker_run_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await supabase
      .from("worker_run")
      .update({
        status: "completed",
        outcome: "changes",
        branch_name: pr.branchName,
        pr_url: pr.prUrl,
        pr_number: pr.prNumber,
        ...commonFields,
      })
      .eq("id", payload.worker_run_id)
      .eq("app_id", appId)
      .eq("status", "pushing");
    await cleanupVault(supabase, payload.worker_run_id);
    await logger.info("Worker persistent turn applied", { workerRunId: payload.worker_run_id });
    return { applied: true, finalStatus: "completed" };
  }

  if (payload.status === "succeeded" && payload.outcome === "changes") {
    // Claim the run by moving it to 'pushing' — this is also the idempotency
    // gate: a replayed callback (or one racing cancel) matches 0 rows here.
    const { data: claimed } = await supabase
      .from("worker_run")
      .update({ status: "pushing", updated_at: new Date().toISOString() })
      .eq("id", payload.worker_run_id)
      .eq("app_id", appId)
      .not("status", "in", NON_TERMINAL_GUARD)
      .neq("status", "pushing")
      .select("id");
    if (!claimed || claimed.length === 0) {
      return { applied: false, reason: "already_terminal" };
    }

    try {
      if (!deps.landChanges) {
        throw new Error("No git delivery configured for this deployment");
      }
      const landed = await deps.landChanges({
        appId,
        workerRunId: payload.worker_run_id,
        taskPrompt: run.task_prompt,
        changes: payload.changes ?? [],
        branchSlug: payload.branch_slug,
      });
      finalStatus = "completed";
      terminalFields = {
        status: "completed",
        outcome: "changes",
        branch_name: landed.branchName,
        pr_url: landed.prUrl,
        pr_number: landed.prNumber,
        ...commonFields,
      };
    } catch (error) {
      finalStatus = "failed";
      terminalFields = {
        status: "failed",
        outcome: "changes",
        failure_code: "push_failed",
        error_message: `Landing the agent's changes failed: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 2000),
        ...commonFields,
      };
    }

    await supabase
      .from("worker_run")
      .update(terminalFields)
      .eq("id", payload.worker_run_id)
      .eq("app_id", appId)
      .eq("status", "pushing");
  } else {
    finalStatus =
      payload.status === "succeeded"
        ? "completed"
        : payload.status === "timed_out"
          ? "timed_out"
          : "failed";
    terminalFields = {
      status: finalStatus,
      outcome: payload.status === "succeeded" ? "no_changes" : null,
      failure_code:
        payload.status === "succeeded"
          ? null
          : (payload.failure_code ??
            (payload.status === "timed_out" ? "wall_clock_exceeded" : "agent_error")),
      error_message: payload.error ? payload.error.slice(0, 2000) : null,
      ...commonFields,
    };

    const { data: updated } = await supabase
      .from("worker_run")
      .update(terminalFields)
      .eq("id", payload.worker_run_id)
      .eq("app_id", appId)
      .not("status", "in", NON_TERMINAL_GUARD)
      .select("id");
    if (!updated || updated.length === 0) {
      return { applied: false, reason: "already_terminal" };
    }
  }

  await cleanupVault(supabase, payload.worker_run_id);

  await logger.info("Worker callback applied", {
    workerRunId: payload.worker_run_id,
    finalStatus,
  });
  return { applied: true, finalStatus };
}
