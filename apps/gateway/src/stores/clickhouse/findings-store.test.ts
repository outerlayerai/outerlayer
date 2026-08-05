import { describe, expect, test, vi } from "vitest";
import {
  buildActiveScopesSql,
  buildSpanScanSql,
  toDetectionSession,
} from "./findings-store";

const base = {
  TraceId: "t1",
  SpanId: "s0",
  SpanName: "agent.session",
  Ts: "2026-07-01 10:00:00.000000000",
  StatusCode: "1",
  StatusMessage: "",
  Model: "",
  Cost: 0,
  InputTokens: 0,
  OutputTokens: 0,
  cacheRead: "",
  cacheCreation: "",
  turnIndex: "",
  toolName: "",
  toolStatus: "",
  isEdit: "",
  file: "",
  gitRepo: "",
  cwd: "",
  parentSessionId: "",
  SessionId: "",
  ActorId: "",
  eventNames: [] as string[],
  eventTimestamps: [] as string[],
};

describe("buildSpanScanSql", () => {
  test("reads cache tokens from the semconv keys the converter writes today", () => {
    const sql = buildSpanScanSql();
    expect(sql).toContain("SpanAttributes['gen_ai.usage.cache_read.input_tokens']");
    expect(sql).toContain("SpanAttributes['gen_ai.usage.cache_creation.input_tokens']");
    // The legacy key read cache tokens as 0 and silently disabled the
    // cache-thrash cause — pin it out.
    expect(sql).not.toContain("agent.cache_read_tokens");
  });

  test("is parameterized, windowed, and dedupes span re-ingests", () => {
    const sql = buildSpanScanSql();
    expect(sql).toContain("TenantId = {tenantId:String}");
    expect(sql).toContain("AppId = {appId:String}");
    expect(sql).toContain("Timestamp >= now() - INTERVAL {lookbackDays:UInt32} DAY");
    expect(sql).toContain("LIMIT 1 BY TraceId, SpanId");
    expect(sql).toContain("ORDER BY UpdatedAt DESC");
    expect(sql).toContain("LIMIT {maxRows:UInt32}");
  });
});

describe("buildActiveScopesSql", () => {
  test("scopes come from the summary rollup inside the window", () => {
    const sql = buildActiveScopesSql();
    expect(sql).toContain("FROM agent_session_summary FINAL");
    expect(sql).toContain("StartedAt >= now() - INTERVAL {lookbackDays:UInt32} DAY");
    expect(sql).toContain("GROUP BY TenantId, AppId");
  });
});

describe("toDetectionSession", () => {
  test("folds root + turns + tools into a DetectionSession with summed tokens and cost", () => {
    const session = toDetectionSession("t1", [
      { ...base, SessionId: "sess-1", ActorId: "a1", gitRepo: "github.com/acme/app", Cost: 0.5 },
      {
        ...base,
        SpanId: "s1",
        SpanName: "agent.turn.user",
        Ts: "2026-07-01 10:00:01.000000000",
        turnIndex: "0",
        InputTokens: 10,
        OutputTokens: 0,
      },
      {
        ...base,
        SpanId: "s2",
        SpanName: "agent.turn.assistant",
        Ts: "2026-07-01 10:00:02.000000000",
        turnIndex: "1",
        Model: "claude-opus-4-8",
        Cost: 1.5,
        InputTokens: 100,
        OutputTokens: 40,
        cacheRead: "2048",
        cacheCreation: "1024",
      },
      {
        ...base,
        SpanId: "s3",
        SpanName: "agent.tool.Edit",
        turnIndex: "1",
        toolName: "Edit",
        toolStatus: "error",
        isEdit: "1",
        file: "src/a.ts",
        StatusMessage: "old_string not found",
      },
    ]);

    expect(session).toEqual({
      id: "sess-1",
      actorId: "a1",
      project: "github.com/acme/app",
      startedAt: "2026-07-01T10:00:00.000Z",
      models: ["claude-opus-4-8"],
      costUsd: 2,
      tokens: { input: 110, output: 40, cacheRead: 2048, cacheCreation: 1024 },
      isSubagent: 0,
      turns: [
        { index: 0, role: "user", ts: "2026-07-01T10:00:01.000Z", toolCalls: [] },
        {
          index: 1,
          role: "assistant",
          ts: "2026-07-01T10:00:02.000Z",
          toolCalls: [
            {
              name: "Edit",
              status: "error",
              isEdit: true,
              file: "src/a.ts",
              errorSignature: "old_string not found",
            },
          ],
        },
      ],
      events: [],
    });
  });

  test("orphan traces without an agent.session root are not sessions", () => {
    expect(
      toDetectionSession("t1", [
        { ...base, SpanName: "agent.turn.user", turnIndex: "0" },
      ]),
    ).toBeNull();
  });

  test("a tool span without its turn span synthesizes the holder turn", () => {
    const session = toDetectionSession("t1", [
      { ...base },
      {
        ...base,
        SpanId: "s9",
        SpanName: "agent.tool.Bash",
        turnIndex: "4",
        StatusCode: "2",
      },
    ]);
    expect(session!.turns).toEqual([
      {
        index: 4,
        role: "assistant",
        ts: null,
        toolCalls: [
          // Name falls back to the span suffix; status falls back to StatusCode.
          { name: "Bash", status: "error", isEdit: false, file: null, errorSignature: null },
        ],
      },
    ]);
  });

  test("subagent flag and events ride the root span", () => {
    const session = toDetectionSession("t1", [
      {
        ...base,
        parentSessionId: "parent-1",
        eventNames: ["compaction", "api_error"],
        eventTimestamps: ["2026-07-01 10:05:00.000000000", ""],
      },
    ]);
    expect(session!.isSubagent).toBe(1);
    expect(session!.events).toEqual([
      { type: "compaction", ts: "2026-07-01T10:05:00.000Z" },
      { type: "api_error", ts: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Factory paths — the real client wrapper, exercised against a mocked
// @clickhouse/client-web module.
// ---------------------------------------------------------------------------

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@clickhouse/client-web", () => ({
  createClient: vi.fn(() => ({ query: mockQuery })),
}));

// Imported after the mock so the factory picks it up.
const { createFindingsStore, MAX_SPAN_ROWS } = await import("./findings-store");

const respond = (rows: unknown[]) =>
  mockQuery.mockResolvedValueOnce({ json: async () => rows });

describe("createFindingsStore", () => {
  test("listActiveScopes maps rows and binds the window param", async () => {
    respond([{ tenantId: "t1", appId: "a1" }]);
    const store = createFindingsStore({ url: "http://ch", password: "pw" });
    const scopes = await store.listActiveScopes(14);
    expect(scopes).toEqual([{ tenantId: "t1", appId: "a1" }]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { lookbackDays: 14 },
        format: "JSONEachRow",
      }),
    );
  });

  test("loadDetectionSessions folds contiguous trace groups and drops orphans", async () => {
    respond([
      { ...base, TraceId: "trace-a", SessionId: "sess-a" },
      { ...base, TraceId: "trace-a", SpanId: "s1", SpanName: "agent.turn.user", turnIndex: "0" },
      // orphan trace: no agent.session root → not a session
      { ...base, TraceId: "trace-orphan", SpanName: "agent.turn.user", turnIndex: "0" },
      { ...base, TraceId: "trace-b", SessionId: "sess-b" },
    ]);
    const store = createFindingsStore({ url: "http://ch", password: "pw" });
    const sessions = await store.loadDetectionSessions({ tenantId: "t1", appId: "a1" }, 7);
    expect(sessions.map((s) => s.id)).toEqual(["sess-a", "sess-b"]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { tenantId: "t1", appId: "a1", lookbackDays: 7, maxRows: MAX_SPAN_ROWS },
      }),
    );
  });

  test("hitting the row cap fires onRowCapHit with the scope — never a silent truncation", async () => {
    const rows = Array.from({ length: MAX_SPAN_ROWS }, (_, i) => ({
      ...base,
      TraceId: `t-${i}`,
    }));
    respond(rows);
    const onRowCapHit = vi.fn();
    const store = createFindingsStore({ url: "http://ch", password: "pw", onRowCapHit });
    await store.loadDetectionSessions({ tenantId: "t1", appId: "a1" }, 14);
    expect(onRowCapHit).toHaveBeenCalledWith({ tenantId: "t1", appId: "a1" }, MAX_SPAN_ROWS);
  });

  test("loadActivatedSkills maps rows with numeric counts over its own window", async () => {
    respond([
      { skill: "review", recentActivations: "5", totalActivations: "40", totalSessions: "12" },
      { skill: "deploy", recentActivations: "0", totalActivations: "3", totalSessions: "3" },
    ]);
    const store = createFindingsStore({ url: "http://ch", password: "pw" });
    const skills = await store.loadActivatedSkills({ tenantId: "t1", appId: "a1" }, 90);
    expect(skills).toEqual([
      { skillName: "review", totalActivations: 40, totalSessions: 12 },
      { skillName: "deploy", totalActivations: 3, totalSessions: 3 },
    ]);
    // Its own longer window, bound as params (never interpolated).
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: expect.objectContaining({
          tenantId: "t1",
          appId: "a1",
          lookbackDays: 90,
          recentDays: 90,
        }),
      }),
    );
  });
});
