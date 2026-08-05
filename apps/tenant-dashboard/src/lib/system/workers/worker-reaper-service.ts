import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { destroyWorkerMachine, stopWorkerMachine, destroyPersistentWorkerEnvironment } from "@repo/worker-core";
import { flyWorkerFromEnv } from "./worker-config";
import { serverLogger } from "@/lib/observability/server-logger";

/**
 * Reaps overdue worker runs.
 *
 * A run's own runner self-enforces the wall-clock cap and callbacks a terminal
 * status. This cron is the backstop for runs whose machine died without a
 * callback (crash, OOM, lost network): any in-flight run past
 * `started_at + wall_clock_cap_s + grace` (or, if never started, past
 * `created_at + provisioning grace`) is force-terminated, its Fly machine
 * destroyed, and the per-run secret cleaned up — so no run hangs forever and no
 * machine is orphaned. Mirrors FlyMachineCleanupService.
 */

const GRACE_S = 600; // 10 min past the cap before we declare a run dead.
const PROVISIONING_GRACE_S = 900; // a queued/provisioning run that never started.
// Idle persistent environments: suspended after their per-env idle_ttl_s
// (a metadata transition — the machine already stopped when the turn's
// runner exited), destroyed (machine + volume torn down) after this long
// with no activity. Cost control for the standing storage.
const ENV_DESTROY_AFTER_S = 7 * 24 * 3600;

type UntypedClient = SupabaseClient<any, any, any>;

interface ReapableRun {
  id: string;
  app_id: string;
  status: string;
  dispatch: string;
  machine_id: string | null;
  wall_clock_cap_s: number;
  started_at: string | null;
  created_at: string;
  workspace_id: string | null;
}

interface ReapableEnvironment {
  id: string;
  status: string;
  substrate: string;
  machine_ref: string | null;
  current_run_id: string | null;
  idle_ttl_s: number;
  last_active_at: string | null;
  created_at: string;
}

interface ReapResult {
  reaped: string[];
  failed: Array<{ id: string; error: string }>;
}

interface EnvReapResult {
  suspended: string[];
  destroyed: string[];
  failed: Array<{ id: string; error: string }>;
}

export class WorkerReaperService {
  constructor(
    private readonly supabase: UntypedClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A run is overdue when the wall clock (+grace) has elapsed with no terminal callback. */
  static isOverdue(run: ReapableRun, nowMs: number): boolean {
    if (run.started_at) {
      const deadline = Date.parse(run.started_at) + (run.wall_clock_cap_s + GRACE_S) * 1000;
      return nowMs > deadline;
    }
    // Never started (stuck in queued/provisioning): reap after the provisioning grace.
    return nowMs > Date.parse(run.created_at) + PROVISIONING_GRACE_S * 1000;
  }

  async reapOverdueRuns(): Promise<ReapResult> {
    const { data, error } = await this.supabase
      .from("worker_run")
      .select(
        "id, app_id, status, dispatch, machine_id, wall_clock_cap_s, started_at, created_at, workspace_id",
      )
      .in("status", ["queued", "provisioning", "running", "pushing"]);
    if (error) throw new Error(`reaper scan failed: ${error.message}`);

    const nowMs = this.now();
    const overdue = ((data as ReapableRun[]) ?? []).filter((r) => WorkerReaperService.isOverdue(r, nowMs));
    const flyConfig = flyWorkerFromEnv();
    const result: ReapResult = { reaped: [], failed: [] };

    for (const run of overdue) {
      try {
        // Mark terminal first (idempotent guard: only from a non-terminal state)
        // so a racing callback can't re-open it.
        const { data: updated } = await this.supabase
          .from("worker_run")
          .update({
            status: "timed_out",
            failure_code: "callback_missing",
            error_message: "Worker did not report a result before its deadline; reaped.",
            completed_at: new Date(nowMs).toISOString(),
            updated_at: new Date(nowMs).toISOString(),
          })
          .eq("id", run.id)
          .in("status", ["queued", "provisioning", "running", "pushing"])
          .select("id");
        if (!updated || (updated as unknown[]).length === 0) continue; // already terminal

        if (run.dispatch === "fly" && run.machine_id && flyConfig) {
          // A persistent environment's machine is durable — stop it (the dead
          // runner can't); an ephemeral one-shot machine is destroyed.
          if (run.workspace_id) {
            await stopWorkerMachine({
              flyApiToken: flyConfig.flyApiToken,
              workerApp: flyConfig.workerApp,
              machineId: run.machine_id,
            });
          } else {
            await destroyWorkerMachine({
              flyApiToken: flyConfig.flyApiToken,
              workerApp: flyConfig.workerApp,
              machineId: run.machine_id,
            });
          }
        }
        // A reaped persistent turn must release the environment's single-turn
        // lock (guarded on still holding it) or the thread wedges forever.
        if (run.workspace_id) {
          await this.supabase
            .from("worker_workspace")
            .update({
              current_run_id: null,
              last_active_at: new Date(nowMs).toISOString(),
              updated_at: new Date(nowMs).toISOString(),
            })
            .eq("id", run.workspace_id)
            .eq("current_run_id", run.id);
        }
        await this.supabase.rpc("delete_secret", { secret_name: `worker_secret_${run.id}` });
        await this.supabase.rpc("delete_secret", { secret_name: `worker_token_${run.id}` });
        result.reaped.push(run.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await serverLogger.error(new Error(`reap of worker run ${run.id} failed: ${message}`), { runId: run.id });
        result.failed.push({ id: run.id, error: message });
      }
    }
    return result;
  }

  /** Idle anchor: last activity, else creation (turn 0 never completed). */
  private static idleAnchorMs(env: ReapableEnvironment): number {
    return Date.parse(env.last_active_at ?? env.created_at);
  }

  /** Free + past its per-env idle TTL → suspend (metadata; machine is stopped). */
  static isIdlePastTtl(env: ReapableEnvironment, nowMs: number): boolean {
    if (env.status !== "active" || env.current_run_id !== null) return false;
    return nowMs > WorkerReaperService.idleAnchorMs(env) + env.idle_ttl_s * 1000;
  }

  /** Free + inactive past the destroy window → tear down compute for good. */
  static isPastDestroyWindow(env: ReapableEnvironment, nowMs: number): boolean {
    if (env.current_run_id !== null) return false;
    if (env.status !== "active" && env.status !== "suspended") return false;
    return nowMs > WorkerReaperService.idleAnchorMs(env) + ENV_DESTROY_AFTER_S * 1000;
  }

  /**
   * Idle lifecycle for persistent environments (058 P3 cost control):
   * active + free past idle_ttl_s → `suspended`; suspended/active + free past
   * ENV_DESTROY_AFTER_S → machine + volume torn down (fly) and `destroyed`.
   * Turns wake a suspended environment transparently (acquireForTurn flips it
   * back to active and dispatch starts the stopped machine).
   */
  async reapIdleEnvironments(): Promise<EnvReapResult> {
    const { data, error } = await this.supabase
      .from("worker_workspace")
      .select("id, status, substrate, machine_ref, current_run_id, idle_ttl_s, last_active_at, created_at")
      .in("status", ["active", "suspended"]);
    if (error) throw new Error(`environment reaper scan failed: ${error.message}`);

    const nowMs = this.now();
    const envs = (data as ReapableEnvironment[]) ?? [];
    const flyConfig = flyWorkerFromEnv();
    const result: EnvReapResult = { suspended: [], destroyed: [], failed: [] };

    for (const env of envs) {
      try {
        if (WorkerReaperService.isPastDestroyWindow(env, nowMs)) {
          if (env.substrate === "fly" && flyConfig) {
            await destroyPersistentWorkerEnvironment({
              flyApiToken: flyConfig.flyApiToken,
              workerApp: flyConfig.workerApp,
              envId: env.id,
              machineId: env.machine_ref,
            });
          }
          // Guarded on still being free — a turn racing in keeps the env.
          const { data: updated } = await this.supabase
            .from("worker_workspace")
            .update({
              status: "destroyed",
              failure_reason: "Reclaimed after prolonged inactivity.",
              updated_at: new Date(nowMs).toISOString(),
            })
            .eq("id", env.id)
            .is("current_run_id", null)
            .select("id");
          if (updated && (updated as unknown[]).length > 0) result.destroyed.push(env.id);
        } else if (WorkerReaperService.isIdlePastTtl(env, nowMs)) {
          const { data: updated } = await this.supabase
            .from("worker_workspace")
            .update({ status: "suspended", updated_at: new Date(nowMs).toISOString() })
            .eq("id", env.id)
            .eq("status", "active")
            .is("current_run_id", null)
            .select("id");
          if (updated && (updated as unknown[]).length > 0) result.suspended.push(env.id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await serverLogger.error(new Error(`reap of worker environment ${env.id} failed: ${message}`), {});
        result.failed.push({ id: env.id, error: message });
      }
    }
    return result;
  }
}
