// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { isHumanUserTurn } from "@outerlayer/session-schema";
import { parseTranscript } from "../adapters/claude-code/parse.js";

/** Build a JSONL transcript from line objects. */
function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const BASE = {
  sessionId: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
  cwd: "/home/dev/acme",
  gitBranch: "main",
  version: "2.1.193",
  entrypoint: "cli",
};

const userLine = (extra: Record<string, unknown>, content: unknown): Record<string, unknown> => ({
  ...BASE,
  type: "user",
  message: { role: "user", content },
  ...extra,
});

/** All user turns' `source`, in transcript order. */
function sources(content: string): (string | undefined)[] {
  const { session } = parseTranscript(content);
  return (session?.turns ?? []).filter((t) => t.role === "user").map((t) => t.source);
}

describe("parseTranscript — user-turn provenance classification", () => {
  it("origin.kind='human' → source 'human'", () => {
    expect(sources(jsonl(userLine({ origin: { kind: "human" } }, "please fix the failing test")))).toEqual(["human"]);
  });

  it("origin.kind='peer' → source 'peer' (relayed agent mail, not steering)", () => {
    const peerBody = "Legacy Supabase key usage — migration inventory, part 1 of 2 …";
    expect(sources(jsonl(userLine({ origin: { kind: "peer", from: "key-usage-mapper" } }, peerBody)))).toEqual(["peer"]);
  });

  it("origin.kind='task-notification' → source 'notification'", () => {
    expect(sources(jsonl(userLine({ origin: { kind: "task-notification" } }, "A background task finished")))).toEqual([
      "notification",
    ]);
  });

  it("origin with an unrecognized non-human kind → source 'notification'", () => {
    expect(sources(jsonl(userLine({ origin: { kind: "system-injected" } }, "some future harness message")))).toEqual([
      "notification",
    ]);
  });

  it("no origin + isMeta:true → source 'notification'", () => {
    expect(sources(jsonl(userLine({ isMeta: true }, "Base directory for this skill: /skills/foo")))).toEqual([
      "notification",
    ]);
  });

  it("no origin + peer content marker → source 'peer'", () => {
    const relayed = "Another Claude session sent a message:\nhere is the payload";
    expect(sources(jsonl(userLine({}, relayed)))).toEqual(["peer"]);
  });

  it("no origin + teammate-message block marker → source 'peer'", () => {
    const relayed = "<teammate-message from=\"bob\">ship it</teammate-message>";
    expect(sources(jsonl(userLine({}, relayed)))).toEqual(["peer"]);
  });

  it("no origin + notification content marker → source 'notification'", () => {
    const injected = "[SYSTEM NOTIFICATION] your agent was resumed";
    expect(sources(jsonl(userLine({}, injected)))).toEqual(["notification"]);
  });

  it("no origin + plain developer text → source 'human' (legacy-writer default)", () => {
    // Older Claude Code writers emit no `origin`; a real prompt must still count
    // as human steering or every legacy transcript zeroes out.
    expect(sources(jsonl(userLine({}, "actually, revert that and try the other approach")))).toEqual(["human"]);
  });

  it("a pure tool-result carrier is not a turn at all (no source, not counted)", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      userLine({}, [{ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" }]),
    );
    expect(sources(content)).toEqual([]);
  });

  it("classifies a mixed multi-agent session and counts only human turns", () => {
    const content = jsonl(
      userLine({ origin: { kind: "human" } }, "start: implement the parser"),
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "on it" }] } },
      userLine({ origin: { kind: "peer", from: "reviewer" } }, "peer: found an edge case in chunking"),
      userLine({ origin: { kind: "task-notification" } }, "task X completed"),
      userLine({ isMeta: true }, "You are the ORCHESTRATOR. Route labels only."),
      userLine({}, "keep going, but add a regression test"),
    );
    const { session } = parseTranscript(content);
    const userTurns = session!.turns.filter((t) => t.role === "user");
    // Positional source sequence pins ordering, drops, and per-branch labels.
    expect(userTurns.map((t) => t.source)).toEqual(["human", "peer", "notification", "notification", "human"]);
    // The shared predicate is the one definition of "human steering turn".
    expect(userTurns.filter(isHumanUserTurn)).toHaveLength(2);
  });

  // What this proves: for legacy transcripts that carry no `origin`, capture's
  // own marker fallback classifies every string in this fixed corpus as
  // non-human. The corpus mirrors the LLM steering path's drop set
  // (trace-topics `DROP_TURN_PATTERNS`) as of when it was written — every one of
  // those 8 patterns appears here verbatim, plus capture's extra peer/
  // notification block markers. It does NOT import that set (no cross-package
  // dependency by design); the reciprocal pointer comments on both marker lists
  // are the discipline that keeps them in step, and this fixture is the
  // parity-as-of-today snapshot that flags a capture-side regression.
  it.each([
    // capture-only peer/notification block markers
    ["<teammate-message from='x'>hi</teammate-message>", "peer"],
    ["<agent-message>do this</agent-message>", "peer"],
    ["<task-notification>done</task-notification>", "notification"],
    // the 8 trace-topics DROP_TURN_PATTERNS, verbatim
    ["[SYSTEM NOTIFICATION] resumed", "notification"],
    ["This is an automated background-task event for the fleet", "notification"],
    ["<command-name>/deploy</command-name>", "notification"],
    ["<local-command-stdout>ok</local-command-stdout>", "notification"],
    ["<command-message>run</command-message>", "notification"],
    ["<local-command-caveat>note</local-command-caveat>", "notification"],
    ["Caveat: The messages below were generated by the user", "notification"],
    ["Another Claude session sent a message:\npayload", "peer"],
    ["Base directory for this skill: /skills/x", "notification"],
    ["Path to the skill: /skills/x/SKILL.md", "notification"],
    ["You are the ORCHESTRATOR. Route labels only.", "notification"],
  ])("no-origin marker corpus %j classifies as %s (never human)", (text, expected) => {
    const [source] = sources(jsonl(userLine({}, text)));
    expect(source).toBe(expected);
  });

  it("derives the session title from the first HUMAN turn, skipping a leading peer turn", () => {
    // A relayed peer message arriving before the developer's first prompt must
    // not become the session title — title derivation walks to the first human
    // turn. Reverting that guard would title the session with the peer text.
    const content = jsonl(
      userLine({ origin: { kind: "peer", from: "reviewer" } }, "peer: heads up, watch the chunk boundary"),
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "noted" }] } },
      userLine({ origin: { kind: "human" } }, "implement the caching layer with an LRU"),
    );
    const { session } = parseTranscript(content);
    expect(session!.title).toBe("implement the caching layer with an LRU");
  });
});
