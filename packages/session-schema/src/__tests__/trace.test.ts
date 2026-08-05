// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import {
  agentSessionToTrace,
  agentSessionToTraceSession,
  dominantModel,
  spanTreeFromSession,
  type AgentSessionTree,
  type TraceData,
} from "../trace.js";
import { minimalSession, richSession } from "./helpers.js";

function tree(): AgentSessionTree {
  const root = richSession();
  delete (root as { subagent?: unknown }).subagent; // the root is a main session
  const child = { ...minimalSession(), id: "agent-a1", subagent: { agentId: "a1", parentSessionId: root.id } };
  return { session: root, children: [{ session: child, children: [] }] };
}

function spanKinds(t: TraceData): Record<string, number> {
  const k: Record<string, number> = {};
  for (const s of t.spans) k[s.data.kind ?? "?"] = (k[s.data.kind ?? "?"] ?? 0) + 1;
  return k;
}

describe("shared trace mapping (canonical AgentSession path — the cloud entry)", () => {
  it("agentSessionToTrace emits a nested span tree; subagents nest under the parent session span", () => {
    const trace = agentSessionToTrace(tree());
    const kinds = spanKinds(trace);
    expect(kinds.session).toBe(1);
    expect(kinds.subagent).toBe(1);
    expect(kinds.turn).toBeGreaterThanOrEqual(2);
    expect(kinds.tool).toBeGreaterThanOrEqual(1);

    const sessionSpan = trace.spans.find((s) => s.data.kind === "session")!;
    const subSpan = trace.spans.find((s) => s.data.kind === "subagent")!;
    expect(subSpan.parentId).toBe(sessionSpan.id);

    // valid tree: every non-root parentId resolves
    const ids = new Set(trace.spans.map((s) => s.id));
    for (const s of trace.spans) if (s.parentId) expect(ids.has(s.parentId)).toBe(true);
  });

  it("normalizes tool I/O to bounded strings (so cloud output matches local)", () => {
    const root = richSession();
    // richSession has an Edit tool with object input + string output
    const ts = agentSessionToTraceSession({ session: root, children: [] });
    const call = ts.turns.flatMap((t) => t.toolCalls).find((c) => c.input);
    expect(typeof call!.input).toBe("string"); // object input serialized
    expect(call!.input).toContain("{"); // pretty JSON
  });

  it("thinking becomes its own span (never a blank turn)", () => {
    const root = { ...minimalSession() };
    root.turns = [
      { index: 0, role: "assistant", model: "claude-opus-4-8", toolCalls: [], thinking: "reasoning", costUsd: 0.01, usage: { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 } },
    ];
    const trace = agentSessionToTrace({ session: root, children: [] });
    const think = trace.spans.find((s) => s.data.kind === "thinking");
    expect(think?.data.thinking).toBe("reasoning");
  });

  it("spanTreeFromSession is deterministic (same input → same span ids/order)", () => {
    const ts = agentSessionToTraceSession(tree());
    const a = spanTreeFromSession(ts);
    const b = spanTreeFromSession(ts);
    expect(a.spans.map((s) => s.id)).toEqual(b.spans.map((s) => s.id));
  });

  it("reports the model that did the work, not the alphabetically first one seen", () => {
    const root = minimalSession();
    root.models = ["claude-opus-4-8", "claude-sonnet-5"];
    root.turns = [
      { index: 0, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 2, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 3, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 4, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 5, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
    ];
    const ts = agentSessionToTraceSession({ session: root, children: [] });
    expect(ts.model).toBe("claude-sonnet-5");
  });

  it("assistant-turn count outranks summed output tokens", () => {
    const root = minimalSession();
    root.turns = [
      { index: 0, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 2, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 10, cacheRead: 0, cacheCreate: 0 } },
      { index: 3, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 1000, cacheRead: 0, cacheCreate: 0 } },
    ];
    // opus: 3 turns / 30 out tokens; sonnet: 1 turn / 1000 out tokens — turn count wins
    expect(dominantModel(root)).toBe("claude-opus-4-8");
  });

  it("breaks a tie on assistant-turn count by summed output tokens (winner last)", () => {
    const root = minimalSession();
    root.turns = [
      // opus sorts first lexicographically but has fewer output tokens — token sum must decide
      { index: 0, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 100, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 500, cacheRead: 0, cacheCreate: 0 } },
    ];
    expect(dominantModel(root)).toBe("claude-sonnet-5");
  });

  it("breaks a tie on assistant-turn count by summed output tokens (winner first)", () => {
    const root = minimalSession();
    root.turns = [
      // same tie as above with insertion order flipped — the token tiebreak must
      // pick the winner by tokens, not by "last one iterated wins"
      { index: 0, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 500, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 100, cacheRead: 0, cacheCreate: 0 } },
    ];
    expect(dominantModel(root)).toBe("claude-sonnet-5");
  });

  it("breaks a tie on turns AND output tokens lexicographically (winner last)", () => {
    const root = minimalSession();
    root.turns = [
      { index: 0, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 100, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 100, cacheRead: 0, cacheCreate: 0 } },
    ];
    expect(dominantModel(root)).toBe("claude-opus-4-8");
  });

  it("breaks a tie on turns AND output tokens lexicographically (winner first)", () => {
    const root = minimalSession();
    root.turns = [
      // same tie as above with insertion order flipped — the lexicographic
      // tiebreak must pick the winner by model id, not by iteration order
      { index: 0, role: "assistant", model: "claude-opus-4-8", toolCalls: [], usage: { in: 1, out: 100, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 100, cacheRead: 0, cacheCreate: 0 } },
    ];
    expect(dominantModel(root)).toBe("claude-opus-4-8");
  });

  it("falls back to the first model when no turn carries one", () => {
    const root = minimalSession();
    root.models = ["claude-opus-4-8"];
    root.turns = [{ index: 0, role: "assistant", toolCalls: [] }];
    expect(dominantModel(root)).toBe("claude-opus-4-8");
  });

  it("ignores <synthetic> turns even when they would otherwise win the ranking", () => {
    const root = minimalSession();
    root.turns = [
      // <synthetic> sorts before every real model and has the most output tokens —
      // neither should let it win
      { index: 0, role: "assistant", model: "<synthetic>", toolCalls: [], usage: { in: 1, out: 9999, cacheRead: 0, cacheCreate: 0 } },
      { index: 1, role: "assistant", model: "claude-sonnet-5", toolCalls: [], usage: { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 } },
    ];
    expect(dominantModel(root)).toBe("claude-sonnet-5");
  });

  it("skips <synthetic> in the models[0] fallback too", () => {
    const root = minimalSession();
    root.models = ["<synthetic>", "claude-opus-4-8"];
    root.turns = [];
    expect(dominantModel(root)).toBe("claude-opus-4-8");
  });

  it("reports no model for an all-synthetic session (legacy capture with only stub turns)", () => {
    const root = minimalSession();
    root.models = ["<synthetic>"];
    root.turns = [];
    expect(dominantModel(root)).toBeNull();
  });
});
