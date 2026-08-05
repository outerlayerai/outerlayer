import "server-only";

/**
 * Worker transcript intake: verify the per-run secret,
 * gunzip the payload, hand the raw transcript to the persist pipeline.
 *
 * Lives in the service layer because it constructs the RLS-bypassing admin
 * client (data-access-boundary rule); the authorization it owns is the
 * Vault-verified per-run worker secret — the same trust anchor as the
 * events/callback routes.
 */
import "server-only";
import { gunzipSync } from "node:zlib";
import { getAdminDataClient } from "@/lib/system/admin-client";
import { verifyWorkerSecret } from "@/lib/system/workers/verify-worker-secret";
import { persistWorkerRunTranscript } from "@/lib/system/workers/persist-agent-session";

/** Decompressed cap — zip-bomb guard, comfortably above the runner's own
 * 64 MiB raw tee cap. */
const MAX_TRANSCRIPT_RAW_BYTES = 128 * 1024 * 1024;

type WorkerTranscriptResult =
  | { status: 200; persisted: boolean }
  | { status: 400 | 401; error: string };

export async function processWorkerTranscript(input: {
  workerRunId: string;
  /** Raw Authorization header (Bearer {worker_secret}). */
  authorization: string | null;
  /** Gzipped transcript, base64-encoded. */
  gzBase64: string;
}): Promise<WorkerTranscriptResult> {
  const supabase = getAdminDataClient();
  const authorized = await verifyWorkerSecret(supabase, input.workerRunId, input.authorization);
  if (!authorized) return { status: 401, error: "Unauthorized" };

  let transcript: string;
  try {
    transcript = gunzipSync(Buffer.from(input.gzBase64, "base64"), {
      maxOutputLength: MAX_TRANSCRIPT_RAW_BYTES,
    }).toString("utf8");
  } catch {
    return { status: 400, error: "Invalid gzip payload" };
  }

  const persisted = await persistWorkerRunTranscript(supabase, input.workerRunId, transcript);
  return { status: 200, persisted };
}
