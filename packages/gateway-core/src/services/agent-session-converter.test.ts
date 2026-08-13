import { describe, expect, it } from "vitest";
import type { AgentSession } from "@outerlayer/session-schema";
import { SpanType } from "@repo/shared-utils";
import {
  agentSessionSummaryRow,
  agentSessionToClickHouseRows,
  agentSessionToNormalizedSpans,
  effectiveTier,
  resolveWorkerKind,
  scrubText,
  scrubSession,
  traceIdForSession,
  spanIdForPath,
} from "./agent-session-converter";
import type { UserMeta } from "../types";

const META: UserMeta = {
  tenantId: "tenant-1",
  appId: "app-1",
} as UserMeta;

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    schemaVersion: 1,
    id: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
    agent: { type: "claude-code", version: "2.1.201" },
    env: { cwd: "/home/dev/acme", gitBranch: "main" },
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T11:00:00.000Z",
    models: ["claude-opus-4-8"],
    turns: [
      { index: 0, role: "user", toolCalls: [], text: "Fix the build", ts: "2026-07-01T10:00:01.000Z" },
      {
        index: 1,
        role: "assistant",
        text: "Running the build.",
        thinking: "check scripts first",
        model: "claude-opus-4-8",
        costUsd: 0.25,
        usage: { in: 100, out: 50, cacheRead: 1000, cacheCreate: 10 },
        toolCalls: [
          {
            name: "Bash",
            status: "error",
            isEdit: false,
            errorSignature: "yarn build exited with code 1",
            input: '{"command":"yarn build"}',
            output: "error TS2307",
            durationMs: 1200,
          },
        ],
        ts: "2026-07-01T10:00:05.000Z",
      },
    ],
    events: [{ type: "api_error", seq: 0, ts: "2026-07-01T10:30:00.000Z" }],
    totals: { inputTokens: 1100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 10, costUsd: 0.25 },
    title: "Fix the build",
    captureTier: "full",
    warnings: [],
    ...over,
  };
}

describe("deterministic identity", () => {
  it("uuid session ids map losslessly; non-uuids hash; both are stable", () => {
    expect(traceIdForSession("5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b")).toBe("5c3a1b2d4e6f47089a1b2c3d4e5f6a7b");
    const hashed = traceIdForSession("not-a-uuid");
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdForSession("not-a-uuid")).toBe(hashed);
    expect(spanIdForPath("abc", "turn:1")).toBe(spanIdForPath("abc", "turn:1"));
    expect(spanIdForPath("abc", "turn:1")).not.toBe(spanIdForPath("abc", "turn:2"));
  });

  it("re-converting the same session yields byte-identical rows (idempotent re-sync)", () => {
    const opts = { meta: META, actorId: "member-1", tenantTier: "full" as const };
    const a = agentSessionToClickHouseRows(session(), opts);
    const b = agentSessionToClickHouseRows(session(), opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("span tree mapping", () => {
  it("maps session→root, turns→turn spans, tool calls→children with error status", () => {
    const spans = agentSessionToNormalizedSpans(session(), { actorId: "member-1", tier: "full" });
    expect(spans.map((s) => s.name)).toEqual(["agent.session", "agent.turn.user", "agent.turn.assistant", "agent.tool.Bash"]);
    const root = spans[0]!;
    const assistant = spans[2]!;
    const tool = spans[3]!;
    // root: events carried, NO cost/tokens (SUM must not double-count)
    expect(root.events.map((e) => e.name)).toEqual(["api_error"]);
    expect(root.cost).toBeUndefined();
    expect(root.metadata).toMatchObject({ agentType: "claude-code", gitBranch: "main", title: "Fix the build", captureTier: "full" });
    // assistant turn: GENERATION with per-turn economics
    expect(assistant.type).toBe("GENERATION");
    expect(assistant.model).toBe("claude-opus-4-8");
    expect(assistant.inputTokens).toBe(100); // uncached only — cache rides spanAttributes
    expect(assistant.totalTokens).toBe(100 + 1000 + 10 + 50);
    expect(assistant.outputTokens).toBe(50);
    expect(assistant.cost).toBe(0.25);
    expect(assistant.output).toBe("Running the build.");
    expect(assistant.spanAttributes["outerlayer.reasoning"]).toBe("check scripts first");
    // Semconv alignment (registry keys): official cache-token attributes,
    // machine-readable operation, and the conversation id.
    expect(assistant.spanAttributes["gen_ai.usage.cache_read.input_tokens"]).toBe(1000);
    expect(assistant.spanAttributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(10);
    expect(assistant.spanAttributes["gen_ai.operation.name"]).toBe("chat");
    expect(assistant.parentSpanId).toBe(root.spanId);
    // tool call: child of the assistant turn, error status + signature
    expect(tool.parentSpanId).toBe(assistant.spanId);
    expect(tool.statusCode).toBe("2");
    expect(tool.statusMessage).toBe("yarn build exited with code 1");
    expect(tool.output).toBe("error TS2307");
    expect(tool.duration).toBe(1200);
    expect(tool.metadata).toMatchObject({ toolName: "Bash", toolStatus: "error", turnIndex: "1" });
  });
});

describe("hook execution spans", () => {
  function withHookEvent(over: Partial<AgentSession> = {}): AgentSession {
    return session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          ts: "2026-07-01T10:06:30.000Z",
          data: {
            hookCount: 2,
            hooks: [{ command: "./scripts/lint.sh", durationMs: 13500 }, { command: "./scripts/slow-hook.sh" }],
          },
        },
      ],
      ...over,
    });
  }

  it("emits one child span per hook entry: end-anchored timing, deterministic id, unreported duration flagged (not 0-and-silent)", () => {
    const s = withHookEvent();
    const traceId = traceIdForSession(s.id);
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const root = spans[0]!;
    const hookSpans = spans.filter((sp) => sp.name.startsWith("agent.hook."));
    expect(hookSpans).toHaveLength(2);
    const endTime = Date.parse("2026-07-01T10:06:30.000Z");
    const base = {
      traceId,
      resourceAttributes: { "service.name": "outerlayer-agent" },
      links: [],
      serviceName: "outerlayer-agent",
      sessionId: s.id,
      parentSpanId: root.spanId,
      type: SpanType.SPAN,
      name: "agent.hook.stop",
      kind: "SPAN_KIND_INTERNAL",
      statusCode: "1",
      spanAttributes: { "gen_ai.conversation.id": s.id },
      events: [],
    };
    expect(hookSpans[0]).toEqual({
      ...base,
      spanId: spanIdForPath(traceId, "hook:1:0"),
      startTime: endTime - 13500,
      endTime,
      duration: 13500,
      metadata: { gitBranch: "main", workerKind: "seat", hookEvent: "Stop", hookCommand: "./scripts/lint.sh" },
    });
    expect(hookSpans[1]).toEqual({
      ...base,
      spanId: spanIdForPath(traceId, "hook:1:1"),
      startTime: endTime,
      endTime,
      duration: 0,
      metadata: {
        gitBranch: "main",
        workerKind: "seat",
        hookEvent: "Stop",
        hookCommand: "./scripts/slow-hook.sh",
        durationUnreported: "1",
      },
    });
  });

  it("marks hook spans error-status from the content-free errorCount, with the full-tier errorText as statusMessage", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          ts: "2026-07-01T10:06:30.000Z",
          data: { hooks: [{ command: "./scripts/lint.sh", durationMs: 200 }], errorCount: 1 },
          errorText: ["lint failed: 3 errors"],
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.statusCode).toBe("2");
    expect(hookSpan.statusMessage).toBe("lint failed: 3 errors");
  });

  it("at redacted tier: command/duration/errorCount-driven status survive; the raw error text does not", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          ts: "2026-07-01T10:06:30.000Z",
          data: { hooks: [{ command: "./scripts/lint.sh", durationMs: 200 }], errorCount: 1 },
          errorText: ["lint failed: 3 errors"],
        },
      ],
    });
    const rows = agentSessionToClickHouseRows(s, { meta: META, actorId: "m-1", tenantTier: "redacted" });
    const hookRow = rows.find((r) => typeof r.SpanName === "string" && r.SpanName.startsWith("agent.hook."))!;
    // kept at redacted: command identifies which hook ran, duration, and
    // failure stays VISIBLE (status flips) even with no text to explain it
    expect(hookRow.Metadata.hookCommand).toBe("./scripts/lint.sh");
    expect(hookRow.Duration).toBe(200);
    expect(hookRow.StatusCode).toBe("2");
    // stripped at redacted: the raw stderr body
    expect(JSON.stringify(hookRow)).not.toContain("lint failed: 3 errors");
  });

  it("treats a negative, non-integer, non-finite, or absurdly large (>UInt32) durationMs as NOT REPORTED rather than storing it", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          // ts well clear of session start — an event with no ts falls back
          // to the root's own startTime, which would make even a genuine
          // 200ms duration collide with the root-start floor below.
          ts: "2026-07-01T10:06:30.000Z",
          data: {
            hooks: [
              { command: "a", durationMs: -5 },
              { command: "b", durationMs: Number.NaN },
              { command: "c", durationMs: Number.POSITIVE_INFINITY },
              { command: "d", durationMs: 1.5 },
              { command: "f", durationMs: 4_294_967_296 }, // one past UInt32 max
              { command: "e", durationMs: 200 }, // the one valid entry
            ],
          },
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpans = spans.filter((sp) => sp.name === "agent.hook.stop");
    expect(hookSpans.map((sp) => ({ duration: sp.duration, unreported: sp.metadata.durationUnreported }))).toEqual([
      { duration: 0, unreported: "1" },
      { duration: 0, unreported: "1" },
      { duration: 0, unreported: "1" },
      { duration: 0, unreported: "1" },
      { duration: 0, unreported: "1" },
      { duration: 200, unreported: undefined },
    ]);
  });

  it("a hook span's derived startTime never precedes the session root's, and is never negative", () => {
    // The session lasted one hour, but this hook claims a valid (≤ UInt32),
    // still-wildly-implausible 30-day duration — end-anchoring naively would
    // put its start 29 days before the session even began.
    const s = session({
      startedAt: "2026-07-01T10:00:00.000Z",
      endedAt: "2026-07-01T11:00:00.000Z",
      events: [
        {
          type: "hook_executed",
          seq: 1,
          ts: "2026-07-01T10:30:00.000Z",
          data: { hooks: [{ command: "a", durationMs: 30 * 24 * 60 * 60 * 1000 }] },
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const root = spans[0]!;
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.startTime).toBe(root.startTime);
    expect(hookSpan.startTime).toBeGreaterThanOrEqual(0);
    // duration is recomputed from the clamped start, so it stays consistent
    // with what actually renders on the axis (never the original 30-day claim)
    expect(hookSpan.duration).toBe(hookSpan.endTime! - hookSpan.startTime);
    expect(hookSpan.duration).toBeLessThan(30 * 24 * 60 * 60 * 1000);
  });

  it("caps hook entries per event at the server, even when the client sends more than its own parser cap allows", () => {
    const manyHooks = Array.from({ length: 60 }, (_, i) => ({ command: `hook-${i}`, durationMs: i }));
    const s = session({ events: [{ type: "hook_executed", seq: 1, data: { hooks: manyHooks } }] });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    expect(spans.filter((sp) => sp.name === "agent.hook.stop")).toHaveLength(50);
  });

  it("a metrics-tier tenant strips hook_executed event data before the span step runs — zero agent.hook.* spans", () => {
    const rows = agentSessionToClickHouseRows(withHookEvent(), { meta: META, actorId: "m-1", tenantTier: "metrics" });
    expect(rows.some((r) => typeof r.SpanName === "string" && r.SpanName.startsWith("agent.hook."))).toBe(false);
  });

  it("scrubs a secret and a home path out of the hook command before it reaches span metadata", () => {
    const planted = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hooks: [{ command: "curl -H 'Authorization: sk-ant-" + "x".repeat(24) + "' /Users/alex/deploy.sh" }] },
        },
      ],
    });
    const rows = agentSessionToClickHouseRows(planted, { meta: META, actorId: "m-1", tenantTier: "full" });
    const hookRow = rows.find((r) => typeof r.SpanName === "string" && r.SpanName.startsWith("agent.hook."))!;
    const dump = JSON.stringify(hookRow);
    expect(dump).not.toContain("sk-ant-" + "x".repeat(24));
    expect(dump).toContain("~/deploy.sh");
  });

  it("scrubs a secret planted in hook errorText, and leaves a non-string entry intact rather than mapping it to undefined", () => {
    const secret = "sk-ant-" + "x".repeat(24);
    const planted = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hooks: [{ command: "./scripts/lint.sh", durationMs: 200 }], errorCount: 2 },
          // scrubSession's errorText scrub must run per-element: a live-looking
          // secret gets scrubbed, and a malformed non-string entry survives the
          // pass unchanged rather than becoming undefined.
          errorText: [`auth failed: ${secret}`, 42 as unknown as string],
        },
      ],
    });
    const rows = agentSessionToClickHouseRows(planted, { meta: META, actorId: "m-1", tenantTier: "full" });
    const hookRow = rows.find((r) => typeof r.SpanName === "string" && r.SpanName.startsWith("agent.hook."))!;
    const dump = JSON.stringify(hookRow);
    expect(dump).not.toContain(secret);
    expect(hookRow.StatusMessage).toContain("[SCRUBBED:anthropic-key]");
    expect(hookRow.StatusMessage).toContain("42");
  });

  it("errorCount of exactly 0 does not mark the hook errored (boundary, not just non-zero)", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hooks: [{ command: "./scripts/lint.sh", durationMs: 200 }], errorCount: 0 },
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.statusCode).toBe("1");
  });

  it("a non-numeric errorCount does not mark the hook errored", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hooks: [{ command: "./scripts/lint.sh", durationMs: 200 }], errorCount: "2" as unknown as number },
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.statusCode).toBe("1");
  });

  it("durationMs: 0 is REPORTED (a genuinely instant hook), distinct from unreported", () => {
    const s = session({
      events: [{ type: "hook_executed", seq: 1, data: { hooks: [{ command: "a", durationMs: 0 }] } }],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.duration).toBe(0);
    expect(hookSpan.metadata.durationUnreported).toBeUndefined();
  });

  it("a non-number durationMs (e.g. a string) is unreported, not coerced", () => {
    const s = session({
      events: [{ type: "hook_executed", seq: 1, data: { hooks: [{ command: "a", durationMs: "200" as unknown as number }] } }],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.duration).toBe(0);
    expect(hookSpan.metadata.durationUnreported).toBe("1");
  });

  it("caps statusMessage at 500 chars, same as every other capped content field", () => {
    const longError = "E".repeat(600);
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hooks: [{ command: "a", durationMs: 200 }], errorCount: 1 },
          errorText: [longError],
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.statusMessage).toHaveLength(500);
  });

  it("the hook span name is exactly agent.hook.stop", () => {
    const spans = agentSessionToNormalizedSpans(withHookEvent(), { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name.startsWith("agent.hook."))!;
    expect(hookSpan.name).toBe("agent.hook.stop");
  });

  it("toolUseId reaches the hook span's metadata when the event carries one", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hooks: [{ command: "a", durationMs: 200 }], toolUseId: "toolu_99" },
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.metadata.toolUseId).toBe("toolu_99");
  });

  it("a wrapped hook whose toolUseId matches a tool call parents to that TOOL span, not root", () => {
    const s = session({
      turns: [
        {
          index: 1,
          role: "assistant",
          toolCalls: [{ name: "Edit", status: "ok", isEdit: true, toolUseId: "toolu_1" }],
        },
      ],
      events: [
        {
          type: "hook_executed",
          seq: 1,
          ts: "2026-07-01T10:06:30.000Z",
          data: { hookEvent: "PreToolUse", hooks: [{ command: "./scripts/guard.sh", durationMs: 20, toolUseId: "toolu_1" }] },
        },
      ],
    });
    const traceId = traceIdForSession(s.id);
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const toolSpan = spans.find((sp) => sp.name === "agent.tool.Edit")!;
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.pre_tool_use")!;
    // The hook bar renders directly under the Edit it wrapped, not the root.
    expect(hookSpan.parentSpanId).toBe(toolSpan.spanId);
    expect(hookSpan.parentSpanId).toBe(spanIdForPath(traceId, "turn:1:call:0"));
    expect(hookSpan.metadata.toolUseId).toBe("toolu_1");
    expect(hookSpan.metadata.toolUseIdUnresolved).toBeUndefined();
  });

  it("an unresolvable toolUseId (names no tool call in this session) falls back to root-parenting, flagged", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: { hookEvent: "PostToolUse", hooks: [{ command: "a", durationMs: 5, toolUseId: "toolu_missing" }] },
        },
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const root = spans[0]!;
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.post_tool_use")!;
    expect(hookSpan.parentSpanId).toBe(root.spanId);
    expect(hookSpan.metadata.toolUseId).toBe("toolu_missing");
    expect(hookSpan.metadata.toolUseIdUnresolved).toBe("1");
  });

  it("no toolUseId at all (event or per-hook) root-parents with no id in metadata — the legacy Stop-hook shape", () => {
    const s = withHookEvent();
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const root = spans[0]!;
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.stop")!;
    expect(hookSpan.parentSpanId).toBe(root.spanId);
    expect(hookSpan.metadata.toolUseId).toBeUndefined();
    expect(hookSpan.metadata.toolUseIdUnresolved).toBeUndefined();
  });

  it("a per-hook toolUseId wins over the event-level batch id when both are present", () => {
    const s = session({
      turns: [
        { index: 1, role: "assistant", toolCalls: [{ name: "Bash", status: "ok", isEdit: false, toolUseId: "toolu_specific" }] },
      ],
      events: [
        {
          type: "hook_executed",
          seq: 1,
          // Event-level id points nowhere; the per-hook id is the real match.
          data: {
            hookEvent: "PreToolUse",
            toolUseId: "toolu_batch_wrong",
            hooks: [{ command: "a", durationMs: 5, toolUseId: "toolu_specific" }],
          },
        },
      ],
    });
    const traceId = traceIdForSession(s.id);
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpan = spans.find((sp) => sp.name === "agent.hook.pre_tool_use")!;
    expect(hookSpan.parentSpanId).toBe(spanIdForPath(traceId, "turn:1:call:0"));
    expect(hookSpan.metadata.toolUseId).toBe("toolu_specific");
  });

  it("wrapped-hook span names are exactly agent.hook.pre_tool_use / agent.hook.post_tool_use; transcript-derived stays agent.hook.stop", () => {
    const s = session({
      events: [
        { type: "hook_executed", seq: 1, data: { hookEvent: "PreToolUse", hooks: [{ command: "a", durationMs: 1 }] } },
        { type: "hook_executed", seq: 2, data: { hookEvent: "PostToolUse", hooks: [{ command: "b", durationMs: 1 }] } },
        { type: "hook_executed", seq: 3, data: { hooks: [{ command: "c", durationMs: 1 }] } }, // no hookEvent → Stop default
      ],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    const hookSpanNames = spans.filter((sp) => sp.name.startsWith("agent.hook.")).map((sp) => sp.name);
    expect(hookSpanNames).toEqual(["agent.hook.pre_tool_use", "agent.hook.post_tool_use", "agent.hook.stop"]);
  });

  it("a non-hook_executed event never produces a hook span", () => {
    const s = session({ events: [{ type: "api_error", seq: 1, data: { code: "ECONNRESET" } }] });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    expect(spans.some((sp) => sp.name.startsWith("agent.hook."))).toBe(false);
  });

  it("a hook_executed event with an empty hooks array produces no span at all", () => {
    const s = session({ events: [{ type: "hook_executed", seq: 1, data: { hooks: [] } }] });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    expect(spans.some((sp) => sp.name.startsWith("agent.hook."))).toBe(false);
  });

  it("the type guard rejects hook-shaped data on the WRONG event type, not just missing data", () => {
    // If `event.type` weren't checked, this foreign event's hooks-shaped
    // `data` would sail through the rest of the loop and produce a span.
    const s = session({
      events: [{ type: "queue_operation", seq: 1, data: { hooks: [{ command: "a", durationMs: 200 }] } }],
    });
    const spans = agentSessionToNormalizedSpans(s, { actorId: "member-1", tier: "full", workerKind: "seat" });
    expect(spans.some((sp) => sp.name.startsWith("agent.hook."))).toBe(false);
  });
});

describe("tier enforcement (client lies, server truncates)", () => {
  it("effectiveTier is the lower of client and tenant", () => {
    expect(effectiveTier("full", "metrics")).toBe("metrics");
    expect(effectiveTier("metrics", "full")).toBe("metrics");
    expect(effectiveTier("redacted", "redacted")).toBe("redacted");
  });

  it("client sends full while tenant=metrics → stored rows contain ZERO content fields", () => {
    const rows = agentSessionToClickHouseRows(session(), { meta: META, actorId: "m-1", tenantTier: "metrics" });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("Fix the build");
    expect(dump).not.toContain("Running the build.");
    expect(dump).not.toContain("check scripts first");
    expect(dump).not.toContain("yarn build");
    expect(dump).not.toContain("error TS2307");
    // …but the metrics skeleton survives: economics + statuses + identity
    expect(rows.some((r) => r.CaptureTier === "metrics")).toBe(true);
    expect(rows.every((r) => r.ActorId === "m-1" && r.AgentType === "claude-code")).toBe(true);
  });
});

describe("secret scrub (all tiers, before write)", () => {
  it("scrubs the pattern set; leaves ordinary text alone", () => {
    expect(scrubText("key AKIAIOSFODNN7EXAMPLE leaked")).toBe("key [SCRUBBED:aws-key-id] leaked");
    expect(scrubText("ghp_" + "a".repeat(36))).toBe("[SCRUBBED:github-token]");
    expect(scrubText("sk-ant-" + "x".repeat(24))).toBe("[SCRUBBED:anthropic-key]");
    expect(scrubText("plain build output, no secrets")).toBe("plain build output, no secrets");
  });

  it("a planted AWS key in tool output is not present at rest in ANY tier", () => {
    const planted = session({
      turns: [
        {
          index: 0,
          role: "assistant",
          toolCalls: [{ name: "Bash", status: "ok", isEdit: false, output: "creds: AKIAIOSFODNN7EXAMPLE done" }],
          text: "printed env",
        },
      ],
    });
    for (const tenantTier of ["full", "redacted", "metrics"] as const) {
      const rows = agentSessionToClickHouseRows(planted, { meta: META, actorId: "m", tenantTier });
      expect(JSON.stringify(rows), tenantTier).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });

  it("scrubSession does not mutate its input", () => {
    const s = session();
    const before = JSON.stringify(s);
    scrubSession(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("anonymizes home paths across OS shapes, preserving separator style", () => {
    expect(scrubText("Read /Users/mira/app/src/i.ts")).toBe("Read ~/app/src/i.ts");
    expect(scrubText("open C:\\Users\\jane\\p\\a.ts")).toBe("open ~\\p\\a.ts");
    expect(scrubText("wsl \\\\wsl$\\Ubuntu\\home\\amy\\r.md")).toBe("wsl ~\\r.md");
    expect(scrubText("mnt /mnt/c/Users/carl/y.ts")).toBe("mnt ~/y.ts");
    // not a home path
    expect(scrubText("scan /rootkit/mod and src/Users/model.ts")).toBe("scan /rootkit/mod and src/Users/model.ts");
  });

  it("leaves no username-bearing home prefix at rest (leak pin)", () => {
    const planted = session({
      turns: [
        {
          index: 0,
          role: "assistant",
          toolCalls: [{ name: "Read", status: "ok", isEdit: false, file: "/Users/mira/app/secret-dir/x.ts", output: "read C:\\Users\\jane\\notes.md" }],
          text: "opened /Users/mira/app/a.ts",
        },
      ],
    });
    const rows = agentSessionToClickHouseRows(planted, { meta: META, actorId: "m", tenantTier: "full" });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("/Users/mira");
    expect(serialized).not.toContain(":\\Users\\jane");
  });
});

describe("loose-schema resilience + cost exactness", () => {
  it("array tool outputs (structured tool_result blocks) convert and scrub instead of throwing", () => {
    const weird = session({
      turns: [
        {
          index: 0,
          role: "assistant",
          toolCalls: [
            {
              name: "Read",
              status: "ok",
              isEdit: false,
              // the loose schema lets structured blocks through as arrays
              output: [{ type: "text", text: "creds AKIAIOSFODNN7EXAMPLE here" }] as unknown as string,
            },
          ],
          text: "read it",
        },
      ],
    });
    const rows = agentSessionToClickHouseRows(weird, { meta: META, actorId: "m", tenantTier: "full" });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("AKIAIOSFODNN7EXAMPLE"); // scrubbed inside the array too
    expect(dump).toContain("[SCRUBBED:aws-key-id]");
  });

  // proves AC-070-11
  it("SUM(Cost) over rows equals the session's exact total even when per-turn costs overshoot", () => {
    const overshooting = session({
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 10 },
      turns: [
        // model+usage+cost together = the combination that triggers the shared
        // builder's cache-blind repricing; the wrapper must still win
        { index: 0, role: "assistant", toolCalls: [], text: "a", costUsd: 8, model: "claude-opus-4-8", usage: { in: 100, out: 50, cacheRead: 9_000_000, cacheCreate: 0 } },
        { index: 1, role: "assistant", toolCalls: [], text: "b", costUsd: 4, model: "claude-opus-4-8", usage: { in: 100, out: 50, cacheRead: 9_000_000, cacheCreate: 0 } },
      ], // per-turn sum = 12, exact total = 10 (codex-style overshoot)
    });
    const rows = agentSessionToClickHouseRows(overshooting, { meta: META, actorId: "m", tenantTier: "full" });
    const total = rows.reduce((a, r) => a + (typeof r.Cost === "number" ? r.Cost : 0), 0);
    expect(total).toBeCloseTo(10, 6);
    const costs = rows.map((r) => r.Cost).filter((c): c is number => typeof c === "number" && c > 0);
    expect(costs[0]! / costs[1]!).toBeCloseTo(2, 6); // proportions preserved
  });
});

describe("server-side repricing", () => {
  // A price map the client's frozen snapshot didn't have. Rates are the shape
  // the registry stores (per token), with cache priced well below input —
  // pricing cache at the input rate is the specific mistake this guards.
  const PRICES = {
    "new-model-9": { in: 0.000005, out: 0.000025, cacheRead: 0.0000005, cacheCreate: 0.00000625 },
  };
  const OPTS = { meta: META, actorId: "m", tenantTier: "full", tokenPricing: PRICES } as const;

  /** One assistant turn on a model the capture client could not price. */
  const unpriced = (over: Partial<AgentSession> = {}) =>
    session({
      models: ["new-model-9"],
      turns: [
        {
          index: 0,
          role: "assistant",
          toolCalls: [],
          text: "a",
          model: "new-model-9",
          usage: { in: 100, out: 200, cacheRead: 50_000, cacheCreate: 1_000 },
        },
      ],
      totals: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50_000, cacheCreationTokens: 1_000 },
      ...over,
    });

  // 100*5e-6 + 200*2.5e-5 + 50000*5e-7 + 1000*6.25e-6 = 0.03675
  const EXPECTED = 0.03675;

  it("prices a turn the client left unpriced, charging each token class its own rate", () => {
    const rows = agentSessionToClickHouseRows(unpriced(), OPTS);
    const turn = rows.find((r) => r.SpanName === "agent.turn.assistant")!;
    expect(turn.Cost).toBeCloseTo(EXPECTED, 9);
    expect(agentSessionSummaryRow(unpriced(), OPTS).CostUsd).toBeCloseTo(EXPECTED, 6);
  });

  it("does not price cache-read at the input rate", () => {
    // The cache-blind computation would be (100 + 50000 + 1000) * 5e-6 +
    // 200 * 2.5e-5 = 0.2605 — nearly 7x the truth on this turn alone.
    expect(agentSessionSummaryRow(unpriced(), OPTS).CostUsd).toBeLessThan(0.1);
  });

  it("leaves a client-priced turn alone rather than second-guessing the provider's own usage record", () => {
    const s = unpriced();
    s.turns[0]!.costUsd = 0.99;
    s.totals.costUsd = 0.99;
    const turn = agentSessionToClickHouseRows(s, OPTS).find((r) => r.SpanName === "agent.turn.assistant")!;
    expect(turn.Cost).toBeCloseTo(0.99, 9);
  });

  it("recomputes the session total when it filled in a turn, so the rollup counts every turn", () => {
    // Client priced turn 0 only; its total reflects just that turn. Trusting it
    // would report $1.00 for a session that also ran an unpriced turn.
    const s = unpriced({
      turns: [
        { index: 0, role: "assistant", toolCalls: [], text: "a", model: "new-model-9", costUsd: 1, usage: { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 } },
        { index: 1, role: "assistant", toolCalls: [], text: "b", model: "new-model-9", usage: { in: 100, out: 200, cacheRead: 50_000, cacheCreate: 1_000 } },
      ],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1 },
    });
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBeCloseTo(1 + EXPECTED, 6);
  });

  // proves AC-070-11
  it("prices each turn against its own model when a session mixes models", () => {
    const mixed = session({
      models: ["new-model-9", "cheap-model-1"],
      turns: [
        { index: 0, role: "assistant", toolCalls: [], text: "a", model: "new-model-9", usage: { in: 1000, out: 0, cacheRead: 0, cacheCreate: 0 } },
        { index: 1, role: "assistant", toolCalls: [], text: "b", model: "cheap-model-1", usage: { in: 1000, out: 0, cacheRead: 0, cacheCreate: 0 } },
      ],
      totals: { inputTokens: 2000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    const prices = { ...PRICES, "cheap-model-1": { in: 0.000001, out: 0.000005, cacheRead: 0, cacheCreate: 0 } };
    const costs = agentSessionToClickHouseRows(mixed, { ...OPTS, tokenPricing: prices })
      .filter((r) => r.SpanName === "agent.turn.assistant")
      .map((r) => r.Cost);
    expect(costs).toEqual([0.005, 0.001]);
  });

  it("leaves a still-unknown model unpriced rather than inventing a zero", () => {
    const s = unpriced();
    s.turns[0]!.model = "model-nobody-has-heard-of";
    const turn = agentSessionToClickHouseRows(s, OPTS).find((r) => r.SpanName === "agent.turn.assistant")!;
    expect(turn.Cost).toBe(0);
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBe(0);
  });

  it("ignores non-finite and negative client token counts instead of poisoning the insert", () => {
    const s = unpriced();
    s.turns[0]!.usage = { in: Number.NaN, out: -50, cacheRead: Number.POSITIVE_INFINITY, cacheCreate: 1_000 };
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBeCloseTo(1_000 * 0.00000625, 9);
  });

  it("never bills a user turn, even if one arrives carrying a cost", () => {
    // Only assistant turns are inference. A user turn with a cost is malformed
    // client input; counting it would double-bill the session.
    const s = unpriced({
      turns: [
        { index: 0, role: "user", toolCalls: [], text: "go", costUsd: 5 },
        { index: 1, role: "assistant", toolCalls: [], text: "a", model: "new-model-9", usage: { in: 100, out: 200, cacheRead: 50_000, cacheCreate: 1_000 } },
      ],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBeCloseTo(EXPECTED, 6);
  });

  it("reprices a turn whose client cost is not a finite number rather than trusting it", () => {
    const s = unpriced();
    s.turns[0]!.costUsd = Number.NaN;
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBeCloseTo(EXPECTED, 6);
  });

  it("leaves a turn unpriced when it has usage but no model, or a model but no usage", () => {
    const noModel = unpriced();
    delete noModel.turns[0]!.model;
    expect(agentSessionSummaryRow(noModel, OPTS).CostUsd).toBe(0);

    const noUsage = unpriced();
    delete noUsage.turns[0]!.usage;
    expect(agentSessionSummaryRow(noUsage, OPTS).CostUsd).toBe(0);
  });

  it("drops a negative client cost instead of subtracting it from the session", () => {
    const s = unpriced({
      turns: [
        { index: 0, role: "assistant", toolCalls: [], text: "a", model: "new-model-9", costUsd: -3 },
        { index: 1, role: "assistant", toolCalls: [], text: "b", model: "new-model-9", costUsd: 2 },
      ],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.CostUsd).toBe(2);
    const costs = agentSessionToClickHouseRows(s, OPTS)
      .filter((r) => r.SpanName === "agent.turn.assistant")
      .map((r) => r.Cost);
    expect(costs).toEqual([0, 2]);
  });

  it("keeps the client's exact total when it priced every turn, even where that total disagrees with the turn sum", () => {
    // The codex reconciliation: per-turn figures are approximations, the
    // session total is exact. Recomputing from the turns here would report 12
    // for a session that actually cost 10.
    const s = unpriced({
      turns: [
        { index: 0, role: "assistant", toolCalls: [], text: "a", model: "new-model-9", costUsd: 8, usage: { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 } },
        { index: 1, role: "assistant", toolCalls: [], text: "b", model: "new-model-9", costUsd: 4, usage: { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 } },
      ],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 10 },
    });
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBe(10);
  });

  it("keeps a client total for a session it could not price at all, rather than zeroing it", () => {
    // No turn carries usage, so nothing is recomputable — but the client still
    // reported a total, and that is the only figure anyone has.
    const s = unpriced({
      turns: [{ index: 0, role: "assistant", toolCalls: [], text: "a", model: "model-nobody-has-heard-of" }],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 7 },
    });
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBe(7);
  });

  it("falls back to the turn sum when the client's own total is not a finite number", () => {
    // A NaN total must never reach the ClickHouse insert as the session's cost.
    const s = unpriced({
      turns: [
        { index: 0, role: "assistant", toolCalls: [], text: "a", model: "new-model-9", costUsd: 3 },
      ],
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: Number.NaN },
    });
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBe(3);
  });

  it("ignores a non-numeric token count rather than multiplying a string by a price", () => {
    const s = unpriced();
    s.turns[0]!.usage = { in: "100" as unknown as number, out: 200, cacheRead: 0, cacheCreate: 0 };
    // 200 * 2.5e-5 only — the string input contributes nothing.
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBeCloseTo(0.005, 9);
  });

  it("keeps sub-cent sessions instead of rounding them away to a fabricated zero", () => {
    const s = unpriced();
    s.turns[0]!.costUsd = 0.004;
    s.totals.costUsd = 0.004;
    expect(agentSessionSummaryRow(s, OPTS).CostUsd).toBe(0.004);
  });
});

describe("row extension", () => {
  it("every row carries the three agent columns on top of the standard row shape", () => {
    const rows = agentSessionToClickHouseRows(session(), { meta: META, actorId: "member-9", tenantTier: "full" });
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.ActorId).toBe("member-9");
      expect(r.CaptureTier).toBe("full");
      expect(r.AgentType).toBe("claude-code");
      expect(r.TraceId).toBe("5c3a1b2d4e6f47089a1b2c3d4e5f6a7b");
    }
  });
});

describe("worker kind (run-origin attribution)", () => {
  it("resolves: declared value wins; junk/missing defaults from the key binding", () => {
    expect(resolveWorkerKind(session({ workerKind: "cloud" }), "membership-42")).toBe("cloud");
    expect(resolveWorkerKind(session({ workerKind: "ci" }), "key:k1")).toBe("ci");
    expect(resolveWorkerKind(session(), "membership-42")).toBe("seat");
    expect(resolveWorkerKind(session(), "key:k1")).toBe("shared");
    expect(resolveWorkerKind(session({ workerKind: "mainframe" as never }), "key:k1")).toBe("shared");
  });

  it("stamps the resolved kind on the summary row and on EVERY span's metadata", () => {
    const opts = { meta: META, actorId: "membership-42", tenantTier: "full" } as const;
    const summary = agentSessionSummaryRow(session({ workerKind: "cloud" }), opts);
    expect(summary.WorkerKind).toBe("cloud");
    const rows = agentSessionToClickHouseRows(session({ workerKind: "cloud" }), opts);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect((row.Metadata as Record<string, string>).workerKind).toBe("cloud");
    }
  });

  it("a metrics-tier write still carries the worker kind (metrics-safe field)", () => {
    const opts = { meta: META, actorId: "key:k1", tenantTier: "metrics" } as const;
    expect(agentSessionSummaryRow(session({ workerKind: "ci" }), opts).WorkerKind).toBe("ci");
  });
});

describe("session origin (classify agent runs vs interactive)", () => {
  const OPTS = { meta: META, actorId: "membership-42", tenantTier: "full" } as const;

  it("carries the parser's origin onto the summary row", () => {
    const row = agentSessionSummaryRow(session({ agent: { type: "claude-code", origin: "agent" } }), OPTS);
    expect(row.Origin).toBe("agent");
  });

  it("defaults Origin to '' when the session has no origin (legacy rows stay visible)", () => {
    expect(agentSessionSummaryRow(session(), OPTS).Origin).toBe("");
  });

  it("copies origin onto the root span's metadata when present, and omits it when absent", () => {
    const withOrigin = agentSessionToNormalizedSpans(session({ agent: { type: "claude-code", origin: "agent" } }), {
      actorId: "membership-42",
      tier: "full",
      workerKind: "seat",
    });
    // the root (session) span carries agentOrigin alongside agentEntrypoint
    expect((withOrigin[0]!.metadata as Record<string, string>).agentOrigin).toBe("agent");
    const noOrigin = agentSessionToNormalizedSpans(session(), { actorId: "membership-42", tier: "full", workerKind: "seat" });
    expect((noOrigin[0]!.metadata as Record<string, string>).agentOrigin).toBeUndefined();
  });
});

describe("summary row hook rollup", () => {
  const OPTS = { meta: META, actorId: "membership-42", tenantTier: "full" } as const;

  it("sums only REPORTED durations, counts unreported separately, and takes the scrubbed slowest command", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: {
            hooks: [
              { command: "./scripts/lint.sh", durationMs: 45 },
              { command: "./scripts/slow-hook.sh" }, // no duration reported
            ],
          },
        },
        {
          type: "hook_executed",
          seq: 2,
          data: { hooks: [{ command: "curl /Users/alex/deploy.sh", durationMs: 13500 }] },
        },
      ],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect({
      HookExecutionCount: row.HookExecutionCount,
      HookDurationMs: row.HookDurationMs,
      HookUnreportedCount: row.HookUnreportedCount,
      SlowestHookMs: row.SlowestHookMs,
      SlowestHookCommand: row.SlowestHookCommand,
    }).toEqual({
      HookExecutionCount: 3,
      HookDurationMs: 45 + 13500, // excludes the unreported entry, not summed as 0
      HookUnreportedCount: 1,
      SlowestHookMs: 13500,
      SlowestHookCommand: "curl ~/deploy.sh", // scrubbed, not the raw path
    });
  });

  it("counts a negative or non-finite durationMs as unreported, never as a value in the sum or the max", () => {
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: {
            hooks: [
              { command: "a", durationMs: -100 },
              { command: "b", durationMs: Number.NaN },
              { command: "c", durationMs: 50 },
            ],
          },
        },
      ],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect({
      HookExecutionCount: row.HookExecutionCount,
      HookDurationMs: row.HookDurationMs,
      HookUnreportedCount: row.HookUnreportedCount,
      SlowestHookMs: row.SlowestHookMs,
      SlowestHookCommand: row.SlowestHookCommand,
    }).toEqual({
      HookExecutionCount: 3,
      HookDurationMs: 50,
      HookUnreportedCount: 2,
      SlowestHookMs: 50,
      SlowestHookCommand: "c",
    });
  });

  it("a duration past the UInt32 ceiling counts as unreported, not as a clamped value in SlowestHookMs", () => {
    const s = session({
      events: [{ type: "hook_executed", seq: 1, data: { hooks: [{ command: "huge", durationMs: 9_000_000_000 }] } }],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.SlowestHookMs).toBe(0);
    expect(row.HookUnreportedCount).toBe(1);
    expect(row.HookExecutionCount).toBe(1);
  });

  it("keeps a valid duration right at the UInt32 ceiling as reported", () => {
    const s = session({
      events: [{ type: "hook_executed", seq: 1, data: { hooks: [{ command: "at-cap", durationMs: 4_294_967_295 }] } }],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.SlowestHookMs).toBe(4_294_967_295);
    expect(row.HookUnreportedCount).toBe(0);
  });

  it("a tie for slowest keeps the FIRST hook seen at that duration, not the last", () => {
    // Strict > (not >=): the second 100ms entry must not overwrite the first
    // as "slowest" just because it matched the running max.
    const s = session({
      events: [
        {
          type: "hook_executed",
          seq: 1,
          data: {
            hooks: [
              { command: "first", durationMs: 100 },
              { command: "second", durationMs: 100 },
            ],
          },
        },
      ],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.SlowestHookMs).toBe(100);
    expect(row.SlowestHookCommand).toBe("first");
  });

  it("the slowest hook with no command string yields '', never a garbage value", () => {
    const s = session({
      events: [{ type: "hook_executed", seq: 1, data: { hooks: [{ durationMs: 500 }] } }],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.SlowestHookCommand).toBe("");
  });

  it("the rollup's type guard rejects hook-shaped data on the WRONG event type", () => {
    const s = session({
      events: [{ type: "queue_operation", seq: 1, data: { hooks: [{ command: "a", durationMs: 200 }] } }],
    });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.HookExecutionCount).toBe(0);
  });

  it("a hook_executed event with no data at all contributes nothing to the rollup, without crashing", () => {
    // A throw here fails the test on its own; asserting the return value on
    // top proves it degrades to zero rather than merely surviving.
    const s = session({ events: [{ type: "hook_executed", seq: 1 }] });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.HookExecutionCount).toBe(0);
  });

  it("the rollup caps hook entries per event at 50, same as the span path", () => {
    const manyHooks = Array.from({ length: 60 }, (_, i) => ({ command: `hook-${i}`, durationMs: 1 }));
    const s = session({ events: [{ type: "hook_executed", seq: 1, data: { hooks: manyHooks } }] });
    const row = agentSessionSummaryRow(s, OPTS);
    expect(row.HookExecutionCount).toBe(50);
  });
});

describe("summary row PR outcome (pr-link lines)", () => {
  const OPTS = { meta: META, actorId: "membership-42", tenantTier: "full" } as const;
  const PR_URL = "https://github.com/acme/api/pull/512";

  it("carries the whole outcome on the summary row (exact shape)", () => {
    const row = agentSessionSummaryRow(
      session({
        env: { cwd: "/home/dev/acme", gitRepo: "github.com/acme/api", gitBranch: "feat/x", commitSha: "a".repeat(40) },
        outcome: { prNumber: 512, prUrl: PR_URL, commitShas: ["b".repeat(40)] },
      }),
      OPTS,
    );
    expect(row).toEqual({
      TenantId: "tenant-1",
      AppId: "app-1",
      TraceId: "5c3a1b2d4e6f47089a1b2c3d4e5f6a7b",
      SessionId: "5c3a1b2d-4e6f-4708-9a1b-2c3d4e5f6a7b",
      Title: "Fix the build",
      AgentType: "claude-code",
      ActorId: "membership-42",
      WorkerKind: "seat",
      GitRepo: "github.com/acme/api",
      GitBranch: "feat/x",
      CommitSha: "a".repeat(40),
      ParentSessionId: "",
      Origin: "",
      PrNumber: 512,
      PrUrl: PR_URL,
      // a scalar-only producer surfaces through the array view as one entry
      PrNumbers: [512],
      PrUrls: [PR_URL],
      OutcomeCommitShas: ["b".repeat(40)],
      CaptureTier: "full",
      StartedAt: "2026-07-01 10:00:00.000",
      EndedAt: "2026-07-01 11:00:00.000",
      TurnCount: 2,
      UserTurnCount: 1,
      ToolCallCount: 1,
      ErrorCount: 1,
      RejectedToolCallCount: 0,
      PermissionPromptCount: 0,
      ApiErrorCount: 1,
      HookExecutionCount: 0,
      HookDurationMs: 0,
      HookUnreportedCount: 0,
      SlowestHookMs: 0,
      SlowestHookCommand: "",
      CostUsd: 0.25,
      Models: ["claude-opus-4-8"],
    });
  });

  it("stores zero-defaults when the session has no outcome", () => {
    const row = agentSessionSummaryRow(session(), OPTS);
    expect([row.PrNumber, row.PrUrl, row.PrNumbers, row.PrUrls, row.OutcomeCommitShas]).toEqual([0, "", [], [], []]);
  });

  it("multi-PR session: every link lands in PrNumbers/PrUrls (aligned), union shas derived from per-PR sets", () => {
    const multi = session({
      outcome: {
        prNumber: 13,
        prUrl: "https://github.com/acme/api/pull/13",
        prs: [
          { prNumber: 12, prUrl: PR_URL.replace("512", "12"), commitShas: ["abc1234", "ddd4444"] },
          { prNumber: 13, prUrl: "https://github.com/acme/api/pull/13", commitShas: ["bbb2222", "abc1234"] },
          { prNumber: 14 }, // link with no url and no commits
        ],
      },
    });
    const row = agentSessionSummaryRow(multi, OPTS);
    expect(row.PrNumber).toBe(13);
    expect(row.PrNumbers).toEqual([12, 13, 14]);
    expect(row.PrUrls).toEqual(["https://github.com/acme/api/pull/12", "https://github.com/acme/api/pull/13", ""]);
    // union of the per-PR sets, first-seen order, deduped
    expect(row.OutcomeCommitShas).toEqual(["abc1234", "ddd4444", "bbb2222"]);
  });

  it("an array-only producer (no scalar) derives the scalar from the LAST link", () => {
    const arrayOnly = session({
      outcome: { prs: [{ prNumber: 7, prUrl: "https://github.com/acme/api/pull/7" }, { prNumber: 9 }] },
    });
    const row = agentSessionSummaryRow(arrayOnly, OPTS);
    expect([row.PrNumber, row.PrUrl]).toEqual([9, ""]);
    expect(row.PrNumbers).toEqual([7, 9]);
  });

  it("drops invalid prs entries and caps the list at 50", () => {
    const junkPrs = session({
      outcome: {
        prs: [
          { prNumber: 0 },
          { prNumber: -2, prUrl: "x" },
          { prNumber: 2.5 },
          ...Array.from({ length: 60 }, (_, i) => ({ prNumber: i + 1 })),
        ] as { prNumber: number }[],
      },
    });
    const row = agentSessionSummaryRow(junkPrs, OPTS);
    expect(row.PrNumbers).toHaveLength(50);
    expect(row.PrNumbers[0]).toBe(1);
    expect(row.PrNumbers[49]).toBe(50);
  });

  it("scrubs credentials embedded in per-PR urls", () => {
    const leaky = session({
      outcome: { prs: [{ prNumber: 5, prUrl: `https://x:ghp_${"a".repeat(36)}@github.com/acme/api/pull/5` }] },
    });
    const row = agentSessionSummaryRow(leaky, OPTS);
    expect(row.PrUrls[0]).not.toContain("ghp_");
    expect(row.PrUrls[0]).toContain("[SCRUBBED:github-token]");
  });

  it("counts user turns into UserTurnCount (the human-steering signal), not total turns", () => {
    // 1 user + 1 assistant → 1 user turn (the initial ask; not yet steering).
    expect(agentSessionSummaryRow(session(), OPTS).UserTurnCount).toBe(1);
    // A follow-up user turn = the human stepped back in mid-session.
    const steered = session({
      turns: [
        { index: 0, role: "user", toolCalls: [], text: "Fix the build", ts: "2026-07-01T10:00:01.000Z" },
        { index: 1, role: "assistant", toolCalls: [], text: "on it", ts: "2026-07-01T10:00:02.000Z" },
        { index: 2, role: "user", toolCalls: [], text: "no, use the other API", ts: "2026-07-01T10:05:00.000Z" },
        { index: 3, role: "assistant", toolCalls: [], text: "fixed", ts: "2026-07-01T10:06:00.000Z" },
      ],
    });
    const row = agentSessionSummaryRow(steered, OPTS);
    expect(row.TurnCount).toBe(4);
    expect(row.UserTurnCount).toBe(2);
  });

  it("excludes peer/notification user turns from UserTurnCount and stamps agentTurnSource per span", () => {
    // A multi-agent session: relayed peer mail and a harness notification arrive
    // as user turns but are not human steering — only the two human turns count.
    const multiAgent = session({
      turns: [
        { index: 0, role: "user", source: "human", toolCalls: [], text: "Fix the build", ts: "2026-07-01T10:00:01.000Z" },
        { index: 1, role: "assistant", toolCalls: [], text: "on it", ts: "2026-07-01T10:00:02.000Z" },
        { index: 2, role: "user", source: "peer", toolCalls: [], text: "peer: watch the chunk boundary", ts: "2026-07-01T10:03:00.000Z" },
        { index: 3, role: "user", source: "notification", toolCalls: [], text: "task done", ts: "2026-07-01T10:04:00.000Z" },
        { index: 4, role: "user", source: "human", toolCalls: [], text: "no, use the other API", ts: "2026-07-01T10:05:00.000Z" },
      ],
    });
    const row = agentSessionSummaryRow(multiAgent, OPTS);
    expect(row.TurnCount).toBe(5);
    expect(row.UserTurnCount).toBe(2);

    const spans = agentSessionToNormalizedSpans(multiAgent, { actorId: "membership-42", tier: "full", workerKind: "seat" });
    const userSources = spans
      .filter((s) => s.name === "agent.turn.user")
      .map((s) => s.spanAttributes?.agentTurnSource);
    expect(userSources).toEqual(["human", "peer", "notification", "human"]);
    // Assistant spans never carry the attribute.
    const assistant = spans.find((s) => s.name === "agent.turn.assistant");
    expect(assistant?.spanAttributes?.agentTurnSource).toBeUndefined();
  });

  it("an unclassified user turn (no source) counts as human and reads 'human' on its span", () => {
    // Other adapters and pre-provenance transcripts omit `source`; tightening
    // must not zero their steering — the naive count is preserved.
    const legacy = session({
      turns: [{ index: 0, role: "user", toolCalls: [], text: "Fix the build", ts: "2026-07-01T10:00:01.000Z" }],
    });
    expect(agentSessionSummaryRow(legacy, OPTS).UserTurnCount).toBe(1);
    const spans = agentSessionToNormalizedSpans(legacy, { actorId: "membership-42", tier: "full", workerKind: "seat" });
    const user = spans.find((s) => s.name === "agent.turn.user");
    expect(user?.spanAttributes?.agentTurnSource).toBe("human");
  });

  it("a chunked part's whole-session userTurns count overrides the per-part human count", () => {
    // Chunk counts are computed once over the whole session (by the CLI, through
    // the same predicate) and ride every part; the converter must trust them.
    const chunked = session({
      chunk: { part: 1, of: 2, counts: { turns: 9, toolCalls: 3, errors: 1, userTurns: 4 } },
      turns: [{ index: 0, role: "user", source: "human", toolCalls: [], text: "ask", ts: "2026-07-01T10:00:01.000Z" }],
    });
    expect(agentSessionSummaryRow(chunked, OPTS).UserTurnCount).toBe(4);
  });

  it("counts steering signals: rejected tools apart from errors, permission prompts and api errors from events", () => {
    const gated = session({
      turns: [
        { index: 0, role: "user", toolCalls: [], text: "Fix the build", ts: "2026-07-01T10:00:01.000Z" },
        {
          index: 1,
          role: "assistant",
          text: "trying",
          ts: "2026-07-01T10:00:05.000Z",
          toolCalls: [
            { name: "Bash", status: "rejected", isEdit: false, input: '{"command":"rm -rf dist"}' },
            { name: "Bash", status: "error", isEdit: false, errorSignature: "exit 1", input: '{"command":"yarn build"}' },
            { name: "Read", status: "ok", isEdit: false, input: '{"file_path":"a.ts"}' },
            { name: "Edit", status: "rejected", isEdit: true, input: '{"file_path":"a.ts"}' },
          ],
        },
      ],
      events: [
        { type: "permission_prompt", seq: 0, ts: "2026-07-01T10:00:02.000Z" },
        { type: "permission_prompt", seq: 1, ts: "2026-07-01T10:00:03.000Z" },
        { type: "api_error", seq: 2, ts: "2026-07-01T10:30:00.000Z" },
        { type: "compaction", seq: 3, ts: "2026-07-01T10:40:00.000Z" },
      ],
    });
    const row = agentSessionSummaryRow(gated, OPTS);
    expect(row.RejectedToolCallCount).toBe(2);
    // Rejected is a human veto, not a tool failure — it never inflates ErrorCount.
    expect(row.ErrorCount).toBe(1);
    expect(row.ToolCallCount).toBe(4);
    expect(row.PermissionPromptCount).toBe(2);
    // Only api_error events count; compaction stays out.
    expect(row.ApiErrorCount).toBe(1);
  });

  it("steering signals survive a metrics-tier ceiling (status and event type are metrics-tier)", () => {
    const gated = session({
      turns: [
        {
          index: 0,
          role: "assistant",
          ts: "2026-07-01T10:00:05.000Z",
          toolCalls: [{ name: "Bash", status: "rejected", isEdit: false, input: "{}" }],
        },
      ],
      events: [{ type: "permission_prompt", seq: 0 }],
    });
    const row = agentSessionSummaryRow(gated, { ...OPTS, tenantTier: "metrics" });
    expect(row.RejectedToolCallCount).toBe(1);
    expect(row.PermissionPromptCount).toBe(1);
  });

  it("sanitizes junk: non-integer/non-numeric prNumber, non-string shas, oversized values", () => {
    const junk = session({
      outcome: {
        prNumber: 3.5,
        prUrl: "x".repeat(600),
        commitShas: ["good", 7, null, "y".repeat(70)] as unknown as string[],
      },
    });
    const row = agentSessionSummaryRow(junk, OPTS);
    expect(row.PrNumber).toBe(0);
    expect(row.PrUrl).toBe("x".repeat(500));
    expect(row.OutcomeCommitShas).toEqual(["good", "y".repeat(64)]);
    const stringy = session({ outcome: { prNumber: "512", prUrl: 12 } as unknown as { prNumber: number } });
    expect([agentSessionSummaryRow(stringy, OPTS).PrNumber, agentSessionSummaryRow(stringy, OPTS).PrUrl]).toEqual([0, ""]);
  });

  it("caps the sha list at 100 entries", () => {
    const many = session({ outcome: { prNumber: 1, commitShas: Array.from({ length: 101 }, (_, i) => `sha${i}`) } });
    const row = agentSessionSummaryRow(many, OPTS);
    expect(row.OutcomeCommitShas).toHaveLength(100);
    expect(row.OutcomeCommitShas[99]).toBe("sha99");
  });

  it("scrubs credentials embedded in the PR url", () => {
    const leaky = session({
      outcome: { prNumber: 5, prUrl: `https://x:ghp_${"a".repeat(36)}@github.com/acme/api/pull/5` },
    });
    const row = agentSessionSummaryRow(leaky, OPTS);
    expect(row.PrUrl).not.toContain("ghp_");
    expect(row.PrUrl).toContain("[SCRUBBED:github-token]");
  });

  it("outcome is redacted-tier: a metrics ceiling strips it from summary AND spans", () => {
    const withPr = session({ outcome: { prNumber: 512, prUrl: PR_URL, commitShas: ["c".repeat(40)] } });
    const row = agentSessionSummaryRow(withPr, { ...OPTS, tenantTier: "metrics" });
    expect([row.PrNumber, row.PrUrl, row.OutcomeCommitShas]).toEqual([0, "", []]);
    const rows = agentSessionToClickHouseRows(withPr, { ...OPTS, tenantTier: "metrics" });
    expect(JSON.stringify(rows)).not.toContain("pull/512");
  });

  it("redacted tier keeps the link; the ROOT span's Metadata carries it for trace views", () => {
    const withPr = session({ outcome: { prNumber: 512, prUrl: PR_URL } });
    const row = agentSessionSummaryRow(withPr, { ...OPTS, tenantTier: "redacted" });
    expect([row.PrNumber, row.PrUrl]).toEqual([512, PR_URL]);
    const rows = agentSessionToClickHouseRows(withPr, { ...OPTS, tenantTier: "redacted" });
    const root = rows.find((r) => r.SpanName === "agent.session")!;
    const children = rows.filter((r) => r.SpanName !== "agent.session");
    expect((root.Metadata as Record<string, string>).prNumber).toBe("512");
    expect((root.Metadata as Record<string, string>).prUrl).toBe(PR_URL);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect((child.Metadata as Record<string, string>).prNumber).toBeUndefined();
      expect((child.Metadata as Record<string, string>).prLinks).toBeUndefined();
    }
  });

  it("the ROOT span's prLinks metadata carries the full per-PR set (incl. commit attribution)", () => {
    const multi = session({
      outcome: {
        prs: [
          { prNumber: 12, prUrl: "https://github.com/acme/api/pull/12", commitShas: ["abc1234"] },
          { prNumber: 13 },
        ],
      },
    });
    const rows = agentSessionToClickHouseRows(multi, { ...OPTS, tenantTier: "redacted" });
    const root = rows.find((r) => r.SpanName === "agent.session")!;
    expect(JSON.parse((root.Metadata as Record<string, string>).prLinks!)).toEqual([
      { prNumber: 12, prUrl: "https://github.com/acme/api/pull/12", commitShas: ["abc1234"] },
      { prNumber: 13, prUrl: "", commitShas: [] },
    ]);
  });
});


// ---------------------------------------------------------------------------
// chunked parts (oversized sessions ship as several envelope-complete parts)
// ---------------------------------------------------------------------------

describe("chunked session parts", () => {
  const opts = { meta: META, actorId: "membership-42", tenantTier: "full" } as const;

  it("summary counts come from the chunk's whole-session numbers, not the slice", () => {
    const full = session();
    const part = {
      ...full,
      turns: full.turns.slice(0, 1),
      chunk: {
        part: 2,
        of: 4,
        counts: { turns: 1800, toolCalls: 421, errors: 7, rejectedToolCalls: 12, permissionPrompts: 30, apiErrors: 3 },
      },
    } as never;
    const row = agentSessionSummaryRow(part, opts);
    expect(row.TurnCount).toBe(1800);
    expect(row.ToolCallCount).toBe(421);
    expect(row.ErrorCount).toBe(7);
    expect(row.RejectedToolCallCount).toBe(12);
    expect(row.PermissionPromptCount).toBe(30);
    expect(row.ApiErrorCount).toBe(3);
    // Identity is unchanged — every part replaces into the same row.
    expect(row.TraceId).toBe(agentSessionSummaryRow(full, opts).TraceId);
  });

  it("falls back to counting the part's slice when an older producer omits the steering counts", () => {
    const full = session();
    const part = {
      ...full,
      chunk: { part: 1, of: 2, counts: { turns: 1800, toolCalls: 421, errors: 7 } },
    } as never;
    const row = agentSessionSummaryRow(part, opts);
    // The fixture's own slice: no rejected tools, no permission prompts, one api_error event.
    expect(row.RejectedToolCallCount).toBe(0);
    expect(row.PermissionPromptCount).toBe(0);
    expect(row.ApiErrorCount).toBe(1);
  });
});
