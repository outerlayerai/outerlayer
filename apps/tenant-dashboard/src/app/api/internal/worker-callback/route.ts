/**
 * Worker Callback Route.
 *
 * The runner's terminal report. Auth is the per-run worker secret. The
 * DB-apply semantics (terminal-state idempotency guard, PR delivery via the
 * git provider, Vault cleanup) live in the Workers-safe `applyWorkerCallback`
 * (@repo/worker-core) so a future gateway loopback applies identically; this
 * route owns auth + parse + wiring the git landChanges hook.
 *
 * POST /api/internal/worker-callback
 * Authorization: Bearer {worker_secret}
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { serverLogger } from "@/lib/observability/server-logger";
import { applyWorkerCallback, workerCallbackPayloadSchema } from "@repo/worker-core";
import { verifyWorkerSecret } from "@/lib/system/workers/verify-worker-secret";
import { createWorkerLandChanges, createWorkerEnsurePr } from "@/lib/system/workers/land-changes";
import { WorkerEnvironmentService } from "@/lib/system/workers/worker-environment-service";
import { persistWorkerRunAgentSession } from "@/lib/system/workers/persist-agent-session";

export async function POST(request: NextRequest) {
  const raw = await request.json().catch(() => null);
  const parsed = workerCallbackPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const supabase = createSupabaseAdminClient();
  const authorized = await verifyWorkerSecret(
    supabase,
    payload.worker_run_id,
    request.headers.get("authorization"),
  );
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve the run's base branch + persistent-environment linkage.
  const { data: run } = await supabase
    .from("worker_run")
    .select("base_branch, workspace_id")
    .eq("id", payload.worker_run_id)
    .maybeSingle();
  const baseBranchOverride = (run?.base_branch as string) || undefined;

  const result = await applyWorkerCallback(
    {
      supabase,
      logger: serverLogger,
      landChanges: createWorkerLandChanges(supabase, { baseBranchOverride }),
      ensurePullRequest: createWorkerEnsurePr(supabase, { baseBranchOverride }),
    },
    payload,
  );

  // A finished cloud-worker run IS an agent session — persist it into the
  // Agent Sessions surface (workerKind=cloud, attributed to the dispatching
  // developer). The helper never throws, and a persist failure must not fail
  // the runner's terminal report.
  await persistWorkerRunAgentSession(supabase, payload);

  // Persistent turn: release the environment's single-turn lock and persist the
  // agent session handle so the next turn resumes it.
  const workspaceId = run?.workspace_id as string | null | undefined;
  if (workspaceId) {
    await new WorkerEnvironmentService(supabase)
      .completeTurn(workspaceId, payload.session_ref ?? null)
      .catch((err) =>
        serverLogger.error(
          new Error(`releasing worker_workspace after turn failed: ${err instanceof Error ? err.message : String(err)}`),
          { workspaceId },
        ),
      );
  }

  return NextResponse.json({ received: true, ...result });
}
