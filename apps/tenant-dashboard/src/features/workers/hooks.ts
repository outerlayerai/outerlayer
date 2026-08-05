"use client";

/**
 * Data hooks for the Workers section. The poll hooks fetch the
 * canonical `/api/orgs/[orgName]/apps/[appId]/workers/*` endpoints so the
 * middleware derives the tenant from the org segment. The run-detail hook polls
 * with SWR refreshInterval and stops once the run is terminal.
 */
import useSWR from "swr";

export type WorkerRunStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "pushing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Stored metadata of a file the user attached to a run (never the bytes). */
export interface WorkerRunAttachmentMeta {
  name: string;
  mime: string;
  size_bytes: number;
}


export interface WorkerRunSummary {
  id: string;
  agent: string;
  model: string | null;
  task_prompt: string;
  attachments?: WorkerRunAttachmentMeta[];
  status: WorkerRunStatus;
  outcome: "changes" | "no_changes" | null;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  failure_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface WorkerRunEvent {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const TERMINAL: WorkerRunStatus[] = ["completed", "failed", "cancelled", "timed_out"];
export function isTerminalStatus(status: WorkerRunStatus): boolean {
  return TERMINAL.includes(status);
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  // The message reaches the user verbatim through the load-failure card, so it
  // has to read as a sentence — a bare status code explains nothing.
  if (!res.ok) throw new Error(`The server responded with ${res.status}.`);
  return (await res.json()) as T;
}

/**
 * What to tell the user about a failed poll. SWR types its `error` as `any`, so
 * the shape is checked rather than trusted.
 */
export function loadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong while loading.";
}

/** Poll cadence for the run list: refresh while any run is in-flight. */
export function runsRefreshInterval(latest: { runs: WorkerRunSummary[] } | undefined): number {
  return latest?.runs.some((r) => !isTerminalStatus(r.status)) ? 4000 : 0;
}

/** Run history for the Workers list. */
export function useWorkerRuns(orgName: string | undefined, appId: string | undefined) {
  // live: worker run status advances server-side while a run is in flight.
  const { data, error, isLoading, mutate } = useSWR(
    orgName && appId ? `/api/orgs/${orgName}/apps/${appId}/workers/runs` : null,
    getJson<{ runs: WorkerRunSummary[] }>,
    {
      revalidateOnFocus: false,
      refreshInterval: runsRefreshInterval,
    },
  );
  return { runs: data?.runs ?? [], error, isLoading, mutate };
}

/**
 * A run's detail + transcript. Polls every 2s until terminal. (Incremental
 * after_seq fetching is a P1 optimization; the full-transcript fetch here is
 * bounded by the 1000-event page and keeps the hook simple.)
 */
/** Poll cadence for a run's detail: refresh until the run is terminal. */
export function runDetailRefreshInterval(latest: { run: WorkerRunSummary } | undefined): number {
  return latest && isTerminalStatus(latest.run.status) ? 0 : 2000;
}

/** A run's detail and transcript. */
export function useWorkerRun(
  orgName: string | undefined,
  appId: string | undefined,
  runId: string | undefined,
) {
  // live: run status and transcript advance server-side until the run is terminal.
  const { data, error, isLoading, mutate } = useSWR(
    orgName && appId && runId ? `/api/orgs/${orgName}/apps/${appId}/workers/runs/${runId}` : null,
    getJson<{ run: WorkerRunSummary & { base_branch: string; cost_usd: number | null; num_turns: number | null }; events: WorkerRunEvent[] }>,
    {
      revalidateOnFocus: false,
      refreshInterval: runDetailRefreshInterval,
    },
  );
  return { run: data?.run, events: data?.events ?? [], error, isLoading, mutate };
}

// ---------------------------------------------------------------------------
// Persistent worker environments
// ---------------------------------------------------------------------------

export type WorkerEnvironmentStatus = "creating" | "active" | "suspended" | "destroyed";

export interface WorkerEnvironmentSummary {
  id: string;
  agent: string;
  model: string | null;
  base_branch: string;
  work_branch: string | null;
  substrate: "local" | "e2b" | "fly";
  status: WorkerEnvironmentStatus;
  current_run_id: string | null;
  session_ref: string | null;
  last_active_at: string | null;
  created_at: string;
}

/** Poll cadence for the env list: refresh while any environment is mid-turn. */
export function environmentsRefreshInterval(
  latest: { environments: WorkerEnvironmentSummary[] } | undefined,
): number {
  return latest?.environments.some((e) => e.current_run_id !== null) ? 4000 : 0;
}

/** Env list. Polls while any environment is mid-turn. */
export function useWorkerEnvironments(orgName: string | undefined, appId: string | undefined) {
  // live: a workspace's turn lock advances server-side while a turn runs.
  const { data, error, isLoading, mutate } = useSWR(
    orgName && appId ? `/api/orgs/${orgName}/apps/${appId}/workers/environments` : null,
    getJson<{ environments: WorkerEnvironmentSummary[] }>,
    {
      revalidateOnFocus: false,
      refreshInterval: environmentsRefreshInterval,
    },
  );
  return { environments: data?.environments ?? [], error, isLoading, mutate };
}

/** Poll cadence for an env thread: refresh while a turn is locked or in flight. */
export function environmentThreadRefreshInterval(
  latest: { environment: WorkerEnvironmentSummary; turns: WorkerRunSummary[] } | undefined,
): number {
  return latest &&
    (latest.environment.current_run_id !== null ||
      latest.turns.some((t) => !isTerminalStatus(t.status)))
    ? 2500
    : 0;
}

/** An environment and its turn thread. Polls while a turn is in flight. */
export function useWorkerEnvironment(
  orgName: string | undefined,
  appId: string | undefined,
  envId: string | undefined,
) {
  // live: the turn lock and the turns' status advance server-side.
  const { data, error, isLoading, mutate } = useSWR(
    orgName && appId && envId
      ? `/api/orgs/${orgName}/apps/${appId}/workers/environments/${envId}`
      : null,
    getJson<{ environment: WorkerEnvironmentSummary; turns: WorkerRunSummary[] }>,
    {
      revalidateOnFocus: false,
      refreshInterval: environmentThreadRefreshInterval,
    },
  );
  return { environment: data?.environment, turns: data?.turns ?? [], error, isLoading, mutate };
}
