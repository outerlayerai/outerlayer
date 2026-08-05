// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Detector, Finding, EvidenceRef } from "../types.js";
import { isError, toolCalls } from "../helpers.js";

const th = (c: { thresholds: Record<string, Record<string, number>> }, id: string, k: string, d: number) =>
  c.thresholds[id]?.[k] ?? d;

/**
 * tool-error-cluster (team-scope) — the same normalized error signature recurs
 * across many sessions. "Your agents keep hitting X" — a systemic problem
 * (missing dep, broken command, wrong path convention) worth a one-time fix
 * rather than N agents each fumbling it. Aggregates by PATTERN, never by person.
 *
 * Locally this runs single-actor (one developer's sessions); in the cloud
 * the ≥2-actor rule makes it a team signal. It reports the cross-actor count
 * when actor ids are present.
 */
export const toolErrorCluster: Detector = {
  id: "tool-error-cluster",
  scope: "team",
  severity: "high",
  docs: {
    rationale: "One normalized error signature recurring across many sessions is a systemic issue — fix it once instead of every agent re-hitting it.",
    costFormula: "occurrences × est. tokens/occurrence × median session $/token across the affected sessions.",
  },
  run(sessions, config): Finding[] {
    const minOccurrences = th(config, this.id, "minOccurrences", 5);
    const minSessions = th(config, this.id, "minSessions", 3);
    // signature → { count, sessions, actors, sampleTool, evidence }
    const clusters = new Map<string, { count: number; sessions: Set<string>; actors: Set<string>; tool: string; evidence: EvidenceRef[] }>();
    const cptBySession = new Map<string, number>();
    for (const s of sessions) {
      const totalTokens = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
      if (s.costUsd && totalTokens > 0) cptBySession.set(s.id, s.costUsd / totalTokens);
      for (const t of s.turns) {
        for (const c of t.toolCalls) {
          if (!isError(c) || !c.errorSignature) continue;
          const key = `${c.name}::${c.errorSignature}`;
          const cl = clusters.get(key) ?? { count: 0, sessions: new Set(), actors: new Set(), tool: c.name, evidence: [] };
          cl.count += 1;
          cl.sessions.add(s.id);
          if (s.actorId) cl.actors.add(s.actorId);
          if (cl.evidence.length < 5) cl.evidence.push({ sessionId: s.id, turnIndex: t.index, note: c.errorSignature });
          clusters.set(key, cl);
        }
      }
    }
    const findings: Finding[] = [];
    for (const [key, cl] of clusters) {
      if (cl.count < minOccurrences || cl.sessions.size < minSessions) continue;
      const signature = key.split("::").slice(1).join("::");
      // price: occurrences × median tokens/call × median $/token across affected sessions
      const cpts = [...cl.sessions].map((id) => cptBySession.get(id)).filter((x): x is number => x !== undefined);
      const medCpt = cpts.length ? cpts.sort((a, b) => a - b)[Math.floor(cpts.length / 2)]! : null;
      const affected = [...cl.sessions].map((id) => sessions.find((s) => s.id === id)!).filter(Boolean);
      const avgTokensPerCall =
        affected.reduce((sum, s) => {
          const tt = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreation;
          return sum + tt / Math.max(1, toolCalls(s).length);
        }, 0) / Math.max(1, affected.length);
      const cost = medCpt !== null ? Math.round(medCpt * avgTokensPerCall * cl.count * 100) / 100 : null;
      const actorNote = cl.actors.size >= 2 ? ` across ${cl.actors.size} developers` : "";
      findings.push({
        detectorId: this.id,
        severity: "high",
        sessionIds: [...cl.sessions],
        summary: `${cl.tool} keeps failing with "${truncate(signature, 60)}" — ${cl.count}× in ${cl.sessions.size} sessions${actorNote}`,
        evidence: cl.evidence,
        costUsd: cost,
        timeMin: null,
        suggestion: "A repeated tool error is usually one fixable root cause (missing dep, wrong path, broken command) — fix it once for every agent.",
      });
    }
    return findings;
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
