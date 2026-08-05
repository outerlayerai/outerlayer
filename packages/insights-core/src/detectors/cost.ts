// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Detector, DetectionSession, Finding } from "../types.js";
import { isError, toolCalls, shortProject, round } from "../helpers.js";
import { findEditRetryRun } from "./edit-loops.js";

const th = (c: { thresholds: Record<string, Record<string, number>> }, id: string, k: string, d: number) =>
  c.thresholds[id]?.[k] ?? d;

/** A concrete, checkable reason an expensive session was *wasteful* rather
 * than merely long. */
export interface OutlierCause {
  key: "edit-retry" | "api-errors" | "error-storm" | "cache-thrash";
  note: string;
}

const CAUSE_SUGGESTIONS: Record<OutlierCause["key"], string> = {
  "edit-retry": "Break the loop earlier: re-read the file (stale anchors) or intervene after the 2nd identical failure.",
  "api-errors": "Bursts of API errors mean provider trouble or oversized context — each retry re-sends the whole context.",
  "error-storm": "A high tool-failure rate has one root cause more often than many — check the top recurring error.",
  "cache-thrash": "The cache is being rebuilt instead of read — long gaps between turns outlive the cache TTL (the classic runaway-loop bill).",
};

/**
 * Why was this session expensive? Only reasons we can point at count.
 * No causes → the session was probably just big, honest work — stay silent.
 */
export function diagnoseCauses(s: DetectionSession): OutlierCause[] {
  const causes: OutlierCause[] = [];
  const loop = findEditRetryRun(s);
  if (loop && loop.fails >= 3) {
    causes.push({ key: "edit-retry", note: `stuck retrying an edit to ${loop.file.split(/[/\\]/).pop()} (${loop.fails}× consecutive failures)` });
  }
  const apiErrors = s.events.filter((e) => e.type === "api_error").length;
  if (apiErrors >= 3) {
    causes.push({ key: "api-errors", note: `${apiErrors} API errors — every retry re-sends the full context` });
  }
  const calls = toolCalls(s);
  const errs = calls.filter(isError).length;
  if (calls.length >= 20 && errs / calls.length >= 0.15) {
    causes.push({ key: "error-storm", note: `${Math.round((100 * errs) / calls.length)}% of ${calls.length} tool calls failed` });
  }
  const { cacheRead, cacheCreation } = s.tokens;
  if (cacheCreation >= 1_000_000 && cacheCreation > cacheRead) {
    causes.push({ key: "cache-thrash", note: `rebuilt ${(cacheCreation / 1e6).toFixed(1)}M cache tokens but read only ${(cacheRead / 1e6).toFixed(1)}M — cache dying before reuse` });
  }
  return causes;
}

/**
 * cost-outlier — a session far above the team's p95 cost AND with a concrete
 * waste pattern explaining why. Expensive-but-clean sessions are NOT flagged:
 * long ≠ wasteful, and flagging productive marathons is how a tool loses
 * trust. The gate is what separates "your biggest build of the week" from
 * "the $6k overnight cache-death loop".
 */
export const costOutlier: Detector = {
  id: "cost-outlier",
  scope: "team",
  severity: "warn",
  docs: {
    rationale: "Cost far above the corpus p95 AND a checkable waste cause (retry loop, API-error burst, error storm, cache thrash). Expensive sessions with no cause are treated as productive work and skipped.",
    costFormula: "overage above the p95 baseline (session cost − p95).",
  },
  run(sessions, config): Finding[] {
    const mult = th(config, this.id, "p95Multiplier", 1.5);
    const p95 = config.baselines.costP95;
    const findings: Finding[] = [];
    if (p95 <= 0) return findings;
    for (const s of sessions) {
      if (s.costUsd == null || s.costUsd < p95 * mult) continue;
      const causes = diagnoseCauses(s);
      if (causes.length === 0) continue;
      const primary = causes[0]!;
      findings.push({
        detectorId: this.id,
        severity: "warn",
        sessionIds: [s.id],
        summary: `${shortProject(s.project)} session cost $${s.costUsd.toFixed(2)} (${(s.costUsd / p95).toFixed(0)}× the team's p95) — ${primary.note}`,
        evidence: causes.map((c) => ({ sessionId: s.id, note: c.note })),
        costUsd: round(s.costUsd - p95),
        timeMin: null,
        suggestion: CAUSE_SUGGESTIONS[primary.key],
      });
    }
    return findings;
  },
};
