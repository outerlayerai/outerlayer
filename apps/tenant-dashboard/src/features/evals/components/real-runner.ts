/**
 * Real run backend client. When `NEXT_PUBLIC_EVAL_RUNNER_URL` is configured,
 * the evals section dispatches a run through the `launchEvalRun` server
 * action — which resolves the configs' model keys from Vault, persists an
 * eval_run, and hands it to the executor — then polls the canonical run-status
 * route until the run completes and renders the Report Card it produced.
 * Falls back to the seeded fake runner when unset (the offline demo). The
 * card model is identical either way, so the Card/Progress components are
 * unchanged.
 */

import type { ReportCard } from "@outerlayer/report-card";
import { ActionErrorCodes } from "../../../lib/action-kit/result";
import { launchEvalRun, refreshEvalRuns } from "../actions";
import type { EvalRunRequest } from "./fake-runner";
import { EvalRunError } from "./run-error";

const RUNNER_URL = process.env.NEXT_PUBLIC_EVAL_RUNNER_URL;

/** True when a real eval-runner backend is wired (else fall back to fake). */
export function isRealRunnerEnabled(): boolean {
  return Boolean(RUNNER_URL);
}

interface RealRunResult {
  card: ReportCard;
  spentUsd: number;
  runId: string;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Whether repeating the identical status GET could return a different answer.
 *
 * `408` and `429` are the only 4xx that mean "this same request may succeed
 * later"; every other 4xx describes the request itself — the caller's identity,
 * permissions, or the resource's existence — and the poll re-sends that request
 * byte-for-byte, so waiting cannot change the verdict. 5xx is the server
 * failing to answer a request it accepted, which a background executor writing
 * the run row concurrently makes genuinely likely to clear.
 */
function isTransientPollStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/** Humanized copy for the terminal statuses the poll route can return, so the
 *  user reads a cause they can act on instead of a permission code. */
const TERMINAL_POLL_MESSAGES: Record<number, string> = {
  401: "Your session expired. Sign in again to see this run's result.",
  403: "You don't have permission to read this benchmark run.",
  404: "This benchmark run is no longer available.",
};

/** The server's own message, from either error envelope this route can produce:
 *  the API layer's `{ error: { code, message } }` or the auth middleware's
 *  `{ error: "Not authenticated" }`. Absent when the body is not JSON. */
async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: string | { message?: string } };
    const { error } = body;
    if (typeof error === "string") return error || null;
    if (error && typeof error.message === "string") return error.message || null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the error a terminal poll status ends the run with. Known statuses use
 * the humanized copy above; anything else names the status and the server's
 * message so an unexpected terminal response is still diagnosable.
 */
async function terminalPollError(res: Response): Promise<EvalRunError> {
  const opts = { kind: "poll_failed" as const, retryable: false, status: res.status };
  const copy = TERMINAL_POLL_MESSAGES[res.status];
  if (copy) return new EvalRunError(copy, opts);
  const detail = await serverMessage(res);
  const suffix = detail ? `: ${detail}` : ".";
  return new EvalRunError(`Couldn't read the benchmark run's status (${res.status})${suffix}`, opts);
}

interface EvalRunRecord {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  card: ReportCard | null;
  cost_usd: number;
  error: string | null;
}

/** One row of the persisted run history. `card` is never populated here — the
 *  history projection excludes it (see `features/evals/service.ts`'s
 *  `LIST_COLUMNS`); a succeeded run's card is read on demand, not from this
 *  row. */
export interface EvalRunSummary {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  repo_label: string;
  request: {
    configs?: Array<{ id: string }>;
    taskCount?: number;
    trialsPerTask?: number;
  };
  card?: ReportCard | null;
  cost_usd: number;
  error: string | null;
  created_at: string;
}

/**
 * Re-read the app's persisted run history through the `refreshEvalRuns`
 * server action. Called once a dispatched run reaches a terminal state (the
 * list seeded by the React Server Component (RSC) can't see that until the
 * next render), so the just-finished
 * run's status/cost show in the table without a page reload.
 */
export async function refreshRunHistory(appId: string): Promise<EvalRunSummary[]> {
  const res = await refreshEvalRuns({ appId });
  if (!res.ok) throw new Error(res.error.message);
  return res.data;
}

/**
 * Load one run's full detail, including its Report Card, through the
 * canonical run-status route. The history list never carries `card` — opening
 * a past succeeded run fetches it on demand rather than reading it off the row.
 */
export async function loadRunDetail(
  appId: string,
  orgName: string,
  runId: string,
): Promise<EvalRunRecord> {
  const res = await fetch(
    `/api/orgs/${encodeURIComponent(orgName)}/apps/${appId}/evals/runs/${runId}?appId=${appId}`,
  );
  if (!res.ok) throw new Error(`Run detail failed (${res.status}).`);
  const { run } = (await res.json()) as { run: EvalRunRecord };
  return run;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Dispatch a run through the launch server action and poll until it terminates,
 * returning the Report Card. Every failure path throws an `EvalRunError` whose
 * message names what actually happened and whose `retryable` says whether
 * another attempt could differ — a refused status read ends the poll at once
 * rather than being retried into a timeout that misstates the cause.
 */
export async function runRealEval(
  appId: string,
  orgName: string,
  environmentId: string | undefined,
  req: EvalRunRequest,
): Promise<RealRunResult> {
  const dispatch = await launchEvalRun({
    appId,
    environmentId,
    repoLabel: req.repoLabel,
    taskCount: req.taskIds.length,
    trialsPerTask: req.trialsPerTask,
    budgetUsd: req.budgetUsd,
    configs: req.configs.map((c) => ({ id: c.id, launcher: c.launcher, model: c.model, baseUrl: c.baseUrl })),
  });
  if (!dispatch.ok) {
    // A permission denial or a rejected input is a decision about this exact
    // request, so re-sending it is refused identically; only an internal
    // failure is worth another attempt.
    throw new EvalRunError(dispatch.error.message, {
      kind: "dispatch_failed",
      retryable: dispatch.error.code === ActionErrorCodes.INTERNAL,
    });
  }
  const { runId, status, error } = dispatch.data;
  if (status === "failed") {
    throw new EvalRunError(error ?? "The eval run failed.", { kind: "run_failed", retryable: true });
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    // Live poll of the run-status route until the run reaches a terminal state.
    const res = await fetch(
      `/api/orgs/${encodeURIComponent(orgName)}/apps/${appId}/evals/runs/${runId}?appId=${appId}`,
    );
    if (res.ok) {
      const { run } = (await res.json()) as { run: EvalRunRecord };
      if (run.status === "succeeded" && run.card) {
        return { card: run.card, spentUsd: run.cost_usd, runId };
      }
      if (run.status === "failed") {
        throw new EvalRunError(run.error ?? "The eval run failed.", { kind: "run_failed", retryable: true });
      }
    } else if (!isTransientPollStatus(res.status)) {
      // Retrying this status would only delay the same refusal to the deadline
      // and then report a timeout — a statement about the run that describes
      // something else entirely.
      throw await terminalPollError(res);
    }
    if (Date.now() > deadline) {
      throw new EvalRunError("The eval run timed out.", { kind: "timed_out", retryable: true });
    }
    await wait(POLL_INTERVAL_MS);
  }
}
