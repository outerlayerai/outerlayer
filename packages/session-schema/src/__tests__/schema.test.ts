// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import {
  AgentSessionSchema,
  EVENT_TYPES,
  isHumanUserTurn,
  parseAgentSession,
  safeParseAgentSession,
  type Turn,
  _tierPathsUsedBySchema,
} from "../schema.js";
import { FIELD_TIERS } from "../tiers.js";
import { minimalSession, richSession } from "./helpers.js";

describe("AgentSessionSchema", () => {
  it("accepts a minimal metrics-tier session", () => {
    const parsed = parseAgentSession(minimalSession());
    expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.turns).toEqual([]);
    expect(parsed.captureTier).toBe("metrics");
  });

  it("accepts a rich full-tier session and preserves every field", () => {
    const input = richSession();
    const parsed = parseAgentSession(input);
    expect(parsed).toEqual(input);
  });

  it("preserves unknown keys at every level (forward-compat, additive-only v1)", () => {
    const input = richSession() as Record<string, unknown>;
    input.futureSessionKey = "keep-me";
    (input.agent as Record<string, unknown>).futureAgentKey = 7;
    const turn = (input.turns as Record<string, unknown>[])[1]!; // assistant turn (has toolCalls)
    turn.futureTurnKey = true;
    (turn.toolCalls as Record<string, unknown>[])[0]!.futureToolKey = ["a"];
    (input.events as Record<string, unknown>[])[0]!.futureEventKey = null;

    const parsed = parseAgentSession(input) as Record<string, unknown>;
    expect(parsed.futureSessionKey).toBe("keep-me");
    expect((parsed.agent as Record<string, unknown>).futureAgentKey).toBe(7);
    const parsedTurn = (parsed.turns as Record<string, unknown>[])[1]!;
    expect(parsedTurn.futureTurnKey).toBe(true);
    expect((parsedTurn.toolCalls as Record<string, unknown>[])[0]!.futureToolKey).toEqual(["a"]);
    expect((parsed.events as Record<string, unknown>[])[0]!.futureEventKey).toBeNull();
  });

  it.each([
    ["schemaVersion !== 1", (s: Record<string, unknown>) => (s.schemaVersion = 2)],
    ["empty id", (s: Record<string, unknown>) => (s.id = "")],
    ["missing agent.type", (s: Record<string, unknown>) => (s.agent = {})],
    ["bad captureTier", (s: Record<string, unknown>) => (s.captureTier = "everything")],
    ["non-ISO startedAt", (s: Record<string, unknown>) => (s.startedAt = "last tuesday")],
    ["epoch-ms startedAt", (s: Record<string, unknown>) => (s.startedAt = 1751795000000)],
    [
      "negative usage",
      (s: Record<string, unknown>) =>
        (s.turns = [
          {
            index: 0,
            role: "assistant",
            toolCalls: [],
            usage: { in: -1, out: 0, cacheRead: 0, cacheCreate: 0 },
          },
        ]),
    ],
    [
      "unknown turn role",
      (s: Record<string, unknown>) => (s.turns = [{ index: 0, role: "system", toolCalls: [] }]),
    ],
    [
      "unknown tool status",
      (s: Record<string, unknown>) =>
        (s.turns = [
          {
            index: 0,
            role: "assistant",
            toolCalls: [{ name: "Bash", status: "maybe", isEdit: false }],
          },
        ]),
    ],
    [
      "fractional token count",
      (s: Record<string, unknown>) =>
        ((s.totals as Record<string, unknown>).inputTokens = 1.5),
    ],
  ])("rejects %s", (_label, mutate) => {
    const bad: Record<string, unknown> = { ...minimalSession() };
    mutate(bad);
    const result = safeParseAgentSession(bad);
    expect(result.success).toBe(false);
  });

  it("keeps null turn text and null costUsd (redaction/unknown-price encodings)", () => {
    const input = minimalSession();
    input.turns = [
      { index: 0, role: "assistant", toolCalls: [], text: null, costUsd: null },
    ];
    const parsed = parseAgentSession(input);
    expect(parsed.turns[0]!.text).toBeNull();
    expect(parsed.turns[0]!.costUsd).toBeNull();
  });
});

describe("tier annotation consistency", () => {
  it("schema consumes exactly the FIELD_TIERS table — no drift in either direction", () => {
    expect(_tierPathsUsedBySchema()).toEqual(Object.keys(FIELD_TIERS).sort());
  });
});

describe("EVENT_TYPES", () => {
  it("well-known event types are unique snake_case", () => {
    const values = Object.values(EVENT_TYPES);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("schema accepts events outside the well-known set (open enum)", () => {
    const input = minimalSession();
    input.events = [{ type: "hologram_checkpoint", seq: 0 }];
    expect(AgentSessionSchema.safeParse(input).success).toBe(true);
  });
});

describe("isHumanUserTurn", () => {
  const turn = (over: Partial<Turn>): Turn => ({ index: 0, role: "user", toolCalls: [], ...over });

  it("is true for a user turn tagged human or with no source (legacy default)", () => {
    expect(isHumanUserTurn(turn({ source: "human" }))).toBe(true);
    expect(isHumanUserTurn(turn({}))).toBe(true);
  });

  it("is false for relayed peer and harness-notification user turns", () => {
    expect(isHumanUserTurn(turn({ source: "peer" }))).toBe(false);
    expect(isHumanUserTurn(turn({ source: "notification" }))).toBe(false);
  });

  it("is false for any assistant turn regardless of source", () => {
    expect(isHumanUserTurn(turn({ role: "assistant" }))).toBe(false);
    expect(isHumanUserTurn(turn({ role: "assistant", source: "human" }))).toBe(false);
  });
});
