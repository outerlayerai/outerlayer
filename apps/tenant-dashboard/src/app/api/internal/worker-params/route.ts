/**
 * Worker Params Route.
 *
 * One-time token endpoint for ephemeral worker machines — the machine trades
 * its WORKER_TOKEN for the full params payload (git token, agent credential,
 * per-run secret) at boot, so nothing sensitive rides in the Fly machine
 * config. The Vault entry is deleted after the first successful fetch,
 * preventing replay. Mirrors /api/internal/build-params.
 *
 * GET /api/internal/worker-params?worker_run_id={id}
 * Authorization: Bearer {WORKER_TOKEN}
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { serverLogger } from "@/lib/observability/server-logger";
import { safeCompare } from "@/utils/safe-compare";
import { workerTokenVaultName } from "@repo/worker-core";

/**
 * `worker_run.id` is a UUID, and the value is concatenated into the Vault
 * secret name. Rejecting anything else keeps a caller from steering the lookup
 * at a Vault entry outside the `worker_token_<uuid>` namespace.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const workerRunId = request.nextUrl.searchParams.get("worker_run_id");
  if (!workerRunId) {
    return NextResponse.json({ error: "Missing worker_run_id parameter" }, { status: 400 });
  }
  if (!UUID_PATTERN.test(workerRunId)) {
    return NextResponse.json({ error: "Invalid worker_run_id parameter" }, { status: 400 });
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const providedToken = authHeader.slice("Bearer ".length);

  const supabase = createSupabaseAdminClient();
  const vaultName = workerTokenVaultName(workerRunId);

  const { data: vaultValue, error: readError } = await supabase.rpc("read_secret", {
    secret_name: vaultName,
  });
  if (readError || !vaultValue) {
    await serverLogger.info("[WorkerParams] Token not found or already consumed", { workerRunId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let stored: { token: string; payload: Record<string, unknown> };
  try {
    stored = JSON.parse(vaultValue as string);
  } catch {
    await serverLogger.error(new Error("Failed to parse worker token vault entry"), { workerRunId });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  if (!safeCompare(providedToken, stored.token)) {
    await serverLogger.info("[WorkerParams] Token mismatch", { workerRunId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Single-use: delete BEFORE returning the payload (replay-proof).
  const { error: deleteError } = await supabase.rpc("delete_secret", { secret_name: vaultName });
  if (deleteError) {
    await serverLogger.error(
      new Error("Failed to delete worker token from vault — token may be replayable"),
      { workerRunId, error: deleteError.message },
    );
  }

  return NextResponse.json(stored.payload);
}
