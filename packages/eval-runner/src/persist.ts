// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Trial-result persistence. After a run's matrix
 * completes, the worker POSTs every full TrialResult to the cloud gateway
 * (`POST /v1/evals/trials`), which writes the thin score-row index plus a
 * full-fidelity artifact blob per trial.
 *
 * Design rules:
 *  - Persistence is post-grading telemetry: it retries, then LOGS AN ALERT and
 *    moves on — it never throws, and never fails a run whose card is already
 *    written.
 *  - The canonical trial session id is minted HERE (the run backend owns the
 *    recipe); the gateway derives every downstream id by hashing it, and the
 *    trial's AgentSession sync reuses the same id, so scores,
 *    blobs, and session traces all join.
 *  - Chunks respect the server caps (trials per request + serialized bytes).
 */

import type { TrialResult } from "@outerlayer/trial-harness";

/** Server cap mirrored from the gateway route (MAX_TRIALS_PER_REQUEST). */
export const TRIALS_PER_REQUEST = 20;
/** Soft serialized-size budget per request; a single larger trial still ships
 * alone (the server enforces its own per-trial cap with a per-item reject). */
export const CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * Canonical id of one trial's agent session: stable across retries and shared
 * by the trials ingest (score ResourceId derivation) and the AgentSession
 * sync. Changing this recipe orphans previously persisted runs — don't.
 */
export function evalTrialSessionId(
  evalRunId: string,
  taskId: string,
  configId: string,
  trialIndex: number,
): string {
  return `eval:${evalRunId}:${taskId}:${configId}:t${trialIndex}`;
}

export interface PersistTrialsOptions {
  /** Public gateway base URL (e.g. https://api.example.com). */
  gatewayUrl: string;
  /** Per-run gateway API key (score.write + trace.write). */
  apiKey: string;
  /** The run's app id — sent as the app-id header the gateway resolves. */
  appId: string;
  evalRunId: string;
  /** Injection seams for tests. */
  fetchImpl?: typeof fetch;
  /** Structured log line sink (worker stdout by default). */
  log?: (line: Record<string, unknown>) => void;
  /** Attempts per chunk (>=1). Retries cover network errors, 429 and 5xx. */
  maxAttempts?: number;
  /** Backoff base in ms (attempt N waits N*base). 0 in tests. */
  retryDelayMs?: number;
}

export interface PersistTrialsReport {
  total: number;
  /** Trials the gateway accepted (scores + blob written). */
  accepted: number;
  /** Trials the gateway rejected individually (schema/size). */
  rejected: number;
  /** Chunks that never got a 2xx after all attempts — their trials are in
   * neither `accepted` nor `rejected`. */
  failedChunks: number;
}

interface WireTrial {
  sessionId: string;
  result: TrialResult;
}

interface IngestResponse {
  data?: { accepted?: string[]; rejected?: Array<{ reason?: string }> };
}

/** Greedy chunking under both caps; an item over the byte budget ships alone. */
export function chunkTrials<T>(items: T[], maxCount: number, maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const bytes = JSON.stringify(item).length;
    const wouldOverflow = current.length >= maxCount || (current.length > 0 && currentBytes + bytes > maxBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface PostChunkContext {
  fetchImpl: typeof fetch;
  log: (line: Record<string, unknown>) => void;
  maxAttempts: number;
  retryDelayMs: number;
  headers: Record<string, string>;
  /** Alert-line builder for a hard failure (status 0 = network/exhausted). */
  makeAlert: (status: number, detail: string, itemCount: number) => Record<string, unknown>;
}

/** POST one chunk with transient-failure retries (network, 429, 5xx). Returns
 * the parsed payload on 2xx, null after alerting on a hard failure. */
async function postChunkWithRetry(
  url: string,
  body: string,
  itemCount: number,
  ctx: PostChunkContext,
): Promise<IngestResponse | null> {
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    try {
      const res = await ctx.fetchImpl(url, { method: "POST", headers: ctx.headers, body });
      if (res.ok) {
        return (await res.json().catch(() => ({}))) as IngestResponse;
      }
      if (res.status === 429 || res.status >= 500) {
        // Transient — retry below (fall through to the backoff).
      } else {
        // Permanent (auth/contract) — retrying cannot help.
        const detail = (await res.text().catch(() => "")).slice(0, 500);
        ctx.log(ctx.makeAlert(res.status, detail, itemCount));
        return null;
      }
    } catch {
      // Network error — retry below.
    }
    if (attempt < ctx.maxAttempts) await sleep(ctx.retryDelayMs * attempt);
  }
  ctx.log(ctx.makeAlert(0, `no 2xx after ${ctx.maxAttempts} attempts`, itemCount));
  return null;
}

function postContext(opts: PersistTrialsOptions, makeAlert: PostChunkContext["makeAlert"]): PostChunkContext {
  return {
    fetchImpl: opts.fetchImpl ?? fetch,
    log: opts.log ?? ((line) => console.log(JSON.stringify(line))),
    maxAttempts: Math.max(1, opts.maxAttempts ?? 3),
    retryDelayMs: opts.retryDelayMs ?? 250,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      "x-outerlayer-app-id": opts.appId,
    },
    makeAlert,
  };
}

export async function persistTrialResults(
  trials: TrialResult[],
  opts: PersistTrialsOptions,
): Promise<PersistTrialsReport> {
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const url = `${opts.gatewayUrl.replace(/\/+$/, "")}/v1/evals/trials`;
  const ctx = postContext(opts, (status, detail, trialCount) => ({
    _alert: true,
    evt: "eval.persist.failed",
    runId: opts.evalRunId,
    status,
    trials: trialCount,
    detail,
  }));

  const items: WireTrial[] = trials.map((result) => ({
    sessionId: evalTrialSessionId(opts.evalRunId, result.taskId, result.configId, result.trialIndex),
    result,
  }));

  const report: PersistTrialsReport = { total: trials.length, accepted: 0, rejected: 0, failedChunks: 0 };

  for (const chunk of chunkTrials(items, TRIALS_PER_REQUEST, CHUNK_BYTES)) {
    const body = JSON.stringify({ schemaVersion: 1, evalRunId: opts.evalRunId, trials: chunk });
    const payload = await postChunkWithRetry(url, body, chunk.length, ctx);
    if (payload === null) {
      report.failedChunks += 1;
      continue;
    }
    const rejectedItems = payload.data?.rejected ?? [];
    report.accepted += payload.data?.accepted?.length ?? 0;
    report.rejected += rejectedItems.length;
    for (const rejection of rejectedItems) {
      log({ evt: "eval.persist.trial_rejected", runId: opts.evalRunId, reason: rejection.reason ?? "unknown" });
    }
  }

  log({
    evt: "eval.persist.report",
    runId: opts.evalRunId,
    total: report.total,
    accepted: report.accepted,
    rejected: report.rejected,
    failedChunks: report.failedChunks,
  });
  return report;
}

/** Server cap mirrored from the gateway sync route (MAX_SESSIONS_PER_SYNC). */
export const SESSIONS_PER_SYNC = 50;

/**
 * Sync the run's trial AgentSessions to `/v1/agents/sync` so eval
 * trajectories appear in the sessions UI like any other session. Same rules
 * as trial persistence: chunked, retried, alert-and-continue, never throws.
 */
export async function persistTrialSessions(
  sessions: unknown[],
  opts: PersistTrialsOptions,
): Promise<PersistTrialsReport> {
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const url = `${opts.gatewayUrl.replace(/\/+$/, "")}/v1/agents/sync`;
  const ctx = postContext(opts, (status, detail, sessionCount) => ({
    _alert: true,
    evt: "eval.sessions.persist.failed",
    runId: opts.evalRunId,
    status,
    sessions: sessionCount,
    detail,
  }));

  const report: PersistTrialsReport = { total: sessions.length, accepted: 0, rejected: 0, failedChunks: 0 };

  for (const chunk of chunkTrials(sessions, SESSIONS_PER_SYNC, CHUNK_BYTES)) {
    const body = JSON.stringify({ schemaVersion: 1, sessions: chunk });
    const payload = await postChunkWithRetry(url, body, chunk.length, ctx);
    if (payload === null) {
      report.failedChunks += 1;
      continue;
    }
    const rejectedItems = payload.data?.rejected ?? [];
    report.accepted += payload.data?.accepted?.length ?? 0;
    report.rejected += rejectedItems.length;
    for (const rejection of rejectedItems) {
      log({ evt: "eval.sessions.session_rejected", runId: opts.evalRunId, reason: rejection.reason ?? "unknown" });
    }
  }

  log({
    evt: "eval.sessions.report",
    runId: opts.evalRunId,
    total: report.total,
    accepted: report.accepted,
    rejected: report.rejected,
    failedChunks: report.failedChunks,
  });
  return report;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
