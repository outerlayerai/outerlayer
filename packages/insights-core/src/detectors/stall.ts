// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Detector, Finding } from "../types.js";

const th = (c: { thresholds: Record<string, Record<string, number>> }, id: string, k: string, d: number) =>
  c.thresholds[id]?.[k] ?? d;

/**
 * api-error-stall — a burst of API errors in one session. The agent is
 * stalled retrying (rate limits, 5xx, overloaded), not progressing — and on
 * partial-stream failures the re-sent context still bills. Bursts usually mean
 * a provider incident or an oversized context, both worth knowing about live.
 */
export const apiErrorStall: Detector = {
  id: "api-error-stall",
  scope: "session",
  severity: "warn",
  docs: {
    rationale: "≥3 API errors in a session — the agent is stalled on provider errors or context limits; wall-clock burns while nothing progresses.",
    costFormula: "no direct $ attached (failed calls mostly aren't billed); flags the stall pattern.",
  },
  run(sessions, config): Finding[] {
    const minErrors = th(config, this.id, "minErrors", 3);
    const findings: Finding[] = [];
    for (const s of sessions) {
      const errs = s.events.filter((e) => e.type === "api_error");
      if (errs.length < minErrors) continue;
      findings.push({
        detectorId: this.id,
        severity: "warn",
        sessionIds: [s.id],
        summary: `${errs.length} API errors in one session — stalled retrying, not progressing`,
        evidence: errs.slice(0, 3).map((e) => ({ sessionId: s.id, note: `api_error${e.ts ? ` at ${e.ts}` : ""}` })),
        costUsd: null,
        timeMin: null,
        suggestion: "Bursts of API errors are usually a provider incident or an oversized context — check status, and prefer waiting over re-prompting (each retry re-sends everything).",
      });
    }
    return findings;
  },
};
