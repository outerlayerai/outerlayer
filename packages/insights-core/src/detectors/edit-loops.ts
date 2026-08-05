// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Detector, DetectionSession, Finding } from "../types.js";
import { isEdit, isError, toolCalls, costPerToken, round } from "../helpers.js";

const th = (c: { thresholds: Record<string, Record<string, number>> }, id: string, k: string, d: number) =>
  c.thresholds[id]?.[k] ?? d;

export interface EditRetryRun {
  file: string;
  fails: number;
  turn?: number;
}

/**
 * Longest run of consecutive failed edits to a single file (a success to that
 * file resets its run). Shared by edit-retry-loop and cost-outlier's cause
 * diagnosis — one definition of "stuck in an edit loop".
 */
export function findEditRetryRun(s: DetectionSession): EditRetryRun | null {
  const byFile = new Map<string, { fails: number; firstTurn?: number }>();
  let worst: EditRetryRun | null = null;
  for (const t of s.turns) {
    for (const c of t.toolCalls) {
      if (!isEdit(c) || !c.file) continue;
      const st = byFile.get(c.file) ?? { fails: 0 };
      if (isError(c)) {
        st.fails += 1;
        if (st.firstTurn === undefined) st.firstTurn = t.index;
        if (!worst || st.fails > worst.fails) worst = { file: c.file, fails: st.fails, turn: st.firstTurn };
      } else {
        st.fails = 0;
        st.firstTurn = undefined;
      }
      byFile.set(c.file, st);
    }
  }
  return worst;
}

/**
 * edit-retry-loop — ≥N consecutive FAILED edits to the same file. The agent is
 * stuck re-trying an edit it can't land (usually a stale `old_string`). Every
 * attempt burns tokens for zero progress. The best-documented coding-agent
 * waste pattern (claude-code#18421 "I lost money", #19699, #29944).
 */
export const editRetryLoop: Detector = {
  id: "edit-retry-loop",
  scope: "session",
  severity: "high",
  docs: {
    rationale: "≥3 consecutive failed edits to one file means the agent is stuck retrying an edit it can't apply — pure wasted spend until it breaks out.",
    costFormula: "sum over loop tool-calls of (session $/token × est. tokens/call); est. tokens/call = session tokens / tool-call count.",
  },
  run(sessions, config): Finding[] {
    const minRun = th(config, this.id, "minConsecutive", 3);
    const findings: Finding[] = [];
    for (const s of sessions) {
      const worst = findEditRetryRun(s);
      if (!worst || worst.fails < minRun) continue;
      const cpt = costPerToken(s);
      const totalTokens = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
      const calls = Math.max(1, toolCalls(s).length);
      const loopTokens = (totalTokens / calls) * worst.fails;
      const cost = cpt !== null ? round(cpt * loopTokens) : null;
      findings.push({
        detectorId: this.id,
        severity: "high",
        sessionIds: [s.id],
        summary: `Agent retried the same edit to ${basename(worst.file)} ${worst.fails}× in a row without success`,
        evidence: [{ sessionId: s.id, turnIndex: worst.turn, note: worst.file }],
        costUsd: cost,
        timeMin: null,
        suggestion: "The edit's target text is likely stale — re-read the file before editing, or use a smaller anchor.",
      });
    }
    return findings;
  },
};

function basename(f: string): string {
  return f.split(/[/\\]/).pop() ?? f;
}
