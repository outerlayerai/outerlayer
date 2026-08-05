// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Trial trajectory → AgentSession.
 *
 * Each trial's raw launcher transcript (surfaced by the harness's
 * `onTranscript` seam) is parsed with the SAME @outerlayer/capture adapters
 * that parse local developer sessions — reuse, never re-parse — then stamped
 * with the trial's canonical identity so scores, artifact blobs, and the
 * session trace all join on one id. Synced sessions appear in the sessions UI
 * like any other coding-agent session.
 *
 * Degradation ladder (a session is telemetry; it never blocks persistence):
 * unknown launcher / empty / unparseable transcript → a minimal synthetic
 * session carrying the TrajectorySummary counters; a session that somehow
 * fails schema validation is skipped with a log line.
 */

import { parseTranscript, parseCodexRollout } from "@outerlayer/capture";
import {
  SCHEMA_VERSION,
  safeParseAgentSession,
  type AgentSession,
} from "@outerlayer/session-schema";
import type { TrialResult } from "@outerlayer/trial-harness";
import { evalTrialSessionId } from "./persist.js";

/** What the worker collects per trial from the harness's onTranscript seam. */
export interface TrialTranscript {
  transcript: string;
  launcher: string;
}

export interface BuildTrialSessionsOptions {
  evalRunId: string;
  /** Stamped as env.gitRepo — the sessions UI's repo join key. */
  repoLabel?: string;
  /** Wall-clock anchor for reconstructed timestamps (default: now). Trial
   * results carry durations, not absolute times, so each session is anchored
   * to the run's completion and dated backwards by its own total duration. */
  completedAt?: Date;
  log?: (line: Record<string, unknown>) => void;
}

/** Launcher id → capture parser. Anything else gets the synthetic fallback. */
function parseByLauncher(
  launcher: string,
  transcript: string,
  fallbackId: string,
): AgentSession | null {
  if (launcher === "claude-code") {
    return parseTranscript(transcript, { fallbackId, agentType: "claude-code" }).session;
  }
  if (launcher === "codex") {
    return parseCodexRollout(transcript, { fallbackId }).session;
  }
  return null;
}

/** Minimal synthetic session from the trial's own summary counters. */
function syntheticSession(trial: TrialResult, sessionId: string, launcher: string): AgentSession {
  const trajectory = trial.trajectory;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: sessionId,
    agent: { type: launcher || trajectory?.launcher || "unknown" },
    env: {},
    startedAt: new Date(0).toISOString(), // overridden by stampTrialIdentity
    models: [],
    turns: [],
    events: [],
    totals: {
      inputTokens: trajectory?.inputTokens ?? 0,
      outputTokens: trajectory?.outputTokens ?? 0,
      cacheReadTokens: trajectory?.cacheReadTokens ?? 0,
      cacheCreationTokens: 0,
      costUsd: trial.cost.usd,
    },
    captureTier: "full",
    warnings: [],
  };
}

/**
 * Force the trial's canonical identity onto a session (parsed or synthetic):
 * deterministic id, eval title, repo join key, reconstructed timestamps, and
 * the eval identity block under `vendor.eval`.
 */
function stampTrialIdentity(
  session: AgentSession,
  trial: TrialResult,
  sessionId: string,
  opts: BuildTrialSessionsOptions,
): AgentSession {
  const endedAt = opts.completedAt ?? new Date();
  // Launcher transcripts (stream-json / rollout tees) often carry no absolute
  // timestamps, which would otherwise strand the session at epoch 1970 (and
  // straight into retention TTLs). Anchor to the run's completion instead.
  const startedAt = new Date(endedAt.getTime() - Math.max(1, trial.timings.totalMs));
  return {
    ...session,
    id: sessionId,
    // Eval trials run on the managed worker fleet, never a developer seat.
    workerKind: "cloud",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    title: `Eval trial ${trial.taskId} × ${trial.configId} #${trial.trialIndex}`,
    env: {
      ...session.env,
      ...(opts.repoLabel ? { gitRepo: opts.repoLabel } : {}),
    },
    totals: {
      ...session.totals,
      ...(trial.timings.agentMs > 0 ? { wallClockMs: trial.timings.agentMs } : {}),
    },
    vendor: {
      ...(session.vendor as Record<string, unknown> | undefined),
      eval: {
        evalRunId: opts.evalRunId,
        taskId: trial.taskId,
        configId: trial.configId,
        trialIndex: trial.trialIndex,
        status: trial.status,
        resolved: trial.resolved,
        attempt: trial.attempt,
      },
    },
  };
}

/** Build one trial's AgentSession. Null only when the stamped session fails
 * schema validation (logged) — malformed transcripts degrade instead. */
export function buildTrialSession(
  trial: TrialResult,
  transcript: TrialTranscript | undefined,
  opts: BuildTrialSessionsOptions,
): AgentSession | null {
  const log = opts.log ?? ((line) => console.log(JSON.stringify(line)));
  const sessionId = evalTrialSessionId(opts.evalRunId, trial.taskId, trial.configId, trial.trialIndex);
  const launcher = transcript?.launcher ?? trial.trajectory?.launcher ?? "";

  let base: AgentSession | null = null;
  if (transcript?.transcript) {
    try {
      base = parseByLauncher(launcher, transcript.transcript, sessionId);
    } catch (err) {
      log({
        evt: "eval.sessions.parse_failed",
        sessionId,
        launcher,
        detail: String(err instanceof Error ? err.message : err).slice(0, 200),
      });
    }
  }

  const stamped = stampTrialIdentity(base ?? syntheticSession(trial, sessionId, launcher), trial, sessionId, opts);
  const validated = safeParseAgentSession(stamped);
  if (!validated.success) {
    log({
      evt: "eval.sessions.invalid",
      sessionId,
      detail: validated.error.issues[0]?.message ?? "schema validation failed",
    });
    return null;
  }
  return validated.data;
}

/** Build sessions for a whole run. `transcripts` is keyed by the canonical
 * trial session id (the worker's onTranscript collector). */
export function buildTrialSessions(
  trials: TrialResult[],
  transcripts: Map<string, TrialTranscript>,
  opts: BuildTrialSessionsOptions,
): AgentSession[] {
  const sessions: AgentSession[] = [];
  for (const trial of trials) {
    const sessionId = evalTrialSessionId(opts.evalRunId, trial.taskId, trial.configId, trial.trialIndex);
    const session = buildTrialSession(trial, transcripts.get(sessionId), opts);
    if (session) sessions.push(session);
  }
  return sessions;
}
