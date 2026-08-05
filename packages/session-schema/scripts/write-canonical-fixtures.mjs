#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Writes the canonical AgentSession example fixtures + the published JSON
// Schema. Run after `yarn build` (imports from dist). Committed outputs are
// golden-tested byte-for-byte.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAgentSession,
  downconvertSession,
  canonicalStringify,
  agentSessionJsonSchema,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANONICAL_DIR = join(HERE, "..", "fixtures", "canonical");
mkdirSync(CANONICAL_DIR, { recursive: true });

const minimal = {
  schemaVersion: 1,
  id: "0f0e0d0c-0b0a-4908-8706-050403020100",
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

const full = {
  schemaVersion: 1,
  id: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
  agent: { type: "claude-code", version: "2.1.193", entrypoint: "cli" },
  actor: { id: "member-7f3a", email: "dev@example.com" },
  env: {
    cwd: "/home/dev/acme-api",
    gitRepo: "github.com/acme/acme-api",
    gitBranch: "fix/rate-limit-window",
    os: "darwin",
  },
  startedAt: "2026-07-01T14:03:11.000Z",
  endedAt: "2026-07-01T14:41:52.000Z",
  models: ["claude-opus-4-8"],
  turns: [
    {
      index: 0,
      role: "user",
      ts: "2026-07-01T14:03:11.000Z",
      toolCalls: [],
      text: "The rate limiter resets at the wrong boundary — fix it and add a test.",
    },
    {
      index: 1,
      role: "assistant",
      ts: "2026-07-01T14:03:19.000Z",
      model: "claude-opus-4-8",
      usage: { in: 9, out: 412, cacheRead: 18230, cacheCreate: 2048 },
      costUsd: 0.0389,
      durationMs: 152340,
      toolCalls: [
        {
          name: "Read",
          startTs: "2026-07-01T14:03:24.000Z",
          durationMs: 180,
          status: "ok",
          isEdit: false,
          file: "src/rate-limit.ts",
        },
        {
          name: "Edit",
          startTs: "2026-07-01T14:04:02.000Z",
          durationMs: 240,
          status: "error",
          isEdit: true,
          file: "src/rate-limit.ts",
          errorSignature: "String to replace not found in file",
          input: { old_string: "window.start", new_string: "window.floorStart" },
          output: "Error: String to replace not found in file.",
        },
        {
          name: "Edit",
          startTs: "2026-07-01T14:04:31.000Z",
          durationMs: 220,
          status: "ok",
          isEdit: true,
          file: "src/rate-limit.ts",
          input: { old_string: "windowStart", new_string: "floorToWindow(start)" },
        },
      ],
      text: "Found it — the window floor used the request timestamp. Fixed and adding a regression test.",
    },
  ],
  events: [
    { type: "compaction", seq: 0, ts: "2026-07-01T14:30:00.000Z", data: { trigger: "auto" } },
    { type: "pr_linked", seq: 1, ts: "2026-07-01T14:41:00.000Z", data: { prNumber: 481 } },
  ],
  totals: {
    inputTokens: 9,
    outputTokens: 412,
    cacheReadTokens: 18230,
    cacheCreationTokens: 2048,
    costUsd: 0.0389,
    wallClockMs: 2321000,
  },
  outcome: { prNumber: 481, prUrl: "https://github.com/acme/acme-api/pull/481" },
  title: "Fix rate limiter window boundary",
  vendor: { slug: "fix-rate-limiter" },
  captureTier: "full",
  warnings: [{ code: "unknown_line_type", count: 2, detail: "line type wave-checkpoint" }],
};

const subagent = {
  schemaVersion: 1,
  id: "77777777-7777-4777-8777-777777777777",
  agent: { type: "claude-code", version: "2.1.177" },
  env: { cwd: "/home/dev/acme-api", gitBranch: "fix/rate-limit-window" },
  subagent: { agentId: "a1b2c3d4e5f60718", parentSessionId: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b" },
  startedAt: "2026-07-01T14:10:00.000Z",
  endedAt: "2026-07-01T14:12:30.000Z",
  models: ["claude-haiku-4-5-20251001"],
  turns: [
    {
      index: 0,
      role: "assistant",
      ts: "2026-07-01T14:10:05.000Z",
      model: "claude-haiku-4-5-20251001",
      usage: { in: 3, out: 120, cacheRead: 950, cacheCreate: 0 },
      costUsd: 0.0007,
      toolCalls: [
        { name: "Grep", status: "ok", isEdit: false },
        { name: "Read", status: "ok", isEdit: false, file: "src/window.ts" },
      ],
      text: null,
    },
  ],
  events: [],
  totals: { inputTokens: 3, outputTokens: 120, cacheReadTokens: 950, cacheCreationTokens: 0, costUsd: 0.0007 },
  captureTier: "redacted",
  warnings: [],
};

const validatedFull = parseAgentSession(full);
const fixtures = {
  "minimal.json": parseAgentSession(minimal),
  "full.json": validatedFull,
  "subagent-redacted.json": parseAgentSession(subagent),
  "downconverted-redacted.json": parseAgentSession(downconvertSession(validatedFull, "redacted")),
  "downconverted-metrics.json": parseAgentSession(downconvertSession(validatedFull, "metrics")),
};

for (const [name, value] of Object.entries(fixtures)) {
  writeFileSync(join(CANONICAL_DIR, name), canonicalStringify(value, 2) + "\n");
}
writeFileSync(
  join(HERE, "..", "fixtures", "agent-session.v1.schema.json"),
  canonicalStringify(agentSessionJsonSchema(), 2) + "\n",
);
console.log(`wrote ${Object.keys(fixtures).length} canonical fixtures + JSON Schema`);
