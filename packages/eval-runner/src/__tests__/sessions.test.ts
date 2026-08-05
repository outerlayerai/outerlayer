// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import type { TrialResult } from "@outerlayer/trial-harness";
import { evalTrialSessionId } from "../persist.js";
import { buildTrialSession, buildTrialSessions } from "../sessions.js";

const RUN_ID = "d4f7a2b1-9c3e-4f5a-8b6d-1e2f3a4b5c6d";
const COMPLETED_AT = new Date("2026-07-12T20:00:00.000Z");

function trial(over: Partial<TrialResult> = {}): TrialResult {
  return {
    schemaVersion: 1,
    taskId: "fix-divide",
    configId: "opus",
    trialIndex: 0,
    status: "graded",
    resolved: true,
    failToPass: [{ id: "tests/test_divide.py::t", outcome: "pass" }],
    passToPass: [],
    patch: "--- a/calc.py\n",
    patchApplyOk: true,
    trajectory: {
      launcher: "claude-code",
      turns: 2,
      toolCalls: 1,
      toolErrors: 0,
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 300,
      wallClockMs: 40000,
    },
    cost: { usd: 0.42, source: "measured" },
    leak: {
      agentWorktreeClean: true,
      transcriptClean: true,
      gradeOffline: true,
      patchesNeverInAgentSandbox: true,
      frozenPatchIntact: true,
    },
    quarantinedSkipped: [],
    attempt: 1,
    timings: { agentMs: 40000, gradeMs: 15000, totalMs: 55000 },
    ...over,
  };
}

/** A realistic `claude -p --output-format stream-json --verbose` tee: the
 * lines carry snake_case session_id and NO per-line timestamps — exactly the
 * shape that must neither hijack the canonical id nor strand the session at
 * epoch 1970. */
const STREAM_JSON = [
  JSON.stringify({ type: "system", subtype: "init", cwd: "/repo", session_id: "sess-raw", model: "claude-opus-4-8" }),
  JSON.stringify({
    type: "assistant",
    session_id: "sess-raw",
    message: {
      id: "msg_01",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "Fixing the divide-by-zero bug." },
        { type: "tool_use", id: "toolu_01", name: "Edit", input: { file_path: "calc.py" } },
      ],
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300 },
    },
  }),
  JSON.stringify({
    type: "user",
    session_id: "sess-raw",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }] },
  }),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.05, session_id: "sess-raw" }),
].join("\n");

const OPTS = { evalRunId: RUN_ID, repoLabel: "acme/calc", completedAt: COMPLETED_AT, log: () => {} };
const SESSION_ID = evalTrialSessionId(RUN_ID, "fix-divide", "opus", 0);

describe("buildTrialSession — claude-code transcript", () => {
  const session = buildTrialSession(trial(), { transcript: STREAM_JSON, launcher: "claude-code" }, OPTS)!;

  it("parses the stream-json tee via the capture adapter (turns, tools, usage)", () => {
    expect(session.agent.type).toBe("claude-code");
    expect(session.models).toEqual(["claude-opus-4-8"]);
    expect(session.turns[0]!.role).toBe("assistant");
    expect(session.turns[0]!.toolCalls).toEqual([
      expect.objectContaining({ name: "Edit", isEdit: true, status: "ok" }),
    ]);
    expect(session.totals.inputTokens).toBe(1200);
    expect(session.totals.outputTokens).toBe(80);
    expect(session.totals.cacheReadTokens).toBe(300);
  });

  it("forces the canonical trial identity over anything the transcript claims", () => {
    // NOT the transcript's own session id — the deterministic trial id that
    // scores/blobs join on.
    expect(session.id).toBe(SESSION_ID);
    expect(session.title).toBe("Eval trial fix-divide × opus #0");
    expect(session.env.gitRepo).toBe("acme/calc");
    // AC-3: eval trials run on the managed fleet, never a developer seat.
    expect(session.workerKind).toBe("cloud");
    expect(session.vendor).toEqual(
      expect.objectContaining({
        eval: {
          evalRunId: RUN_ID,
          taskId: "fix-divide",
          configId: "opus",
          trialIndex: 0,
          status: "graded",
          resolved: true,
          attempt: 1,
        },
      }),
    );
  });

  it("anchors timestamps to run completion instead of stranding at epoch 1970", () => {
    expect(session.endedAt).toBe("2026-07-12T20:00:00.000Z");
    // startedAt = completion − totalMs (55s)
    expect(session.startedAt).toBe("2026-07-12T19:59:05.000Z");
    expect(session.totals.wallClockMs).toBe(40000);
  });
});

describe("buildTrialSession — degradation ladder", () => {
  it("builds a synthetic session from trajectory counters when there is no transcript", () => {
    const scripted = trial({
      configId: "glm",
      trajectory: {
        launcher: "glm-sim-agent",
        turns: 1,
        toolCalls: 1,
        toolErrors: 0,
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: null,
        wallClockMs: 100,
      },
    });
    const session = buildTrialSession(scripted, undefined, OPTS)!;
    expect(session.id).toBe(evalTrialSessionId(RUN_ID, "fix-divide", "glm", 0));
    expect(session.agent.type).toBe("glm-sim-agent");
    expect(session.turns).toEqual([]);
    expect(session.totals.inputTokens).toBe(900);
    expect(session.totals.outputTokens).toBe(120);
    expect(session.totals.costUsd).toBe(0.42);
    expect(session.title).toBe("Eval trial fix-divide × glm #0");
  });

  it("degrades an unparseable transcript to the synthetic session instead of dropping the trial", () => {
    const session = buildTrialSession(
      trial(),
      { transcript: "not json at all\nstill not json", launcher: "claude-code" },
      OPTS,
    )!;
    expect(session.id).toBe(SESSION_ID);
    expect(session.turns).toEqual([]);
    expect(session.totals.inputTokens).toBe(1200); // trajectory counters survive
  });

  it("stamps identity for a codex-launcher trial without depending on rollout internals", () => {
    const session = buildTrialSession(
      trial({ configId: "codex-arm" }),
      { transcript: '{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}', launcher: "codex" },
      OPTS,
    )!;
    expect(session.id).toBe(evalTrialSessionId(RUN_ID, "fix-divide", "codex-arm", 0));
    expect(session.vendor).toEqual(
      expect.objectContaining({ eval: expect.objectContaining({ configId: "codex-arm" }) }),
    );
  });
});

describe("buildTrialSessions", () => {
  it("joins transcripts by canonical id and emits one session per trial", () => {
    const trials = [trial(), trial({ configId: "glm", trajectory: null })];
    const transcripts = new Map([[SESSION_ID, { transcript: STREAM_JSON, launcher: "claude-code" }]]);
    const sessions = buildTrialSessions(trials, transcripts, OPTS);

    expect(sessions.map((s) => s.id)).toEqual([
      SESSION_ID,
      evalTrialSessionId(RUN_ID, "fix-divide", "glm", 0),
    ]);
    // First had a transcript (parsed turns); second is synthetic.
    expect(sessions[0]!.turns.length).toBeGreaterThan(0);
    expect(sessions[1]!.turns).toEqual([]);
  });
});
