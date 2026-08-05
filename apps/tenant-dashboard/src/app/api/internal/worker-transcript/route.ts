/**
 * Worker Transcript Route.
 *
 * The runner's post-run upload of the agent's RAW stream-json transcript,
 * gzip+base64 in a JSON body (same secret-auth + zod conventions as
 * events/callback). Parse + shape only — auth, gunzip, and persistence live
 * in the worker-transcript service (data-access boundary).
 *
 * The response is advisory: `persisted: false` (unknown launcher, unparseable
 * transcript, CH unconfigured) is still a 200 — the runner never retries on
 * fidelity misses, and the event-bridge fallback covers the gap.
 *
 * POST /api/internal/worker-transcript
 * Authorization: Bearer {worker_secret}
 */

import { NextRequest, NextResponse } from "next/server";
import { workerTranscriptPayloadSchema } from "@repo/worker-core";
import { processWorkerTranscript } from "@/lib/system/workers/worker-transcript-service";

export async function POST(request: NextRequest) {
  const raw = await request.json().catch(() => null);
  const parsed = workerTranscriptPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid transcript payload" }, { status: 400 });
  }

  const result = await processWorkerTranscript({
    workerRunId: parsed.data.worker_run_id,
    authorization: request.headers.get("authorization"),
    gzBase64: parsed.data.data,
  });
  if (result.status !== 200) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ persisted: result.persisted });
}
