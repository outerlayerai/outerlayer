// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { AgentSession } from "@outerlayer/session-schema";
import type { DetectionSession } from "./types.js";

/**
 * Canonical entry: normalize a parsed `AgentSession` into the lean
 * `DetectionSession` detectors read. This is what the cloud path calls, so
 * detectors run identically on cloud data and local scans. The local store
 * produces `DetectionSession` directly from SQLite; both feed one detector set.
 */
export function fromAgentSession(s: AgentSession): DetectionSession {
  return {
    id: s.id,
    actorId: s.actor?.id ?? null,
    project: s.env.gitRepo ?? s.env.cwd ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    models: s.models,
    costUsd: s.totals.costUsd ?? null,
    tokens: {
      input: s.totals.inputTokens,
      output: s.totals.outputTokens,
      cacheRead: s.totals.cacheReadTokens,
      cacheCreation: s.totals.cacheCreationTokens,
    },
    isSubagent: s.subagent ? 1 : 0,
    turns: s.turns.map((t) => ({
      index: t.index,
      role: t.role,
      ts: t.ts ?? null,
      toolCalls: t.toolCalls.map((c) => ({
        name: c.name,
        status: c.status,
        isEdit: c.isEdit,
        file: c.file ?? null,
        errorSignature: c.errorSignature ?? null,
      })),
    })),
    events: s.events.map((e) => ({ type: e.type, ts: e.ts ?? null, data: e.data ?? null })),
  };
}
