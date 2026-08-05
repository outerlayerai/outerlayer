/**
 * A cloud-worker run rebuilds into a canonical AgentSession. These pin the
 * bridge's whole contract: transcript
 * reconstruction (positional turn/tool shape), deterministic identity,
 * cost attribution, schema validity, and the repo-key normalizer's lockstep
 * with @outerlayer/capture.
 */
import { describe, expect, it } from "vitest";
import { safeParseAgentSession } from "@outerlayer/session-schema";
import {
  normalizeRepoRemote,
  workerRunSessionId,
  workerRunToAgentSession,
  type WorkerRunSessionInput,
} from "../agent-session-bridge";

const CALLBACK = {
  status: "succeeded",
  cost_usd: 0.3,
  num_turns: 2,
  duration_ms: 60_000,
  session_ref: "claude-session-9",
} as const;

function input(over: Partial<WorkerRunSessionInput> = {}): WorkerRunSessionInput {
  return {
    workerRunId: "run-1",
    agentType: "claude-code",
    taskPrompt: "Fix the flaky login test\nDetails follow.",
    events: [
      { seq: 0, event_type: "status", payload: { phase: "agent-launched", model: "claude-opus-4-8", session_id: "claude-session-9" } },
      { seq: 1, event_type: "agent-message", payload: { text: "Looking at the test." } },
      { seq: 2, event_type: "tool-use", payload: { tool: "Edit", summary: "Edit src/login.test.ts" } },
      { seq: 3, event_type: "file-change", payload: { path: "src/login.test.ts", tool: "Edit" } },
      { seq: 4, event_type: "agent-message", payload: { text: "Done — the wait was racy." } },
      { seq: 5, event_type: "tool-use", payload: { tool: "Bash", summary: "yarn vitest run" } },
      { seq: 6, event_type: "result", payload: { result: "ok", cost_usd: 0.3 } },
    ],
    callback: CALLBACK,
    startedAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:01:00.000Z",
    gitRepo: "github.com/acme/api",
    gitBranch: "main",
    ...over,
  };
}

describe("workerRunToAgentSession", () => {
  it("rebuilds the exact transcript: user task turn, then per-message assistant turns with attached tool calls", () => {
    const session = workerRunToAgentSession(input());
    expect(session.turns).toEqual([
      {
        index: 0,
        role: "user",
        ts: "2026-07-14T10:00:00.000Z",
        toolCalls: [],
        text: "Fix the flaky login test\nDetails follow.",
      },
      {
        index: 1,
        role: "assistant",
        model: "claude-opus-4-8",
        toolCalls: [
          { name: "Edit", status: "ok", isEdit: true, input: "Edit src/login.test.ts", file: "src/login.test.ts" },
        ],
        text: "Looking at the test.",
        costUsd: 0.15,
      },
      {
        index: 2,
        role: "assistant",
        model: "claude-opus-4-8",
        toolCalls: [{ name: "Bash", status: "ok", isEdit: false, input: "yarn vitest run" }],
        text: "Done — the wait was racy.",
        costUsd: 0.15,
      },
    ]);
  });

  it("produces a session the canonical schema accepts verbatim", () => {
    const parsed = safeParseAgentSession(workerRunToAgentSession(input()));
    expect(parsed.success).toBe(true);
  });

  it("carries identity + origin: deterministic id, workerKind cloud, repo/branch keys, model, title from the task's first line", () => {
    const session = workerRunToAgentSession(input());
    expect(session.id).toBe("worker-run:run-1");
    expect(session.id).toBe(workerRunSessionId("run-1"));
    expect(session.workerKind).toBe("cloud");
    // origin 'worker' marks runs as their own population, independent of any
    // transcript prompt-source marker.
    expect(session.agent).toEqual({ type: "claude-code", entrypoint: "cloud-worker", origin: "worker" });
    expect(session.env).toEqual({ gitRepo: "github.com/acme/api", gitBranch: "main" });
    expect(session.models).toEqual(["claude-opus-4-8"]);
    expect(session.title).toBe("Fix the flaky login test");
    expect(session.startedAt).toBe("2026-07-14T10:00:00.000Z");
    expect(session.endedAt).toBe("2026-07-14T10:01:00.000Z");
    expect(session.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.3,
      wallClockMs: 60_000,
    });
    expect(session.vendor).toEqual({
      workerRun: {
        runId: "run-1",
        status: "succeeded",
        sessionRef: "claude-session-9",
        costAttribution: "even-split",
      },
    });
  });

  it("splits the exact run cost evenly across assistant turns so the span sum reconciles to the total", () => {
    const session = workerRunToAgentSession(input());
    const turnSum = session.turns.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    expect(turnSum).toBeCloseTo(0.3, 10);
  });

  it("marks the in-flight tool call errored and records a session event on an error event", () => {
    const session = workerRunToAgentSession(
      input({
        events: [
          { seq: 0, event_type: "agent-message", payload: { text: "trying" } },
          { seq: 1, event_type: "tool-use", payload: { tool: "Bash", summary: "make build" } },
          { seq: 2, event_type: "error", payload: { message: "exit 1", source: "agent" } },
        ],
      }),
    );
    expect(session.turns[1]!.toolCalls).toEqual([
      { name: "Bash", status: "error", isEdit: false, input: "make build" },
    ]);
    expect(session.events).toEqual([
      { type: "api_error", seq: 0, data: { source: "agent", message: "exit 1" } },
    ]);
  });

  it("sorts events by seq and ignores unknown event types (forward compat)", () => {
    const session = workerRunToAgentSession(
      input({
        events: [
          { seq: 2, event_type: "agent-message", payload: { text: "second" } },
          { seq: 1, event_type: "agent-message", payload: { text: "first" } },
          { seq: 3, event_type: "some-future-type", payload: { x: 1 } },
        ],
      }),
    );
    expect(session.turns.slice(1).map((t) => t.text)).toEqual(["first", "second"]);
  });

  it("anchors a missing started_at to completedAt - duration", () => {
    const session = workerRunToAgentSession(input({ startedAt: null }));
    expect(session.startedAt).toBe("2026-07-14T10:00:00.000Z");
    expect(session.endedAt).toBe("2026-07-14T10:01:00.000Z");
  });

  it("attaches a tool-use with no preceding message to a synthesized assistant turn", () => {
    const session = workerRunToAgentSession(
      input({
        events: [{ seq: 0, event_type: "tool-use", payload: { tool: "Read", summary: "Read a.ts" } }],
        callback: { ...CALLBACK, cost_usd: undefined },
      }),
    );
    expect(session.turns[1]).toEqual({
      index: 1,
      role: "assistant",
      toolCalls: [{ name: "Read", status: "ok", isEdit: false, input: "Read a.ts" }],
    });
    expect(session.totals.costUsd).toBeUndefined();
  });
});

describe("normalizeRepoRemote (lockstep with @outerlayer/capture normalizeRemote)", () => {
  it.each([
    ["git@github.com:acme/app.git", "github.com/acme/app"],
    ["https://github.com/acme/app", "github.com/acme/app"],
    ["https://github.com/acme/app/", "github.com/acme/app"],
    ["ssh://git@host.io/acme/app.git", "host.io/acme/app"],
    ["git://host.io/acme/app.git", "host.io/acme/app"],
  ])("%s → %s", (remote, expected) => {
    expect(normalizeRepoRemote(remote)).toBe(expected);
  });

  it("returns undefined for blank input", () => {
    expect(normalizeRepoRemote("   ")).toBeUndefined();
  });
});
