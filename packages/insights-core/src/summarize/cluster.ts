// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { DetectionSession } from "../types.js";
import { isError } from "../helpers.js";
import type { ErrorCluster } from "./types.js";

/** Below this occurrence count an error is noise, not a pattern. */
const MIN_OCCURRENCES = 3;
/** Hard cap on clusters handed to the labeling model (bounds the prompt). */
const MAX_CLUSTERS = 30;

/**
 * The deterministic half of summarization: group failed tool calls by normalized error
 * signature. Pure — same sessions in, same clusters out, no model anywhere.
 * The LLM (summarize.ts) only ever labels what this function found.
 *
 * Errors without a signature are skipped (nothing to cluster on), matching
 * the tool-error-cluster detector. Sorted by occurrences desc (key asc as the
 * deterministic tie-break), clusters with <3 occurrences dropped, capped at 30.
 */
export function clusterErrorSignatures(sessions: DetectionSession[]): ErrorCluster[] {
  const byKey = new Map<string, { tool: string; signature: string; occurrences: number; sessions: Set<string>; actors: Set<string> }>();
  for (const s of sessions) {
    for (const t of s.turns) {
      for (const c of t.toolCalls) {
        if (!isError(c) || !c.errorSignature) continue;
        const key = `${c.name}::${c.errorSignature}`;
        const cl = byKey.get(key) ?? { tool: c.name, signature: c.errorSignature, occurrences: 0, sessions: new Set<string>(), actors: new Set<string>() };
        cl.occurrences += 1;
        cl.sessions.add(s.id);
        if (s.actorId) cl.actors.add(s.actorId);
        byKey.set(key, cl);
      }
    }
  }
  return [...byKey.entries()]
    .map(([key, cl]) => ({
      key,
      tool: cl.tool,
      signature: cl.signature,
      occurrences: cl.occurrences,
      sessionIds: [...cl.sessions],
      actorCount: cl.actors.size,
    }))
    .filter((cl) => cl.occurrences >= MIN_OCCURRENCES)
    .sort((a, b) => b.occurrences - a.occurrences || a.key.localeCompare(b.key))
    .slice(0, MAX_CLUSTERS);
}
