/**
 * Worker Events Route.
 *
 * The runner flushes batches of normalized transcript events here every couple
 * of seconds. Auth is the per-run worker secret (Vault-verified). Events are
 * appended to worker_run_event keyed by (worker_run_id, seq) — the unique
 * constraint makes batch replays idempotent. The first batch also flips the
 * run queued/provisioning → running (the "started" signal), so the dashboard
 * sees liveness without a separate heartbeat.
 *
 * POST /api/internal/worker-events
 * Authorization: Bearer {worker_secret}
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { serverLogger } from "@/lib/observability/server-logger";
import { workerEventBatchSchema } from "@repo/worker-core";
import type { Json } from "@repo/db-types";
import { verifyWorkerSecret } from "@/lib/system/workers/verify-worker-secret";

export async function POST(request: NextRequest) {
  const raw = await request.json().catch(() => null);
  const parsed = workerEventBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid event batch" }, { status: 400 });
  }
  const { worker_run_id: workerRunId, events } = parsed.data;

  const supabase = createSupabaseAdminClient();
  const authorized = await verifyWorkerSecret(supabase, workerRunId, request.headers.get("authorization"));
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve the run's tenant/app for the denormalized event rows + the
  // running-transition. A terminal run rejects further events (409).
  const { data: run } = await supabase
    .from("worker_run")
    .select("id, app_id, tenant_id, status")
    .eq("id", workerRunId)
    .maybeSingle();
  if (!run) {
    return NextResponse.json({ error: "Unknown run" }, { status: 404 });
  }
  const terminal = ["completed", "failed", "cancelled", "timed_out"];
  if (terminal.includes(run.status as string)) {
    return NextResponse.json({ error: "Run already terminal" }, { status: 409 });
  }

  const rows = events.map((e) => ({
    worker_run_id: workerRunId,
    tenant_id: run.tenant_id,
    app_id: run.app_id,
    seq: e.seq,
    event_type: e.event_type,
    payload: e.payload as Json,
  }));
  const { error: insertError } = await supabase
    .from("worker_run_event")
    .upsert(rows, { onConflict: "worker_run_id,seq", ignoreDuplicates: true });
  if (insertError) {
    await serverLogger.error(new Error(`worker_run_event insert failed: ${insertError.message}`), {
      workerRunId,
    });
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  // First liveness signal → running (only from a pre-running state).
  if (run.status === "queued" || run.status === "provisioning") {
    await supabase
      .from("worker_run")
      .update({ status: "running", started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", workerRunId)
      .in("status", ["queued", "provisioning"]);
  } else {
    await supabase
      .from("worker_run")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", workerRunId);
  }

  return NextResponse.json({ received: events.length });
}
