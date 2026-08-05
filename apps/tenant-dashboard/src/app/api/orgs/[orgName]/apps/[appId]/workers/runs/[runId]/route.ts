/**
 * GET /api/orgs/[orgName]/apps/[appId]/workers/runs/[runId]?after_seq=N
 *   The run row plus transcript events with seq > after_seq (default -1 = all).
 *
 * // live: run status and transcript advance server-side while the run executes,
 * so the dashboard polls this (passing the highest seq it holds) until terminal.
 */

import "server-only";
import { NextResponse } from "next/server";

import { loadWorkerRun } from "@/features/workers/read";

type RouteContext = { params: Promise<{ orgName: string; appId: string; runId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { appId, runId } = await context.params;

  const afterSeqParam = new URL(request.url).searchParams.get("after_seq");
  const afterSeq = afterSeqParam !== null ? Number(afterSeqParam) : -1;

  const result = await loadWorkerRun(appId, runId, Number.isFinite(afterSeq) ? afterSeq : -1);
  if (!result) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
