/**
 * GET /api/orgs/[orgName]/apps/[appId]/workers/runs
 *   Run history (newest-first) for the Workers list.
 *
 * // live: worker run status advances server-side while a run is in flight, so
 * the list is polled rather than server-rendered once.
 */

import "server-only";
import { NextResponse } from "next/server";

import { loadWorkerRuns } from "@/features/workers/read";

type RouteContext = { params: Promise<{ orgName: string; appId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { appId } = await context.params;
  const runs = await loadWorkerRuns(appId);
  return NextResponse.json({ runs });
}
