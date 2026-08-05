import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { workersService } from "./service";
import type {
  WorkerRunDetail,
  WorkerRunEvent,
  WorkerRunSummary,
  WorkerWorkspaceSummary,
} from "./types";

/**
 * The server reads behind the workers live-poll endpoints, each resolved under
 * the request tenant. Reads are scoped by the `worker_run.read` RLS policy, so
 * a caller without the permission or outside the tenant gets an empty list /
 * not-found — the same answer for an unknown id and a foreign-tenant row, no
 * oracle.
 */

export async function loadWorkerRuns(appId: string): Promise<WorkerRunSummary[]> {
  const ctx = await loadRequestServiceContext();
  return workersService.listRuns(ctx, appId);
}

export async function loadWorkerRun(
  appId: string,
  runId: string,
  afterSeq: number,
): Promise<{ run: WorkerRunDetail; events: WorkerRunEvent[] } | null> {
  const ctx = await loadRequestServiceContext();
  const run = await workersService.getRun(ctx, appId, runId);
  if (!run) return null;
  const events = await workersService.getRunEvents(ctx, runId, afterSeq);
  return { run, events };
}

export async function loadWorkerWorkspaces(appId: string): Promise<WorkerWorkspaceSummary[]> {
  const ctx = await loadRequestServiceContext();
  return workersService.listWorkspaces(ctx, appId);
}

export async function loadWorkerWorkspace(
  appId: string,
  workspaceId: string,
): Promise<{ environment: WorkerWorkspaceSummary; turns: WorkerRunSummary[] } | null> {
  const ctx = await loadRequestServiceContext();
  const environment = await workersService.getWorkspace(ctx, appId, workspaceId);
  if (!environment) return null;
  const turns = await workersService.listRunsByWorkspace(ctx, appId, workspaceId);
  return { environment, turns };
}
