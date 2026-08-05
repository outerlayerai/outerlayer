/**
 * GET /api/orgs/[orgName]/apps/[appId]/workers/environments/[envId]
 *   A persistent workspace and its turn thread.
 *
 * // live: the workspace's turn lock and its turns' status advance server-side
 * while a turn runs, so the dashboard polls this until the thread settles.
 */

import "server-only";
import { NextResponse } from "next/server";

import { loadWorkerWorkspace } from "@/features/workers/read";

type RouteContext = { params: Promise<{ orgName: string; appId: string; envId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { appId, envId } = await context.params;
  const result = await loadWorkerWorkspace(appId, envId);
  if (!result) {
    return NextResponse.json({ error: "Environment not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
