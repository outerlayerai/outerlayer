// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { parseAgentSession } from "@outerlayer/session-schema";
import { parseTranscript, normalizeErrorSignature, extractCommitShas } from "../adapters/claude-code/parse.js";

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

describe("parseTranscript — core mapping", () => {
  it("maps an assistant turn: model, cache-aware usage, cost, tool_use → ToolCall", () => {
    const content = jsonl({
      ...BASE,
      type: "assistant",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [
          { type: "text", text: "fixing it" },
          { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } },
        ],
        usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 },
      },
    });
    const { session } = parseTranscript(content);
    expect(session).not.toBeNull();
    const s = session!;
    expect(s.id).toBe(BASE.sessionId);
    expect(s.agent).toEqual({ type: "claude-code", version: "2.1.193", entrypoint: "cli", origin: "interactive" });
    expect(s.env).toEqual({ cwd: "/home/dev/acme", gitBranch: "main" });
    expect(s.models).toEqual(["claude-opus-4-8"]);
    const turn = s.turns[0]!;
    expect(turn.role).toBe("assistant");
    expect(turn.usage).toEqual({ in: 10, out: 200, cacheRead: 5000, cacheCreate: 800 });
    // cache-aware: opus 5e-6 in, 25e-6 out, 5e-7 cacheRead, 6.25e-6 cacheCreate
    expect(turn.costUsd).toBeCloseTo(10 * 5e-6 + 200 * 25e-6 + 5000 * 5e-7 + 800 * 6.25e-6, 9);
    expect(turn.text).toBe("fixing it");
    const call = turn.toolCalls[0]!;
    expect(call).toMatchObject({ name: "Edit", isEdit: true, file: "src/a.ts", status: "ok" });
    expect(s.totals).toMatchObject({ inputTokens: 10, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 800 });
  });

  it("persists the tool_use id onto the ToolCall as toolUseId — the join key hook-wrap events use to parent to this exact call", () => {
    const content = jsonl({
      ...BASE,
      type: "assistant",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "tool_use", id: "toolu_42", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const { session } = parseTranscript(content);
    expect(session!.turns[0]!.toolCalls[0]!.toolUseId).toBe("toolu_42");
  });

  it("leaves toolUseId unset for an anonymous tool_use block (no id on the line)", () => {
    const content = jsonl({
      ...BASE,
      type: "assistant",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const { session } = parseTranscript(content);
    expect(session!.turns[0]!.toolCalls[0]!.toolUseId).toBeUndefined();
  });

  it("resolves a tool_result in the next user turn onto the pending ToolCall (error → status+signature+duration)", () => {
    const content = jsonl(
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls /nope" } }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      },
      {
        ...BASE,
        type: "user",
        timestamp: "2026-07-01T10:00:03.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: true, content: "ls: /nope: No such file or directory at line 42" }] },
      },
    );
    const { session } = parseTranscript(content);
    const call = session!.turns[0]!.toolCalls[0]!;
    expect(call.status).toBe("error");
    expect(call.errorSignature).toContain("No such file");
    expect(call.errorSignature).not.toContain("42"); // normalized
    expect(call.durationMs).toBe(3000);
    // the pure tool-result user turn is dropped (no text, no calls)
    expect(session!.turns).toHaveLength(1);
  });

  it("detects a human-rejected tool call (permission denied) as status:rejected", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "The user doesn't want to proceed with this tool use." }] } },
    );
    const { session } = parseTranscript(content);
    expect(session!.turns[0]!.toolCalls[0]!.status).toBe("rejected");
  });

  it("maps events: compaction, skill_activated, pr_linked (+outcome), api_error, queue_operation, hook_executed", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", attributionSkill: "my-skill", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      // real compaction shape: bare boundary line + adjacent isCompactSummary user line
      { ...BASE, type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: "2026-07-01T10:05:00.000Z" },
      { ...BASE, type: "user", isCompactSummary: true, timestamp: "2026-07-01T10:05:01.000Z", message: { role: "user", content: "This session is being continued from a previous conversation…" } },
      { ...BASE, type: "system", subtype: "api_error", timestamp: "2026-07-01T10:06:00.000Z", error: { code: "ECONNRESET", message: "boom" } },
      { ...BASE, type: "system", subtype: "stop_hook_summary", hookCount: 2, timestamp: "2026-07-01T10:06:30.000Z" },
      { ...BASE, type: "queue-operation", operation: "enqueue", timestamp: "2026-07-01T10:07:00.000Z" },
      { ...BASE, type: "pr-link", prNumber: 481, prUrl: "https://github.com/acme/acme/pull/481", timestamp: "2026-07-01T10:08:00.000Z" },
    );
    const { session } = parseTranscript(content);
    const s = session!;
    const eventTypes = s.events.map((e) => e.type).sort();
    expect(eventTypes).toContain("compaction");
    // boundary + summary-line pair = ONE compaction, and the harness-injected
    // summary text does not fabricate a user turn
    expect(s.events.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(s.turns.filter((t) => t.role === "user")).toHaveLength(0);
    expect(eventTypes).toContain("skill_activated");
    expect(eventTypes).toContain("api_error");
    expect(eventTypes).toContain("hook_executed");
    expect(eventTypes).toContain("queue_operation");
    expect(eventTypes).toContain("pr_linked");
    expect(s.outcome).toEqual({
      prNumber: 481,
      prUrl: "https://github.com/acme/acme/pull/481",
      prs: [{ prNumber: 481, prUrl: "https://github.com/acme/acme/pull/481" }],
    });
    // api_error data carries only the code (message is content — never in data)
    const apiErr = s.events.find((e) => e.type === "api_error")!;
    expect(apiErr.data).toEqual({ code: "ECONNRESET" });
    // events are totally ordered by seq
    expect(s.events.map((e) => e.seq)).toEqual([...s.events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("counts a provider failure recorded as an isApiErrorMessage stub, classifying its wording", () => {
    // Claude Code's actual shape for a provider failure: a synthetic assistant
    // line carrying the error sentence, NOT a system/api_error line.
    const stub = (text: string, ts: string) => ({
      ...BASE,
      type: "assistant",
      isApiErrorMessage: true,
      timestamp: ts,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const content = jsonl(
      { ...BASE, type: "assistant", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 5 } } },
      stub("API Error: Connection closed mid-response. The response above may be incomplete.", "2026-07-01T10:01:00.000Z"),
      stub("API Error: 429 rate_limit_error", "2026-07-01T10:02:00.000Z"),
      stub("Claude Fable 5 is currently unavailable.", "2026-07-01T10:03:00.000Z"),
      stub("something nobody has a pattern for", "2026-07-01T10:04:00.000Z"),
    );
    const s = parseTranscript(content).session!;
    expect(s.events.filter((e) => e.type === "api_error").map((e) => e.data?.code)).toEqual([
      "connection_closed",
      "rate_limit",
      "model_unavailable",
      "unknown",
    ]);
    // The stub's `<synthetic>` model must not enter the session's model list
    // or be priced — only the real turn counts.
    expect(s.models).toEqual(["claude-opus-4-8"]);
  });

  it("carries per-hook detail on stop_hook_summary: commands, a missing duration stays absent (never 0), errorCount, toolUseID", () => {
    const content = jsonl({
      ...BASE,
      type: "system",
      subtype: "stop_hook_summary",
      timestamp: "2026-07-01T10:06:30.000Z",
      hookCount: 2,
      hookInfos: [
        { command: "./scripts/lint.sh", durationMs: 45 },
        { command: "./scripts/slow-hook.sh" }, // self-backgrounding — reports no duration
      ],
      hookErrors: ["lint failed: 3 errors", { code: "E_TIMEOUT" }],
      toolUseID: "toolu_77",
    });
    const { session } = parseTranscript(content);
    const hookEvent = session!.events.find((e) => e.type === "hook_executed")!;
    // errorCount (a count, content-free) rides `data`; the raw error text
    // rides its own `errorText` field so it can be tiered separately at `full`.
    expect(hookEvent.data).toEqual({
      hookCount: 2,
      hooks: [{ command: "./scripts/lint.sh", durationMs: 45 }, { command: "./scripts/slow-hook.sh" }],
      errorCount: 2,
      toolUseId: "toolu_77",
    });
    expect(hookEvent.errorText).toEqual(["lint failed: 3 errors", '{"code":"E_TIMEOUT"}']);
  });

  it("drops a negative or non-integer durationMs rather than storing a value that can't be real (never 0 either)", () => {
    const content = jsonl({
      ...BASE,
      type: "system",
      subtype: "stop_hook_summary",
      timestamp: "2026-07-01T10:06:30.000Z",
      hookInfos: [
        { command: "a", durationMs: -5 },
        { command: "b", durationMs: 12.5 },
        { command: "c", durationMs: 200 }, // the one valid entry
      ],
    });
    const { session } = parseTranscript(content);
    const hookEvent = session!.events.find((e) => e.type === "hook_executed")!;
    expect((hookEvent.data as { hooks: unknown[] }).hooks).toEqual([{ command: "a" }, { command: "b" }, { command: "c", durationMs: 200 }]);
  });

  it("caps stop_hook_summary hookInfos at 50 entries and truncates each command at 300 chars", () => {
    const longCommand = "x".repeat(400);
    const hookInfos = Array.from({ length: 51 }, (_, i) => ({ command: `${longCommand}${i}`, durationMs: i }));
    const content = jsonl({
      ...BASE,
      type: "system",
      subtype: "stop_hook_summary",
      timestamp: "2026-07-01T10:06:30.000Z",
      hookInfos,
    });
    const { session } = parseTranscript(content);
    const hookEvent = session!.events.find((e) => e.type === "hook_executed")!;
    const hooks = (hookEvent.data as { hooks: { command?: string; durationMs?: number }[] }).hooks;
    expect(hooks).toHaveLength(50);
    expect(hooks[0]!.command).toBe(longCommand.slice(0, 300));
    expect(hooks[0]!.command).toHaveLength(300);
  });

  it("maps a hook_blocking_error attachment to a hook_blocked event, and leaves other attachment types unmapped", () => {
    const content = jsonl(
      {
        ...BASE,
        type: "attachment",
        timestamp: "2026-07-01T10:06:31.000Z",
        attachment: { type: "hook_blocking_error", hookEvent: "PreToolUse", hookName: "check-secrets", toolUseID: "toolu_88" },
      },
      { ...BASE, type: "attachment", attachment: { type: "deferred_tools_delta" } },
    );
    const { session, warnings } = parseTranscript(content);
    const blocked = session!.events.filter((e) => e.type === "hook_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual({
      type: "hook_blocked",
      seq: 0,
      ts: "2026-07-01T10:06:31.000Z",
      data: { hookEvent: "PreToolUse", hookName: "check-secrets", toolUseId: "toolu_88" },
    });
    expect(warnings.unknown_line_type ?? 0).toBe(0);
    const unmapped = (session!.vendor as { unmappedLineTypes?: Record<string, number> }).unmappedLineTypes!;
    expect(unmapped.attachment).toBe(1);
  });

  it("counts a skill activation per contiguous span, not per attributed line", () => {
    // A skill is stamped on every assistant line of its span; the user turns
    // between them carry no attribution. One span = one activation.
    const content = jsonl(
      { ...BASE, type: "assistant", attributionSkill: "orchestrator", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "a" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "assistant", attributionSkill: "orchestrator", timestamp: "2026-07-01T10:00:01.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "b" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "user", timestamp: "2026-07-01T10:00:02.000Z", message: { role: "user", content: "keep going" } },
      { ...BASE, type: "assistant", attributionSkill: "orchestrator", timestamp: "2026-07-01T10:00:03.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "c" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      // switch to a different skill → a new activation
      { ...BASE, type: "assistant", attributionSkill: "dev", timestamp: "2026-07-01T10:00:04.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "d" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "assistant", attributionSkill: "dev", timestamp: "2026-07-01T10:00:05.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "e" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      // back to the first skill after another ran → another activation
      { ...BASE, type: "assistant", attributionSkill: "orchestrator", timestamp: "2026-07-01T10:00:06.000Z", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "f" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    );
    const { session } = parseTranscript(content);
    const activations = session!.events.filter((e) => e.type === "skill_activated");
    // 7 attributed assistant lines, but only 3 spans: orchestrator, dev, orchestrator.
    expect(activations.map((e) => (e.data as { skill: string }).skill)).toEqual([
      "orchestrator",
      "dev",
      "orchestrator",
    ]);
  });

  it("accumulates wall-clock from turn_duration system lines", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "a" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "system", subtype: "turn_duration", durationMs: 158168 },
      { ...BASE, type: "system", subtype: "turn_duration", durationMs: 1832 },
    );
    const { session } = parseTranscript(content);
    expect(session!.totals.wallClockMs).toBe(160000);
  });

  it("captures ai-title as tier:full session title", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "ai-title", aiTitle: "Fix the thing" },
    );
    const { session } = parseTranscript(content);
    expect(session!.title).toBe("Fix the thing");
  });
});

describe("parseTranscript — multi-PR outcome + commit attribution", () => {
  const bash = (id: string, command: string) => ({
    ...BASE,
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id, name: "Bash", input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const result = (id: string, content: string, isError = false) => ({
    ...BASE,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });

  it("collects EVERY pr-link (stacked PRs), segments commits per PR, dedupes re-links, keeps scalar = last link", () => {
    const content = jsonl(
      bash("t1", "git add -A && git commit -m 'first'"),
      result("t1", "[feat-a abc1234] first\n 3 files changed, 10 insertions(+)"),
      { ...BASE, type: "pr-link", prNumber: 12, prUrl: "https://github.com/acme/acme/pull/12" },
      bash("t2", "git commit -m 'second'"),
      result("t2", "[feat-b bbb2222] second"),
      bash("t3", "git commit -m 'third'"),
      result("t3", "[feat-b ccc3333] third"),
      { ...BASE, type: "pr-link", prNumber: 13, prUrl: "https://github.com/acme/acme/pull/13" },
      bash("t4", "git commit -m 'follow-up'"),
      result("t4", "[feat-a ddd4444] follow-up"),
      // re-link of PR 12 (e.g. after pushing the follow-up): same entry, url
      // refreshed, pending commit attributed to it — never a duplicate entry
      { ...BASE, type: "pr-link", prNumber: 12, prUrl: "https://github.com/acme/acme/pull/12#update" },
    );
    const { session } = parseTranscript(content);
    expect(session!.outcome).toEqual({
      prNumber: 12,
      prUrl: "https://github.com/acme/acme/pull/12#update",
      commitShas: ["abc1234", "bbb2222", "ccc3333", "ddd4444"],
      prs: [
        { prNumber: 12, prUrl: "https://github.com/acme/acme/pull/12#update", commitShas: ["abc1234", "ddd4444"] },
        { prNumber: 13, prUrl: "https://github.com/acme/acme/pull/13", commitShas: ["bbb2222", "ccc3333"] },
      ],
    });
    // still one pr_linked event per pr-link LINE (three lines here)
    expect(session!.events.filter((e) => e.type === "pr_linked")).toHaveLength(3);
  });

  it("commit-only session (no pr-link) still records session-level shas", () => {
    const content = jsonl(bash("t1", "git commit -m 'wip'"), result("t1", "[main eee5555] wip"));
    const { session } = parseTranscript(content);
    expect(session!.outcome).toEqual({ commitShas: ["eee5555"] });
  });

  it("never fabricates commits: non-commit commands, failed commits, and duplicate shas are ignored", () => {
    const content = jsonl(
      // output that LOOKS like commit porcelain from a non-commit command
      bash("t1", "cat CHANGELOG.md"),
      result("t1", "[main 9999999] looks like a commit but is file text"),
      // failed commit (pre-commit hook) — no sha recorded even if output echoes one
      bash("t2", "git commit -m 'nope'"),
      result("t2", "[main 8888888] phantom\nhusky pre-commit failed", true),
      // real commit, then the same sha echoed again by a second commit call
      bash("t3", "git commit -m 'real'"),
      result("t3", "[main abc9876] real"),
      bash("t4", "git commit --amend --no-edit && echo done"),
      result("t4", "[main abc9876] real"),
    );
    const { session } = parseTranscript(content);
    expect(session!.outcome).toEqual({ commitShas: ["abc9876"] });
  });

  it("ignores pr-link lines with invalid numbers", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "pr-link", prNumber: 0, prUrl: "https://github.com/acme/acme/pull/0" },
      { ...BASE, type: "pr-link", prNumber: -3 },
    );
    const { session } = parseTranscript(content);
    expect(session!.outcome).toBeUndefined();
  });
});

describe("extractCommitShas", () => {
  it("matches git commit porcelain shapes and nothing else", () => {
    expect(extractCommitShas("[main abc1234] subject")).toEqual(["abc1234"]);
    expect(extractCommitShas("[feat/x (root-commit) beef123] init")).toEqual(["beef123"]);
    expect(extractCommitShas("[detached HEAD 0123abc] fix")).toEqual(["0123abc"]);
    expect(extractCommitShas("hook noise\n[main fedcba9] done\n 2 files changed")).toEqual(["fedcba9"]);
    expect(extractCommitShas("[a 1111111] one\n[b 2222222] two")).toEqual(["1111111", "2222222"]);
    // full 40-char sha allowed
    expect(extractCommitShas(`[main ${"a".repeat(40)}] long`)).toEqual(["a".repeat(40)]);
    // rejected: not at line start, mid-line brackets, too short, uppercase, 41+ chars
    expect(extractCommitShas(" [main abc1234] indented")).toEqual([]);
    expect(extractCommitShas("changed [see abc1234] nope")).toEqual([]);
    expect(extractCommitShas("[main abc123] short")).toEqual([]);
    expect(extractCommitShas("[main ABCDEF1] upper")).toEqual([]);
    expect(extractCommitShas(`[main ${"a".repeat(41)}] over`)).toEqual([]);
  });
});

describe("parseTranscript — tolerance (the core forward-compat property)", () => {
  it("skips a malformed middle line with malformed_line, never throws", () => {
    const good = JSON.stringify({ ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } });
    const content = good + "\n" + '{"type":"assistant","message":{BROKEN' + "\n" + good + "\n";
    const { session, warnings, stats } = parseTranscript(content);
    expect(session).not.toBeNull();
    expect(warnings.malformed_line).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(session!.turns).toHaveLength(2);
  });

  it("treats a truncated final line (live write) as truncated_final_line, parses the rest", () => {
    const good = JSON.stringify({ ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } });
    const content = good + "\n" + '{"type":"assis'; // no trailing newline
    const { session, warnings } = parseTranscript(content);
    expect(session).not.toBeNull();
    expect(warnings.truncated_final_line).toBe(1);
    expect(session!.turns).toHaveLength(1);
  });

  it("routes unknown line types to vendor with unknown_line_type, but known-unmapped types stay silent", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "attachment", attachment: { type: "deferred_tools_delta" } }, // known-unmapped
      { ...BASE, type: "quantum-flux-capacitor", payload: 42 }, // genuinely novel
    );
    const { session, warnings } = parseTranscript(content);
    expect(warnings.unknown_line_type).toBe(1); // only the novel one
    const unmapped = (session!.vendor as { unmappedLineTypes?: Record<string, number> }).unmappedLineTypes!;
    expect(unmapped.attachment).toBe(1);
    expect(unmapped["quantum-flux-capacitor"]).toBe(1);
  });

  it("flags version_newer_than_supported for a future writer, still parses", () => {
    const content = jsonl({
      ...BASE,
      version: "9.9.9",
      type: "assistant",
      message: { role: "assistant", model: "claude-fable-7", content: [{ type: "text", text: "future" }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const { session, warnings } = parseTranscript(content);
    expect(warnings.version_newer_than_supported).toBe(1);
    expect(session!.agent.version).toBe("9.9.9");
  });

  it("unknown model → costUsd null + unknown_model_cost warning (never guessed)", () => {
    const content = jsonl({
      ...BASE,
      type: "assistant",
      message: { role: "assistant", model: "totally-made-up-model-x", content: [{ type: "text", text: "x" }], usage: { input_tokens: 100, output_tokens: 100 } },
    });
    const { session, warnings } = parseTranscript(content);
    expect(session!.turns[0]!.costUsd).toBeNull();
    expect(session!.totals.costUsd).toBeNull();
    expect(warnings.unknown_model_cost).toBe(1);
  });

  it("returns null session for a file with zero usable records", () => {
    expect(parseTranscript("\n\n  \n").session).toBeNull();
    // only bookkeeping (attachment) with no turns/events → nothing to show
    expect(parseTranscript('{"type":"attachment"}\n').session).toBeNull();
    // title/continuation "summary" lines are NOT compactions (a forked session
    // carries many) — bookkeeping only, no session from them alone
    expect(parseTranscript('{"type":"summary"}\n').session).toBeNull();
    // but a single mapped event (a real compact boundary) yields a session
    expect(parseTranscript(jsonl({ ...BASE, type: "system", subtype: "compact_boundary" })).session).not.toBeNull();
    // old-format compaction: isCompactSummary user line with no boundary still counts once
    const old = parseTranscript(jsonl({ ...BASE, type: "user", isCompactSummary: true, message: { role: "user", content: "continued…" } })).session!;
    expect(old.events.filter((e) => e.type === "compaction")).toHaveLength(1);
  });

  it("always emits a schema-valid session (self-validation)", () => {
    const content = jsonl(
      { ...BASE, type: "assistant", message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { ...BASE, type: "system", subtype: "away_summary" },
    );
    const { session } = parseTranscript(content);
    expect(() => parseAgentSession(session)).not.toThrow();
  });
});

describe("logical-turn grouping by message.id (the blank-span + cost-inflation fix)", () => {
  const M = { ...BASE };
  function asstLine(msgId: string, block: Record<string, unknown>, usage?: Record<string, number>): Record<string, unknown> {
    return {
      ...M,
      type: "assistant",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: { id: msgId, role: "assistant", model: "claude-opus-4-8", content: [block], ...(usage ? { usage } : {}) },
    };
  }

  it("merges thinking/text/tool_use lines that share message.id into ONE turn — never blank", () => {
    const content = jsonl(
      asstLine("msg_1", { type: "thinking", thinking: "let me reason about this" }, { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 5 }),
      asstLine("msg_1", { type: "text", text: "Here's the fix." }),
      asstLine("msg_1", { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } }),
    );
    const { session } = parseTranscript(content);
    expect(session!.turns).toHaveLength(1);
    const turn = session!.turns[0]!;
    expect(turn.thinking).toBe("let me reason about this");
    expect(turn.text).toBe("Here's the fix.");
    expect(turn.toolCalls[0]!.name).toBe("Edit");
    expect(turn.messageId).toBe("msg_1");
    // no blank turns
    expect(session!.turns.filter((t) => !t.text && !t.thinking && t.toolCalls.length === 0)).toHaveLength(0);
  });

  it("takes MAX usage per message.id — duplicated lines do NOT multiply cost", () => {
    const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 };
    // same message written 5 times (the resumption/streaming duplication pattern)
    const content = jsonl(...Array.from({ length: 5 }, () => asstLine("msg_dup", { type: "text", text: "hi" }, usage)));
    const { session } = parseTranscript(content);
    expect(session!.turns).toHaveLength(1);
    // usage is the single message's usage, not 5x
    expect(session!.turns[0]!.usage).toEqual({ in: 10, out: 200, cacheRead: 5000, cacheCreate: 800 });
    const singleCost = 10 * 5e-6 + 200 * 25e-6 + 5000 * 5e-7 + 800 * 6.25e-6;
    expect(session!.totals.costUsd).toBeCloseTo(singleCost, 9);
  });

  it("a thinking-only message is a real turn (reasoning visible), not a blank row", () => {
    const content = jsonl(asstLine("msg_t", { type: "thinking", thinking: "just thinking" }, { input_tokens: 1, output_tokens: 50 }));
    const { session } = parseTranscript(content);
    expect(session!.turns).toHaveLength(1);
    expect(session!.turns[0]!.thinking).toBe("just thinking");
    expect(session!.turns[0]!.text).toBeUndefined();
  });

  it("distinct message.ids stay distinct turns", () => {
    const content = jsonl(
      asstLine("msg_a", { type: "text", text: "one" }, { input_tokens: 1, output_tokens: 1 }),
      asstLine("msg_b", { type: "text", text: "two" }, { input_tokens: 1, output_tokens: 1 }),
    );
    expect(parseTranscript(content).session!.turns).toHaveLength(2);
  });
});

describe("API-error stub lines carry no model", () => {
  const realLine = {
    ...BASE,
    type: "assistant",
    timestamp: "2026-07-01T10:00:00.000Z",
    message: {
      id: "msg_real",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "on it" }],
      usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
  const stubLine = {
    ...BASE,
    type: "assistant",
    timestamp: "2026-07-01T10:00:05.000Z",
    isApiErrorMessage: true,
    message: {
      id: "msg_stub",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: connection dropped" }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };

  it("excludes an isApiErrorMessage <synthetic> stub from models, leaves its turn without a model, and moves no cost", () => {
    const withStub = parseTranscript(jsonl(realLine, stubLine)).session!;
    const withoutStub = parseTranscript(jsonl(realLine)).session!;
    expect(withStub.models).toEqual(["claude-sonnet-5"]);
    const stubTurn = withStub.turns.find((t) => t.messageId === "msg_stub")!;
    expect(stubTurn.model).toBeUndefined();
    expect(withStub.totals).toEqual(withoutStub.totals);
  });

  it("excludes a <synthetic> model even without isApiErrorMessage set", () => {
    const unflaggedStub = { ...stubLine, isApiErrorMessage: undefined };
    const { session } = parseTranscript(jsonl(realLine, unflaggedStub));
    expect(session!.models).toEqual(["claude-sonnet-5"]);
  });

  it("excludes an isApiErrorMessage stub even when its model isn't literally <synthetic>", () => {
    const stubWithOtherModel = { ...stubLine, message: { ...stubLine.message, model: "claude-haiku-4-5-20251001" } };
    const { session } = parseTranscript(jsonl(realLine, stubWithOtherModel));
    expect(session!.models).toEqual(["claude-sonnet-5"]);
  });

  it("a later real line sharing the stub's message.id still sets the turn's model", () => {
    // same message.id as the stub above: the stub's line arrives first (leaving
    // open.model unset), then a real line in the SAME logical turn carries the model
    const stubFirst = { ...stubLine, message: { ...stubLine.message, id: "msg_mixed" } };
    const realSecond = {
      ...realLine,
      timestamp: "2026-07-01T10:00:05.000Z",
      message: { ...realLine.message, id: "msg_mixed", content: [{ type: "text", text: "retrying" }] },
    };
    const { session } = parseTranscript(jsonl(stubFirst, realSecond));
    expect(session!.turns).toHaveLength(1);
    expect(session!.turns[0]!.model).toBe("claude-sonnet-5");
  });
});

describe("subagent identity + parent linkage (the store-clobbering fix)", () => {
  it("keys a subagent by its OWN id, not the inherited parent sessionId", () => {
    // a subagent file: its JSONL sessionId is the PARENT's
    const content = jsonl({
      sessionId: "PARENT-5c3a1b2d",
      agentId: "a7d9df078856c9a9e",
      isSidechain: true,
      type: "assistant",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: { id: "m1", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "sub work" }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const { session } = parseTranscript(content, {
      isSubagent: true,
      parentSessionId: "PARENT-5c3a1b2d",
      ownId: "agent-a7d9df078856c9a9e",
    });
    expect(session!.id).toBe("agent-a7d9df078856c9a9e"); // own id
    expect(session!.id).not.toBe("PARENT-5c3a1b2d"); // NOT the parent (would clobber)
    expect(session!.subagent?.parentSessionId).toBe("PARENT-5c3a1b2d");
    expect(session!.subagent?.agentId).toBe("a7d9df078856c9a9e");
    // a path-detected subagent is an agent run
    expect(session!.agent.origin).toBe("agent");
  });

  it("a main session is unchanged (id = its sessionId, no subagent block)", () => {
    const content = jsonl({
      ...BASE,
      type: "assistant",
      message: { id: "m1", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const { session } = parseTranscript(content);
    expect(session!.id).toBe(BASE.sessionId);
    expect(session!.subagent).toBeUndefined();
  });
});

describe("session origin classification (SDK/headless vs interactive)", () => {
  function line(over: Record<string, unknown>): string {
    return jsonl({
      sessionId: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
      type: "user",
      timestamp: "2026-07-01T10:00:00.000Z",
      message: { role: "user", content: "do the thing" },
      ...over,
    });
  }

  it("classifies an SDK-spawned top-level transcript as an agent run", () => {
    // A real SDK user line: top-level (no parent, not a sidechain), external
    // user, entrypoint sdk-py, per-line promptSource sdk. Drift in this shape
    // (a renamed/moved field upstream) must break the classification test.
    const realSdkLine = jsonl({
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: "/home/dev/acme",
      sessionId: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
      version: "2.1.211",
      gitBranch: "main",
      type: "user",
      message: { role: "user", content: "review this PR" },
      promptSource: "sdk",
      entrypoint: "sdk-py",
      permissionMode: "default",
      uuid: "3f1c9a2e-1d4b-4a7c-9e2f-8b6a5c4d3e21",
      timestamp: "2026-07-01T10:00:00.000Z",
    });
    const { session } = parseTranscript(realSdkLine);
    // exact agent shape: SDK runs must not leak into the interactive list
    expect(session!.agent).toEqual({ type: "claude-code", version: "2.1.211", entrypoint: "sdk-py", origin: "agent" });
  });

  it("classifies a human-typed CLI session as interactive", () => {
    const { session } = parseTranscript(line({ entrypoint: "cli", promptSource: "typed" }));
    expect(session!.agent).toEqual({ type: "claude-code", entrypoint: "cli", origin: "interactive" });
  });

  it("classifies a headless sdk-cli run (no promptSource) as an agent run", () => {
    const { session } = parseTranscript(line({ entrypoint: "sdk-cli" }));
    expect(session!.agent).toEqual({ type: "claude-code", entrypoint: "sdk-cli", origin: "agent" });
  });

  it("a bare cli session with no promptSource stays interactive", () => {
    const { session } = parseTranscript(line({ entrypoint: "cli" }));
    expect(session!.agent.origin).toBe("interactive");
  });

  it("a lone sdk promptSource line marks the session agent even when the entrypoint is cli", () => {
    const { session } = parseTranscript(line({ entrypoint: "cli", promptSource: "sdk" }));
    expect(session!.agent.origin).toBe("agent");
  });
});

describe("image capture (blob refs, bytes out-of-band)", () => {
  const IMG = "iVBORw0KGgoAAAANSUhEUg"; // fake base64
  function imageLine(): Record<string, unknown> {
    return {
      ...BASE,
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: IMG } },
          { type: "text", text: "what is this?" },
        ],
      },
    };
  }

  it("captures an image block as a sha256 ref on the turn + returns bytes in blobs", () => {
    const { session, blobs } = parseTranscript(jsonl(imageLine()));
    const turn = session!.turns[0]!;
    expect(turn.images).toHaveLength(1);
    expect(turn.images![0]!.mediaType).toBe("image/png");
    expect(turn.images![0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the AgentSession carries only the ref — the base64 is NOT inline
    expect(JSON.stringify(session)).not.toContain(IMG);
    // bytes come back in blobs, keyed by the same hash
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.data).toBe(IMG);
    expect(blobs[0]!.sha256).toBe(turn.images![0]!.sha256);
  });

  it("dedupes identical images across turns to one blob", () => {
    const { blobs } = parseTranscript(jsonl(imageLine(), imageLine()));
    expect(blobs).toHaveLength(1); // same bytes → one blob
  });

  it("a turn with only an image (no text) is still a real turn", () => {
    const line = imageLine();
    (line.message as { content: unknown[] }).content = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMG } },
    ];
    const { session } = parseTranscript(jsonl(line));
    expect(session!.turns).toHaveLength(1);
    expect(session!.turns[0]!.images).toHaveLength(1);
    expect(session!.turns[0]!.text).toBeUndefined();
  });

  it("captures a SCREENSHOT returned inside a tool_result (browser/computer-use) as a blob + ref, base64 stripped from output", () => {
    const SHOT = "R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs"; // fake screenshot bytes
    const content = jsonl(
      {
        ...BASE,
        type: "assistant",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "tool_use", id: "toolu_shot", name: "computer", input: { action: "screenshot" } }], usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        ...BASE,
        type: "user",
        timestamp: "2026-07-01T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_shot",
              content: [
                { type: "text", text: "Screenshot captured (1288x932)" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: SHOT } },
              ],
            },
          ],
        },
      },
    );
    const { session, blobs } = parseTranscript(content);

    // The screenshot bytes ship ONCE, out-of-band, content-addressed.
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.data).toBe(SHOT);
    expect(blobs[0]!.mediaType).toBe("image/png");

    // A ref surfaces on a turn so the image renders in the transcript.
    const imgTurn = session!.turns.find((t) => (t.images?.length ?? 0) > 0)!;
    expect(imgTurn.images).toEqual([
      { mediaType: "image/png", sha256: blobs[0]!.sha256, bytes: expect.any(Number) },
    ]);

    // The base64 is NOWHERE in the session JSON — not inline in the tool output,
    // not on the turn. Only the sha256 ref remains. Bytes left inline in
    // call.output are invisible to the image renderer and bloat every sync.
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain(SHOT);
    expect(serialized).toContain(blobs[0]!.sha256);
    // The tool call's status/text still resolved normally alongside the image.
    const call = session!.turns[0]!.toolCalls.find((c) => c.name === "computer")!;
    expect(call.status).toBe("ok");
  });
});

describe("normalizeErrorSignature", () => {
  it("strips paths, line/col numbers, uuids, and hex so errors cluster", () => {
    const a = normalizeErrorSignature("Error at /Users/x/proj/src/a.ts:42:7 (id 3f2504e0-4f89-41d3-9a0c-0305e82c3301)");
    const b = normalizeErrorSignature("Error at /home/y/other/b.ts:99:1 (id a1b2c3d4-0000-1111-2222-333344445555)");
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{2,}/);
  });
});
