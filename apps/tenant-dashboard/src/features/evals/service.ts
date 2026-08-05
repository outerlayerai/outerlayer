import "server-only";

/**
 * EvalRunService — persistence + lifecycle for eval runs (`eval_run`,
 * supabase/schemas/71-eval-run.sql).
 *
 * A run is created queued at dispatch, flipped to running once the worker picks
 * it up, and finished with its Report Card (or failed). Terminal card/error
 * write-backs also arrive from the eval worker through the gateway; the
 * dashboard owns dispatch + the read side.
 *
 * Every method runs its queries through the caller's RLS-scoped `ctx.db`:
 * `eval_run.read` / `.insert` / `.update` plus the tenant match are enforced by
 * the policies, so a row outside the caller's tenant is indistinguishable from a
 * missing one. The service opens no client of its own and reads no request state
 * — `ServiceContext` carries the tenant-scoped client, the resolved tenant, and
 * the actor.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { readEvalConfigSecrets } from "@/lib/adapters/eval-secrets";
import { mintEvalWorkerCredentials } from "@/lib/system/eval-worker-credentials";

import { flyDispatchFromEnv, FlyEvalDispatcher } from "./fly-dispatch";
import type { EvalRunRow, EvalRunStatus, EvalRunSummary } from "./types";
import type { LaunchEvalRunInput } from "./schemas";

/** The dispatch outcome the launch action returns: the runId the UI polls plus
 *  the run's status, and the failure reason when it could not start. */
interface DispatchResult {
  runId: string;
  status: EvalRunStatus;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** History-list columns. The heavy `card` blob and the audit columns are left
 *  out — the list renders none of them, and the card is fetched on open. */
const LIST_COLUMNS = "id, status, repo_label, request, cost_usd, error, created_at";

/** Coordinates a queued run is born with. `tenant_id`/`created_by` come from the
 *  request context, never a positional caller argument, so a caller can't stamp
 *  a foreign tenant (the RLS INSERT check would reject it regardless). */
interface CreateEvalRunInput {
  appId: string;
  environmentId: string;
  repoLabel: string;
  request: EvalRunRow["request"];
}

class EvalRunService {
  private table(ctx: ServiceContext) {
    return (ctx.db as SupabaseClient).from("eval_run");
  }

  /** Persist a queued run and return it. */
  async create(ctx: ServiceContext, input: CreateEvalRunInput): Promise<EvalRunRow> {
    const { data, error } = await this.table(ctx)
      .insert({
        app_id: input.appId,
        tenant_id: ctx.tenantId,
        environment_id: input.environmentId,
        created_by: ctx.actor.userId,
        repo_label: input.repoLabel,
        request: input.request,
        status: "queued",
      })
      .select("*")
      .single();
    if (error) throw new Error(`create eval_run failed: ${error.message}`);
    return data as unknown as EvalRunRow;
  }

  /**
   * Launch a Report Card run: resolve each config's model key from the
   * environment's Vault store, persist a queued run, then hand it to the
   * production Fly worker (with a per-run gateway key minted for it) or the
   * local executor. Returns the runId the UI polls plus the run's status. The
   * secret pre-flight runs before any run row or worker exists, so a missing
   * key fails fast with no wasted persistence or Machine.
   */
  async dispatch(ctx: ServiceContext, input: LaunchEvalRunInput): Promise<DispatchResult> {
    // Ownership pre-check, ahead of any Vault read, run persistence, or
    // credential mint: resolved through the caller's RLS-scoped client, so a
    // foreign-tenant env, a same-tenant/cross-app env, and a nonexistent id
    // all resolve to the same null — one identical error, no existence oracle.
    // The composite FK on eval_run is the backstop; this is the clean error.
    // Reading through RLS ties this check to `environment.read`: an actor
    // holding `eval_run.insert` but not `environment.read` gets the same
    // "not found" error for its own app's environment. Deliberate — the
    // launch wizard already requires `environment.read` to list environments
    // at all, so no launchable actor is actually blocked by this coupling.
    const { data: env, error: envError } = await (ctx.db as SupabaseClient)
      .from("environment")
      .select("id")
      .eq("id", input.environmentId)
      .eq("app_id", input.appId)
      .maybeSingle();
    if (envError) throw new Error(`environment lookup failed: ${envError.message}`);
    if (!env) throw new Error("Environment not found for this app.");

    const secretsByConfig: Record<string, Record<string, string>> = {};
    for (const cfg of input.configs) {
      secretsByConfig[cfg.id] = await readEvalConfigSecrets({
        appId: input.appId,
        environmentId: input.environmentId,
        launcher: cfg.launcher,
      });
    }

    const run = await this.create(ctx, {
      appId: input.appId,
      environmentId: input.environmentId,
      repoLabel: input.repoLabel,
      request: {
        configs: input.configs,
        taskCount: input.taskCount,
        trialsPerTask: input.trialsPerTask,
        budgetUsd: input.budgetUsd,
      },
    });

    // Production path: one ephemeral Fly Machine per run. The worker holds no
    // database credential — its only secret is the per-run gateway key minted
    // here (score.write + trace.write, 24h, revoked at terminal status).
    const fly = flyDispatchFromEnv();
    if (fly) {
      // The gateway is the worker's entire control plane — without a reachable
      // gateway URL the worker cannot even load its job.
      if (!fly.workerEnv?.EVAL_GATEWAY_URL) {
        const error = "Fly eval worker requires EVAL_GATEWAY_URL (or NEXT_PUBLIC_API_URL).";
        await this.fail(ctx, input.appId, run.id, error);
        return { runId: run.id, status: "failed", error };
      }
      let workerKey: string;
      try {
        ({ key: workerKey } = await mintEvalWorkerCredentials({
          tenantId: ctx.tenantId,
          appId: input.appId,
          environmentId: input.environmentId,
          runId: run.id,
        }));
      } catch (err) {
        const error = `gateway credentials: ${errorMessage(err)}`;
        await this.fail(ctx, input.appId, run.id, error);
        return { runId: run.id, status: "failed", error };
      }
      await this.markRunning(ctx, input.appId, run.id);
      try {
        await new FlyEvalDispatcher(fly).dispatch(run.id, input.appId, { EVAL_GATEWAY_KEY: workerKey });
        return { runId: run.id, status: "running" };
      } catch (err) {
        const error = errorMessage(err);
        await this.fail(ctx, input.appId, run.id, error);
        return { runId: run.id, status: "failed", error };
      }
    }

    const executorUrl = process.env.EVAL_EXECUTOR_URL ?? process.env.NEXT_PUBLIC_EVAL_RUNNER_URL;
    if (!executorUrl) {
      const error = "No eval executor configured (EVAL_EXECUTOR_URL).";
      await this.fail(ctx, input.appId, run.id, error);
      return { runId: run.id, status: "failed", error };
    }
    await this.markRunning(ctx, input.appId, run.id);
    try {
      const res = await fetch(`${executorUrl.replace(/\/$/, "")}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: run.id,
          appId: input.appId,
          repoLabel: input.repoLabel,
          taskCount: input.taskCount,
          trialsPerTask: input.trialsPerTask,
          configs: input.configs,
          secretsByConfig,
        }),
      });
      if (!res.ok) throw new Error(`executor responded ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as { card?: unknown; spentUsd?: number };
      // Dev executor returns the card synchronously; a production worker returns
      // no card and calls back through the gateway with the terminal status.
      if (data?.card) {
        await this.complete(ctx, input.appId, run.id, data.card, data.spentUsd ?? 0);
        return { runId: run.id, status: "succeeded" };
      }
      return { runId: run.id, status: "running" };
    } catch (err) {
      const error = errorMessage(err);
      await this.fail(ctx, input.appId, run.id, error);
      return { runId: run.id, status: "failed", error };
    }
  }

  /** One run by id (full row, including the `card`), or null when RLS can't see
   *  it — an unknown id and a foreign-tenant row are the same null (no oracle). */
  async get(ctx: ServiceContext, appId: string, runId: string): Promise<EvalRunRow | null> {
    const { data, error } = await this.table(ctx)
      .select("*")
      .eq("app_id", appId)
      .eq("id", runId)
      .maybeSingle();
    if (error) throw new Error(`get eval_run failed: ${error.message}`);
    return (data as unknown as EvalRunRow) ?? null;
  }

  /** Newest-first run history for an app, light columns only. */
  async list(ctx: ServiceContext, appId: string, limit = 50): Promise<EvalRunSummary[]> {
    const { data, error } = await this.table(ctx)
      .select(LIST_COLUMNS)
      .eq("app_id", appId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`list eval_run failed: ${error.message}`);
    return (data ?? []) as unknown as EvalRunSummary[];
  }

  async markRunning(ctx: ServiceContext, appId: string, runId: string): Promise<void> {
    await this.patch(ctx, appId, runId, { status: "running" });
  }

  /** Terminal success: write the Report Card + measured cost. */
  async complete(
    ctx: ServiceContext,
    appId: string,
    runId: string,
    card: unknown,
    costUsd: number,
  ): Promise<void> {
    await this.patch(ctx, appId, runId, { status: "succeeded", card, cost_usd: costUsd });
  }

  /** Terminal failure: record why. The message is bounded so a runaway backend
   *  error can't write an unbounded row. */
  async fail(ctx: ServiceContext, appId: string, runId: string, message: string): Promise<void> {
    await this.patch(ctx, appId, runId, { status: "failed", error: message.slice(0, 2000) });
  }

  private async patch(
    ctx: ServiceContext,
    appId: string,
    runId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.table(ctx)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("app_id", appId)
      .eq("id", runId);
    if (error) throw new Error(`update eval_run failed: ${error.message}`);
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const evalsService = new EvalRunService();
