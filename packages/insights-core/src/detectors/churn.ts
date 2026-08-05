// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Detector, Finding } from "../types.js";

const th = (c: { thresholds: Record<string, Record<string, number>> }, id: string, k: string, d: number) =>
  c.thresholds[id]?.[k] ?? d;

/**
 * context-churn — repeated context compaction in one session. Compaction is
 * lossy and expensive: the work outgrew the window and the agent keeps paying
 * to reconstruct context it lost (claude-code#13579's "700K tokens wasted"
 * pattern). One compaction is normal for long work; repeated compaction is
 * the churn signal.
 */
export const contextChurn: Detector = {
  id: "context-churn",
  scope: "session",
  severity: "info",
  docs: {
    rationale: "≥2 compactions in a session — the work outgrew the context window and the agent keeps paying to rebuild lost context.",
    costFormula: "time-only in v1 (compaction cost isn't separately measured); flags the churn pattern.",
  },
  run(sessions, config): Finding[] {
    const minCompactions = th(config, this.id, "minCompactions", 2);
    const findings: Finding[] = [];
    for (const s of sessions) {
      const compactions = s.events.filter((e) => e.type === "compaction").length;
      if (compactions < minCompactions) continue;
      findings.push({
        detectorId: this.id,
        severity: "info",
        sessionIds: [s.id],
        summary: `${compactions} context compactions — the session repeatedly outgrew its window`,
        evidence: [{ sessionId: s.id, note: `${compactions} compaction events` }],
        costUsd: null,
        timeMin: null,
        suggestion: "Long sessions that compact repeatedly lose context — split the task, or restart with a focused prompt instead of compacting again.",
      });
    }
    return findings;
  },
};
