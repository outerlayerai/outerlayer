// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexRollout, codexSessionIdFromPath } from "../adapters/codex.js";
import { scanAll } from "../scan.js";

/** Build a rollout JSONL from (timestamp, type, payload) triples. */
function rollout(...lines: [string, string, Record<string, unknown>][]): string {
  return lines.map(([timestamp, type, payload]) => JSON.stringify({ timestamp, type, payload })).join("\n") + "\n";
}

const T = (s: number) => `2026-04-23T10:00:${String(s).padStart(2, "0")}.000Z`;

const META: [string, string, Record<string, unknown>] = [
  T(0),
  "session_meta",
  { id: "019dbac4-7fad-7280-8300-2a7f2f917ee0", timestamp: T(0), cwd: "/home/dev/acme", originator: "codex-tui", cli_version: "0.123.0", model_provider: "openai" },
];
const CTX: [string, string, Record<string, unknown>] = [T(1), "turn_context", { turn_id: "t-1", model: "gpt-5.4", approval_policy: "never" }];

describe("parseCodexRollout — core mapping", () => {
  it("maps meta, user prompt, assistant turn, model, usage, and totals onto AgentSession", () => {
    const content = rollout(
      META,
      CTX,
      [T(2), "event_msg", { type: "user_message", message: "Fix the failing CI on PR 42" }],
      [T(3), "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "Look at CI logs first" }], content: null }],
      [T(4), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the failing job." }] }],
      [T(5), "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 14328, cached_input_tokens: 6656, output_tokens: 307, total_tokens: 14635 }, last_token_usage: { input_tokens: 14328, cached_input_tokens: 6656, output_tokens: 307 } } }],
    );
    const { session } = parseCodexRollout(content);
    expect(session).not.toBeNull();
    const s = session!;
    expect(s.id).toBe("019dbac4-7fad-7280-8300-2a7f2f917ee0");
    expect(s.agent).toEqual({ type: "codex", version: "0.123.0", entrypoint: "codex-tui" });
    expect(s.env).toEqual({ cwd: "/home/dev/acme" });
    expect(s.models).toEqual(["gpt-5.4"]);
    expect(s.startedAt).toBe(T(0));
    expect(s.endedAt).toBe(T(5));
    expect(s.title).toBe("Fix the failing CI on PR 42");
    expect(s.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(s.turns[0]!.text).toBe("Fix the failing CI on PR 42");
    const a = s.turns[1]!;
    expect(a.text).toBe("Checking the failing job.");
    expect(a.model).toBe("gpt-5.4");
    expect(a.thinking).toBe("Look at CI logs first");
    // uncached input = input - cached (mirrors claude-code's cache-exclusive semantics)
    expect(a.usage).toEqual({ in: 14328 - 6656, out: 307, cacheRead: 6656, cacheCreate: 0 });
    expect(s.totals).toMatchObject({ inputTokens: 14328 - 6656, outputTokens: 307, cacheReadTokens: 6656, cacheCreationTokens: 0 });
    // priced from the registry (gpt-5.4, cache-aware), rounded to cents:
    // 7672×2.5e-6 + 307×1.5e-5 + 6656×2.5e-7 ≈ $0.0254 → $0.03
    expect(s.totals.costUsd).toBeCloseTo(0.03, 2);
    expect(a.costUsd).toBeCloseTo(7672 * 2.5e-6 + 307 * 1.5e-5 + 6656 * 2.5e-7, 6);
  });

  it("resolves function_call → output: exit-code error status, normalized signature, durationMs", () => {
    const content = rollout(
      META,
      CTX,
      [T(2), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running it." }] }],
      [T(3), "response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls /nope"}', call_id: "call_1" }],
      [T(5), "response_item", { type: "function_call_output", call_id: "call_1", output: "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nls: /nope: No such file or directory at line 42" }],
    );
    const call = parseCodexRollout(content).session!.turns[0]!.toolCalls[0]!;
    expect(call.name).toBe("exec_command");
    expect(call.status).toBe("error");
    expect(call.errorSignature).toContain("No such file");
    expect(call.errorSignature).not.toContain("42"); // normalized
    expect(call.durationMs).toBe(2000);
    expect(call.isEdit).toBe(false);
  });

  it("maps apply_patch custom_tool_call as an EDIT with the target file, ok on Success output", () => {
    const patch = "*** Begin Patch\n*** Update File: /home/dev/acme/src/a.ts\n@@\n-old\n+new\n*** End Patch";
    const content = rollout(
      META,
      CTX,
      [T(2), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Patching." }] }],
      [T(3), "response_item", { type: "custom_tool_call", status: "completed", name: "apply_patch", input: patch, call_id: "call_2" }],
      [T(4), "response_item", { type: "custom_tool_call_output", call_id: "call_2", output: '{"output":"Success. Updated the following files:\\nM /home/dev/acme/src/a.ts"}' }],
    );
    const call = parseCodexRollout(content).session!.turns[0]!.toolCalls[0]!;
    expect(call).toMatchObject({ name: "apply_patch", isEdit: true, file: "/home/dev/acme/src/a.ts", status: "ok" });
    expect(call.output).toContain("Success. Updated");
  });

  it("skips injected response_item user/developer messages (real prompts come from event_msg)", () => {
    const content = rollout(
      META,
      [T(1), "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>never ask" }] }],
      [T(2), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] }],
      [T(3), "event_msg", { type: "user_message", message: "the real prompt" }],
    );
    const s = parseCodexRollout(content).session!;
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([["user", "the real prompt"]]);
  });

  it("de-dupes interactive prompts: a response_item user echoed by event_msg is not double-counted", () => {
    // interactive rollouts record each prompt TWICE — response_item (API
    // history) then event_msg (display). Only the event_msg copy survives.
    const content = rollout(
      META,
      CTX,
      [T(1), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] }],
      [T(2), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Add a retry to the fetch" }] }],
      [T(3), "event_msg", { type: "user_message", message: "Add a retry to the fetch" }],
      [T(4), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }],
    );
    const s = parseCodexRollout(content).session!;
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Add a retry to the fetch"],
      ["assistant", "Done."],
    ]);
    // indices stay contiguous after the provisional turn is dropped
    expect(s.turns.map((t) => t.index)).toEqual([0, 1]);
  });

  it("non-interactive exec sessions: recovers the prompt from response_item when there is no event_msg", () => {
    // `codex exec` rollouts emit NO event_msg/user_message — the only record of
    // the human ask is the response_item user message. Without this the whole
    // corpus lands with null turn text (steering dead, task topics junk).
    const content = rollout(
      META,
      CTX,
      [T(1), "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions> sandbox: read-only" }] }],
      [T(2), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/srv/app</cwd>\n</environment_context>\n\nMigrate the users table to add a status column" }] }],
      [T(3), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Writing the migration." }] }],
      [T(4), "response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" }],
      [T(5), "response_item", { type: "function_call_output", call_id: "c1", output: "ok" }],
    );
    const s = parseCodexRollout(content).session!;
    // context wrapper stripped, real ask kept; injected developer msg skipped
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Migrate the users table to add a status column"],
      ["assistant", "Writing the migration."],
    ]);
    // title derived from the recovered prompt (no event_msg to set it inline)
    expect(s.title).toBe("Migrate the users table to add a status column");
    // the recovered prompt is a real user turn — the tool call lands on the
    // assistant that followed it
    expect(s.turns[1]!.toolCalls[0]!.name).toBe("exec_command");
  });

  it("exec sessions: image-only and interruption response_item user messages carry no prompt", () => {
    const content = rollout(
      META,
      CTX,
      [T(1), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<image name=[Image #1]></image>" }] }],
      [T(2), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted> The user interrupted" }] }],
      [T(3), "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Actually, ship the fix" }] }],
    );
    const s = parseCodexRollout(content).session!;
    expect(s.turns.map((t) => [t.role, t.text])).toEqual([["user", "Actually, ship the fix"]]);
  });

  it("counts each compaction pair once and maps error events to api_error", () => {
    const content = rollout(
      META,
      [T(1), "event_msg", { type: "user_message", message: "long task" }],
      [T(2), "compacted", { message: "", replacement_history: [] }],
      [T(2), "event_msg", { type: "context_compacted" }],
      [T(3), "compacted", { message: "", replacement_history: [] }],
      [T(3), "event_msg", { type: "context_compacted" }],
      [T(4), "event_msg", { type: "error", message: "stream disconnected" }],
    );
    const s = parseCodexRollout(content).session!;
    expect(s.events.filter((e) => e.type === "compaction")).toHaveLength(2);
    expect(s.events.filter((e) => e.type === "api_error")).toHaveLength(1);
  });

  it("returns null session for empty/garbage content", () => {
    expect(parseCodexRollout("").session).toBeNull();
    expect(parseCodexRollout("not json\n").session).toBeNull();
  });

  it("first session_meta wins — a spurious second meta cannot shift the session id", () => {
    const content = rollout(
      META,
      [T(1), "event_msg", { type: "user_message", message: "hi" }],
      [T(2), "session_meta", { id: "99999999-0000-0000-0000-000000000000", timestamp: T(2), cwd: "/elsewhere", cli_version: "9.9.9" }],
    );
    const s = parseCodexRollout(content).session!;
    expect(s.id).toBe("019dbac4-7fad-7280-8300-2a7f2f917ee0");
    expect(s.env).toEqual({ cwd: "/home/dev/acme" });
    expect(s.agent.version).toBe("0.123.0");
  });

  it("falls back to session_id when meta has no id, and maps AgentControl sub-agents", () => {
    const content = rollout(
      [T(0), "session_meta", { session_id: "aaaa1111-2222-3333-4444-555566667777", timestamp: T(0), cwd: "/x", cli_version: "0.130.0", parent_thread_id: "019dbac4-7fad-7280-8300-2a7f2f917ee0", agent_nickname: "scout" }],
      [T(1), "event_msg", { type: "user_message", message: "child task" }],
    );
    const s = parseCodexRollout(content).session!;
    expect(s.id).toBe("aaaa1111-2222-3333-4444-555566667777");
    expect(s.subagent).toEqual({ parentSessionId: "019dbac4-7fad-7280-8300-2a7f2f917ee0", agentId: "scout" });
  });

  it("a user boundary closes usage attribution — token_count never bleeds onto the previous turn", () => {
    const content = rollout(
      META,
      CTX,
      [T(2), "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] }],
      [T(3), "event_msg", { type: "user_message", message: "follow-up" }],
      [T(4), "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 }, last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 } } }],
    );
    const s = parseCodexRollout(content).session!;
    const firstAnswer = s.turns.find((t) => t.text === "first answer")!;
    expect(firstAnswer.usage).toBeUndefined(); // NOT retro-attributed across the boundary
    expect(s.totals).toMatchObject({ inputTokens: 50, outputTokens: 5 }); // totals still land
  });

  it("never throws: canonical-but-unmapped variants, truncation at every line, and byte garbage all degrade gracefully", () => {
    // the three current RolloutItem variants we deliberately don't map,
    // plus shapes no version has ever produced
    const exotic = rollout(
      META,
      [T(1), "world_state", { full: true, state: { files: 12 } }],
      [T(2), "inter_agent_communication", { from: "a", to: "b", body: "x" }],
      [T(3), "inter_agent_communication_metadata", { trigger_turn: true }],
      [T(4), "event_msg", { type: "user_message", message: "still parses" }],
      [T(5), "event_msg", { type: "some_future_event", data: [1, 2, 3] }],
      [T(6), "response_item", { type: "some_future_item", nested: { deep: null } }],
    );
    const r = parseCodexRollout(exotic);
    expect(r.session!.turns.map((t) => t.text)).toEqual(["still parses"]);
    expect(r.stats.unmapped).toBeGreaterThanOrEqual(3);

    // truncate a real-shaped file at every prefix length — parser must never throw
    const full = rollout(META, CTX,
      [T(2), "event_msg", { type: "user_message", message: "hello" }],
      [T(3), "response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" }],
      [T(4), "response_item", { type: "function_call_output", call_id: "c1", output: "ok" }],
    );
    for (let cut = 0; cut <= full.length; cut += 7) {
      expect(() => parseCodexRollout(full.slice(0, cut))).not.toThrow();
    }
    // interleaved binary-ish garbage lines
    const garbage = full.split("\n").flatMap((l) => [l, " �{]}garbage[", "42"]).join("\n");
    const g = parseCodexRollout(garbage);
    expect(g.session!.turns.some((t) => t.text === "hello")).toBe(true);
  });
});

describe("codex discovery + multi-source scan", () => {
  it("codexSessionIdFromPath extracts the trailing uuid", () => {
    expect(codexSessionIdFromPath("/x/rollout-2026-04-23T10-35-33-019dbac4-7fad-7280-8300-2a7f2f917ee0.jsonl")).toBe(
      "019dbac4-7fad-7280-8300-2a7f2f917ee0",
    );
  });

  it("scanAll sweeps claude-code AND codex stores, reporting byAgent counts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ol-scan-"));
    try {
      // claude layout: <root>/<project>/<uuid>.jsonl
      const claudeRoot = join(tmp, "claude");
      mkdirSync(join(claudeRoot, "-home-dev-acme"), { recursive: true });
      writeFileSync(
        join(claudeRoot, "-home-dev-acme", "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b.jsonl"),
        JSON.stringify({
          sessionId: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
          type: "assistant",
          cwd: "/home/dev/acme",
          timestamp: "2026-04-23T09:00:00.000Z",
          message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } },
        }) + "\n",
      );
      // codex layout: <root>/YYYY/MM/DD/rollout-*.jsonl
      const codexRoot = join(tmp, "codex");
      mkdirSync(join(codexRoot, "2026", "04", "23"), { recursive: true });
      writeFileSync(
        join(codexRoot, "2026", "04", "23", "rollout-2026-04-23T10-00-00-019dbac4-7fad-7280-8300-2a7f2f917ee0.jsonl"),
        rollout(META, CTX, [T(2), "event_msg", { type: "user_message", message: "hello codex" }]),
      );
      const { report, sessions } = scanAll({ root: claudeRoot, rawRoot: join(tmp, "no-raw"), codexRoot, cursorRoot: join(tmp, "no-cursor"), cursorProjectsRoot: join(tmp, "no-projects") });
      expect(report.byAgent).toEqual({ "claude-code": 1, codex: 1 });
      const byType = Object.fromEntries(sessions.map((s) => [s.agent.type, s.id]));
      expect(byType).toEqual({
        "claude-code": "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
        codex: "019dbac4-7fad-7280-8300-2a7f2f917ee0",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
