/**
 * GET /api/orgs/[orgName]/apps/[appId]/workers/environments
 *   The app's live persistent workspaces.
 *
 * // live: a workspace's turn lock advances server-side while a turn runs, so
 * the list is polled rather than server-rendered once.
 */

import "server-only";
import { NextResponse } from "next/server";

import { loadWorkerWorkspaces } from "@/features/workers/read";

type RouteContext = { params: Promise<{ orgName: string; appId: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { appId } = await context.params;
  const environments = await loadWorkerWorkspaces(appId);
  return NextResponse.json({ environments });
}
