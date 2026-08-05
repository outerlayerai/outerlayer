// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { AgentSession } from "../schema.js";

/** Sentinel planted in every content-bearing field; tier tests assert it
 * cannot survive down-conversion. */
export const SECRET = "SECRET_CONTENT_c4n4ry";

export function minimalSession(): AgentSession {
  return {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    agent: { type: "claude-code" },
    env: {},
    startedAt: "2026-07-01T10:00:00.000Z",
    models: [],
    turns: [],
    events: [],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    captureTier: "metrics",
    warnings: [],
  };
}

/** A full-tier session with EVERY tier-gated field populated (with SECRET
 * where the field is content-bearing) and multiple array elements, so the
 * down-conversion property test exercises `[]` traversal. */
export function richSession(): AgentSession {
  return {
    schemaVersion: 1,
    id: "22222222-2222-4222-8222-222222222222",
    agent: { type: "claude-code", version: "2.1.193", entrypoint: "cli" },
    actor: { id: "member-42", email: `${SECRET}@example.com` },
    env: {
      cwd: `/home/${SECRET}/project`,
      gitRepo: `github.com/${SECRET}/repo`,
      gitBranch: `feature/${SECRET}`,
      os: "darwin",
    },
    subagent: { agentId: "a1b2c3d4e5f60708", parentSessionId: "33333333-3333-4333-8333-333333333333" },
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T11:30:00.000Z",
    models: ["claude-opus-4-8", "claude-haiku-4-5-20251001"],
    turns: [
      {
        index: 0,
        role: "user",
        ts: "2026-07-01T10:00:00.000Z",
        toolCalls: [],
        text: `please fix ${SECRET}`,
      },
      {
        index: 1,
        role: "assistant",
        ts: "2026-07-01T10:00:10.000Z",
        model: "claude-opus-4-8",
        usage: { in: 12, out: 340, cacheRead: 5000, cacheCreate: 900 },
        costUsd: 0.0421,
        durationMs: 158168,
        toolCalls: [
          {
            name: "Edit",
            startTs: "2026-07-01T10:00:12.000Z",
            durationMs: 250,
            status: "error",
            isEdit: true,
            file: `src/${SECRET}.ts`,
            errorSignature: `String to replace not found in ${SECRET}`,
            input: { old_string: SECRET, new_string: "fixed" },
            output: `Error: ${SECRET} not found`,
          },
          {
            name: "Bash",
            status: "rejected",
            isEdit: false,
            input: { command: `rm -rf ${SECRET}` },
          },
        ],
        text: `I will fix ${SECRET}`,
        vendor: { attributionSkill: SECRET },
      },
    ],
    events: [
      { type: "compaction", seq: 0, ts: "2026-07-01T10:40:00.000Z", data: { trigger: SECRET } },
      { type: "pr_linked", seq: 1, turnIndex: 1, data: { prNumber: 77, repo: SECRET } },
    ],
    totals: {
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheCreationTokens: 900,
      costUsd: 0.0421,
      wallClockMs: 5400000,
    },
    outcome: { commitShas: ["deadbeef"], prNumber: 77, prUrl: `https://github.com/x/${SECRET}/pull/77` },
    title: `Fixing ${SECRET}`,
    vendor: { rawLineTypes: [SECRET] },
    captureTier: "full",
    warnings: [
      { code: "unknown_line_type", count: 3, detail: `line type ${SECRET}` },
      { code: "ambiguous_timezone", count: 1 },
    ],
  };
}
