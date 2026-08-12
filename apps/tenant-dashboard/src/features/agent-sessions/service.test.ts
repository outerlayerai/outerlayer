/**
 * AgentSessionsService — `getSessionDetail` and `listSessions`, exercised
 * through the real query path each read runs (ClickHouse for the span
 * tree / list rollup, PostgREST-via-MSW for PR-outcomes) rather than a
 * hand-faked query chain. The React Server Component (RSC) pages call
 * this service directly; there is no route layer to test separately.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createMswRestClient } from "@/test-helpers/rest-client";
import { seedSupabaseMswState, seedPullRequestSessionMswState } from "@/test-helpers/msw-handlers";

const { mockScope } = vi.hoisted(() => ({
  mockScope: { value: { kind: "team" } as { kind: "team" } | { kind: "self"; actorId: string | null } },
}));
vi.mock("./scope", async (importOriginal) => {
  const original = await importOriginal<typeof import("./scope")>();
  return {
    ...original,
    resolveAgentSessionScope: vi.fn(async () => mockScope.value),
  };
});

const mockJson = vi.fn(async (): Promise<Record<string, unknown>[]> => [FAT_ROW]);
// The rollup read carries the literal `LIMIT 1`; tests that exercise the
// no-rollup fallbacks set this instead of the shared FAT_ROW. `null` = the
// rollup read shares mockJson's return, same as every other query.
let summaryRowsOverride: Record<string, unknown>[] | null = null;
// The trace-range lookup (`otel_traces_trace_id_ts`) returning no rows is the
// "lookup knows nothing" case the bounded-scan fallback test exercises.
let rangeLookupEmpty = false;
// query() must be a Promise: the service uses both `await ch.query()` AND
// `ch.query().then(r => r.json())` — a plain object breaks the latter. One
// stable implementation, branching on the two flags above (reset every
// test in `beforeEach`) — never `.mockImplementation()` per test, which
// would leak into whichever test runs next.
const mockQuery = vi.fn(
  (args?: { query?: string; query_params?: Record<string, unknown> }): Promise<{
    json: () => Promise<Record<string, unknown>[]>;
  }> => {
    const q = args?.query ?? "";
    if (rangeLookupEmpty && q.includes("otel_traces_trace_id_ts")) {
      return Promise.resolve({ json: async () => [] });
    }
    if (summaryRowsOverride !== null && q.includes("LIMIT 1")) {
      const rows = summaryRowsOverride;
      return Promise.resolve({ json: async () => rows });
    }
    return Promise.resolve({ json: mockJson });
  },
);
let mockClient: { query: typeof mockQuery } | null = { query: mockQuery };

vi.mock("@/lib/analytics/client", () => ({
  createTenantReadClient: () => mockClient,
  getDefaultClient: () => mockClient,
}));

// `?pr=` reads `pull_request_session`, whose only SELECT policy requires
// `git_connection.read` — a member without it reads zero rows with no error,
// which the service must not report as "this PR has no sessions". The check
// is mocked here so both sides of that gate are reachable.
const { mockLinkPermission } = vi.hoisted(() => ({
  mockLinkPermission: { error: undefined as string | undefined },
}));
vi.mock("@/utils/permission-check", () => ({
  checkAppPermission: vi.fn(async () => mockLinkPermission),
}));

import { agentSessionsService, type AgentSessionsContext } from "./service";
import { verifyAgentBlobToken } from "./blob-url";
import type { ListSessionsQuery } from "./list-query";

/** Matches the OAUTH_STATE_SECRET the shared unit-test env mock supplies. */
const TEST_SECRET = "test-oauth-state-secret-at-least-32-chars";

const FAT_ROW = {
  traceId: "1b247b75d348bd50c62f3aab2724050e",
  sessionId: "s1",
  spanId: "span1",
  parentSpanId: "",
  name: "agent.session",
  startTime: "2026-01-01 00:00:00",
  durationMs: "100",
  statusCode: "1",
  statusMessage: "",
  model: "anthropic/claude-opus-4-8",
  cost: 9.9,
  inputTokens: "10",
  outputTokens: "20",
  input: "hi",
  output: "yo",
  reasoning: "",
  captureTier: "full",
  agentType: "claude-code",
  actorId: "devon",
  metadata: {
    images: '[{"sha256":"abc","mediaType":"image/png"}]',
    title: "A session",
    gitRepo: "github.com/agentmark-ai/app",
  },
  workerKind: "cloud",
  costUsd: 9.9,
  userTurnCount: "3",
  rejectedToolCallCount: "1",
  permissionPromptCount: "4",
  apiErrorCount: "2",
  hookExecutionCount: "12",
  hookDurationMs: "4200",
  hookUnreportedCount: "3",
  slowestHookMs: "13500",
  slowestHookCommand: "./scripts/slow-hook.sh",
};

function ctx(overrides: { appId?: string } = {}): AgentSessionsContext {
  return {
    userId: "user-1",
    tenantId: "tenant-1",
    appId: overrides.appId ?? "app-1",
    dataRetentionDays: -1,
    db: createMswRestClient() as unknown as SupabaseClient,
  } as unknown as AgentSessionsContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = { query: mockQuery };
  mockJson.mockResolvedValue([FAT_ROW]);
  summaryRowsOverride = null;
  rangeLookupEmpty = false;
  mockScope.value = { kind: "team" };
  seedSupabaseMswState({ tableErrors: {} });
});

describe("AgentSessionsService.getSessionDetail", () => {
  it("returns the span tree and parses image refs onto the spans", async () => {
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.title).toBe("A session");
    expect(data?.spans).toHaveLength(1);
    expect(data?.spans[0]?.images).toEqual([
      { sha256: "abc", mediaType: "image/png", token: expect.any(String) },
    ]);
  });

  it("binds each image token to the caller, the tenant/app, and that one hash", async () => {
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    const token = data?.spans[0]?.images?.[0]?.token ?? "";

    const verified = await verifyAgentBlobToken({ secret: TEST_SECRET, token });
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims).toEqual({
      tenantId: "tenant-1",
      appId: "app-1",
      userId: "user-1",
      sha256: "abc",
      exp: expect.any(Number),
    });
  });

  it("unwraps gen_ai messages-array I/O to the words; passes other shapes through", async () => {
    mockJson.mockResolvedValue([
      { ...FAT_ROW, input: '[{"role":"user","content":"Fix the build"}]', output: "yo" },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.input).toBe("Fix the build");
    expect(data?.spans[0]?.output).toBe("yo");
  });

  it("leaves non-message JSON arrays (e.g. raw tool payloads) intact", async () => {
    mockJson.mockResolvedValue([{ ...FAT_ROW, input: "[1,2,3]", output: '[{"not":"a message"}]' }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.input).toBe("[1,2,3]");
    expect(data?.spans[0]?.output).toBe('[{"not":"a message"}]');
  });

  it("falls back to span data when no rollup row exists: summed turn cost, traceId identity, metadata origin, root duration", async () => {
    summaryRowsOverride = [];
    mockJson.mockResolvedValue([
      { ...FAT_ROW, name: "agent.session", durationMs: "500", cost: 0, metadata: { ...FAT_ROW.metadata, workerKind: "seat" } },
      { ...FAT_ROW, spanId: "t1", name: "agent.turn.assistant", durationMs: "10", cost: 1.25 },
      { ...FAT_ROW, spanId: "t2", name: "agent.turn.user", durationMs: "10", cost: 2 },
      { ...FAT_ROW, spanId: "t3", name: "agent.turn.assistant", durationMs: "10", cost: undefined as unknown as number },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    // cost = SUM over agent.turn.* spans, costless rows contributing 0
    expect(data?.session.costUsd).toBe(3.25);
    expect(data?.session.sessionId).toBe(FAT_ROW.traceId);
    expect(data?.session.workerKind).toBe("seat");
    expect(data?.session.durationMs).toBe(500);
  });

  it("durationMs is null when neither the rollup nor the root span carry one (zero is unknown, not instant)", async () => {
    summaryRowsOverride = [{ sessionId: "s1", workerKind: "cloud", costUsd: 5, durationMs: "0" }];
    mockJson.mockResolvedValue([{ ...FAT_ROW, durationMs: "0" }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.durationMs).toBe(null);
    expect(data?.session.costUsd).toBe(5);
    expect(data?.session.sessionId).toBe("s1");
  });

  it("anchors on the first span when no agent.session root exists (legacy/partial traces)", async () => {
    mockJson.mockResolvedValue([
      { ...FAT_ROW, spanId: "only", name: "agent.turn.assistant", startTime: "2026-02-02 02:02:02", actorId: "devon" },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data).not.toBeNull();
    expect(data?.session.startedAt).toBe("2026-02-02T02:02:02.000Z");
  });

  it("falls back to the span sum when the rollup row exists but carries no cost", async () => {
    // The ingest stores 0 for a session nothing could price. When the spans
    // DO carry cost (a later re-sync priced them), they are the better
    // evidence — preferring the rollup unconditionally would report "unknown"
    // for a session we can actually price.
    summaryRowsOverride = [{ sessionId: "s1", workerKind: "cloud", costUsd: 0, durationMs: "100" }];
    mockJson.mockResolvedValue([
      { ...FAT_ROW, name: "agent.session", cost: 0 },
      { ...FAT_ROW, spanId: "t1", name: "agent.turn.assistant", cost: 0.75 },
      { ...FAT_ROW, spanId: "t2", name: "agent.turn.assistant", cost: 0.25 },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.costUsd).toBe(1);
  });

  it("reports cost as unknown, not zero, when neither the rollup nor the spans priced the session", async () => {
    // A transcript carries token counts but never a cost, so an unpriced model
    // yields no cost at all. Reporting 0 would read as "this run was free" and
    // deflate every cost rollup built on these rows.
    summaryRowsOverride = [{ sessionId: "s1", workerKind: "cloud", costUsd: 0, durationMs: "100" }];
    mockJson.mockResolvedValue([
      { ...FAT_ROW, name: "agent.session", cost: 0 },
      { ...FAT_ROW, spanId: "t1", name: "agent.turn.assistant", cost: 0 },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.costUsd).toBeNull();
  });

  it("treats a non-finite stored cost as unknown rather than letting NaN reach the UI", async () => {
    summaryRowsOverride = [{ sessionId: "s1", workerKind: "cloud", costUsd: "not-a-number", durationMs: "100" }];
    mockJson.mockResolvedValue([{ ...FAT_ROW, name: "agent.session", cost: 0 }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.costUsd).toBeNull();
  });

  it("identity/cost/duration come from the rollup row so list and detail agree", async () => {
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.sessionId).toBe("s1");
    expect(data?.session.costUsd).toBe(9.9);
    expect(data?.session.durationMs).toBe(100);
    expect(data?.session.workerKind).toBe("cloud");
  });

  it("trajectory signals ride the session from the rollup row — the same numbers the list sorts/filters on", async () => {
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.userTurnCount).toBe(3);
    expect(data?.session.rejectedToolCallCount).toBe(1);
    expect(data?.session.permissionPromptCount).toBe(4);
    expect(data?.session.apiErrorCount).toBe(2);
    expect(data?.session.editRetryLoop).toBe(null);
  });

  it("hook rollup rides the session from the rollup row — count, summed duration, unreported count, slowest", async () => {
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.hookExecutionCount).toBe(12);
    expect(data?.session.hookDurationMs).toBe(4200);
    expect(data?.session.hookUnreportedCount).toBe(3);
    expect(data?.session.slowestHookMs).toBe(13_500);
    expect(data?.session.slowestHookCommand).toBe("./scripts/slow-hook.sh");
  });

  it("with no rollup row, hook fields honestly read 0/'' rather than falling back to the span tree", async () => {
    summaryRowsOverride = [];
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.hookExecutionCount).toBe(0);
    expect(data?.session.hookDurationMs).toBe(0);
    expect(data?.session.hookUnreportedCount).toBe(0);
    expect(data?.session.slowestHookMs).toBe(0);
    expect(data?.session.slowestHookCommand).toBe("");
  });

  it("with no rollup row, user turns and denials fall back to the span tree; event counters honestly read 0", async () => {
    summaryRowsOverride = [];
    mockJson.mockResolvedValue([
      { ...FAT_ROW, name: "agent.session" },
      { ...FAT_ROW, spanId: "u1", name: "agent.turn.user" },
      { ...FAT_ROW, spanId: "u2", name: "agent.turn.user" },
      { ...FAT_ROW, spanId: "a1", name: "agent.turn.assistant" },
      { ...FAT_ROW, spanId: "r1", name: "agent.tool.Edit", metadata: { toolStatus: "rejected" } as unknown as typeof FAT_ROW.metadata },
      { ...FAT_ROW, spanId: "r2", name: "agent.tool.Bash", metadata: { toolStatus: "ok" } as unknown as typeof FAT_ROW.metadata },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.userTurnCount).toBe(2);
    expect(data?.session.rejectedToolCallCount).toBe(1);
    expect(data?.session.permissionPromptCount).toBe(0);
    expect(data?.session.apiErrorCount).toBe(0);
  });

  it("detects an edit-retry loop from the span sequence: ≥3 consecutive failed edits to one file", async () => {
    const failedEdit = (spanId: string) => ({
      ...FAT_ROW,
      spanId,
      name: "agent.tool.Edit",
      statusCode: "2",
      metadata: { isEdit: "1", file: "src/broken.ts", toolStatus: "error" } as unknown as typeof FAT_ROW.metadata,
    });
    mockJson.mockResolvedValue([{ ...FAT_ROW, name: "agent.session" }, failedEdit("e1"), failedEdit("e2"), failedEdit("e3")]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.editRetryLoop).toEqual({ file: "src/broken.ts", fails: 3 });
  });

  it("caps tool I/O at the ClickHouse boundary so a mega-session response stays small", async () => {
    await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    const spansCall = (mockQuery.mock.calls as unknown as [{ query: string }][])
      .map((c) => c[0])
      .find((c) => c.query.includes("SpanId AS spanId"))!;
    expect(spansCall.query).toContain("if(SpanName LIKE 'agent.tool.%', substringUTF8(Output, 1, 4096), Output)");
    expect(spansCall.query).toContain("substringUTF8(SpanAttributes['outerlayer.reasoning'], 1, 1024)");
  });

  it("caps an oversized turn output in the response body (JS cap after unwrap)", async () => {
    mockJson.mockResolvedValue([{ ...FAT_ROW, name: "agent.turn.assistant", output: "x".repeat(9000) }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.output).toHaveLength(4096);
  });

  it("capText boundary: exactly IO_CAP chars passes through untouched, IO_CAP+1 truncates to exactly IO_CAP", async () => {
    mockJson.mockResolvedValue([
      { ...FAT_ROW, name: "agent.turn.assistant", output: "a".repeat(4096) },
    ]);
    const atCap = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(atCap?.spans[0]?.output).toBe("a".repeat(4096));

    mockJson.mockResolvedValue([
      { ...FAT_ROW, name: "agent.turn.assistant", output: "b".repeat(4097) },
    ]);
    const overCap = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(overCap?.spans[0]?.output).toBe("b".repeat(4096));
  });

  it("unwrapMessages: an empty string passes through as empty, never reaching JSON.parse", async () => {
    mockJson.mockResolvedValue([{ ...FAT_ROW, input: "", output: "yo" }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.input).toBeNull();
  });

  it("unwrapMessages: an empty JSON array is left as the literal '[]', not unwrapped to empty text", async () => {
    mockJson.mockResolvedValue([{ ...FAT_ROW, input: "[]", output: "yo" }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.input).toBe("[]");
  });

  it("unwrapMessages: an array with one entry missing 'content' is left as raw JSON (every entry must match, not some)", async () => {
    const raw = '[{"role":"user","content":"hi"},{"role":"assistant"}]';
    mockJson.mockResolvedValue([{ ...FAT_ROW, input: raw, output: "yo" }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.input).toBe(raw);
  });

  it("parseImages: drops an entry whose sha256 is not a string, keeps a valid one alongside it", async () => {
    mockJson.mockResolvedValue([
      {
        ...FAT_ROW,
        metadata: { images: JSON.stringify([{ sha256: 42, mediaType: "image/png" }, { sha256: "ok", mediaType: "image/jpeg" }]) },
      },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.images).toEqual([
      { sha256: "ok", mediaType: "image/jpeg", token: expect.any(String) },
    ]);
  });

  it("parseImages: a missing/non-string mediaType defaults to image/png", async () => {
    mockJson.mockResolvedValue([
      { ...FAT_ROW, metadata: { images: JSON.stringify([{ sha256: "abc" }]) } },
    ]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.images).toEqual([
      { sha256: "abc", mediaType: "image/png", token: expect.any(String) },
    ]);
  });

  it("parseImages: no images key on metadata yields an empty array, not a throw", async () => {
    mockJson.mockResolvedValue([{ ...FAT_ROW, metadata: {} }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.images).toEqual([]);
  });

  it("parseImages: an unparseable images string yields an empty array, not a throw", async () => {
    mockJson.mockResolvedValue([{ ...FAT_ROW, metadata: { images: "not-json" } }]);
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.spans[0]?.images).toEqual([]);
  });

  it("narrows the FINAL span query with the trace time range from the lookup table", async () => {
    mockJson.mockImplementation(async () => [
      { ...FAT_ROW, start: "2026-07-01 10:00:00.000000000", end: "2026-07-01 11:00:00.000000000" },
    ]);
    await agentSessionsService.getSessionDetail(ctx(), "abc123");
    const calls = (mockQuery.mock.calls as unknown as [{ query: string; query_params: Record<string, unknown> }][]).map((c) => c[0]);
    const rangeCall = calls.find((c) => c.query.includes("otel_traces_trace_id_ts"));
    const spanCall = calls.find((c) => c.query.includes("SpanName LIKE 'agent.%'") && c.query.includes("FROM otel_traces FINAL"));
    expect(rangeCall!.query).toContain("TenantId = {tenantId:String}");
    expect(rangeCall!.query_params.traceId).toBe("abc123");
    expect(spanCall!.query).toContain("Timestamp >= {tsRangeStart:DateTime64(9)}");
    expect(spanCall!.query).toContain("Timestamp <= {tsRangeEnd:DateTime64(9)}");
    expect(spanCall!.query_params.tsRangeStart).toBe("2026-07-01 10:00:00.000000000");
    expect(spanCall!.query_params.tsRangeEnd).toBe("2026-07-01 11:00:00.000000000");
  });

  it("filters the span read by identity in PREWHERE and keeps SpanName in WHERE", async () => {
    mockJson.mockImplementation(async () => [
      { ...FAT_ROW, start: "2026-07-01 10:00:00.000000000", end: "2026-07-01 11:00:00.000000000" },
    ]);
    await agentSessionsService.getSessionDetail(ctx(), "abc123");
    const spanCall = (mockQuery.mock.calls as unknown as [{ query: string }][])
      .map((c) => c[0])
      .find((c) => c.query.includes("FROM otel_traces FINAL"));
    // Strip SQL comments — they discuss PREWHERE/WHERE and would foul the match.
    const sql = spanCall!.query
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const clauses = sql.match(/PREWHERE\s+([\s\S]+?)\s+WHERE\s+([\s\S]+?)\s+ORDER BY/);
    expect(clauses).not.toBeNull();
    const [, prewhere = "", where = ""] = clauses!;
    // Every identity predicate — including the trace time bound — must sit in
    // PREWHERE (sort-key columns only: version-stable, safe under FINAL), so
    // the fat payload columns are decompressed for this trace's rows only.
    expect(prewhere).toContain("TenantId = {tenantId:String}");
    expect(prewhere).toContain("AppId = {appId:String}");
    expect(prewhere).toContain("TraceId = {traceId:String}");
    expect(prewhere).toContain("Timestamp >= {tsRangeStart:DateTime64(9)}");
    expect(prewhere).toContain("Timestamp <= {tsRangeEnd:DateTime64(9)}");
    // SpanName is NOT in the sort key — pre-merge filtering on it under FINAL
    // is the documented-incorrect case, so it must stay in WHERE.
    expect(prewhere).not.toContain("SpanName");
    expect(where.trim()).toBe("SpanName LIKE 'agent.%'");
  });

  it("falls back to the unbounded query when the lookup knows nothing — never throws", async () => {
    rangeLookupEmpty = true;
    const data = await agentSessionsService.getSessionDetail(ctx(), "abc123");
    expect(data).not.toBeNull();
    const spanCall = (mockQuery.mock.calls as unknown as [{ query: string }][])
      .map((c) => c[0])
      .find((c) => c.query.includes("FROM otel_traces FINAL"));
    expect(spanCall!.query).not.toContain("tsRangeStart");
  });

  it("another developer's transcript resolves to null under self scope — indistinguishable from nonexistent", async () => {
    mockScope.value = { kind: "self", actorId: "me-membership" }; // FAT_ROW.actorId is 'devon'
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data).toBeNull();
  });

  it("the caller's own transcript stays readable under self scope", async () => {
    mockScope.value = { kind: "self", actorId: "devon" };
    const data = await agentSessionsService.getSessionDetail(ctx(), FAT_ROW.traceId);
    expect(data?.session.actorId).toBe("devon");
  });

  it("returns null when the trace has no rows at all", async () => {
    mockJson.mockResolvedValue([]);
    const data = await agentSessionsService.getSessionDetail(ctx(), "nonexistent");
    expect(data).toBeNull();
  });
});

describe("AgentSessionsService.listSessions", () => {
  const LIST_ROW = {
    repo: "github.com/agentmark-ai/app",
    traceId: "1b247b75d348bd50c62f3aab2724050e",
    sessionId: "s1",
    title: "A session",
    agentType: "claude-code",
    actorId: "devon",
    actor: "devon",
    workerKind: "cloud",
    project: "github.com/agentmark-ai/app",
    branch: "feature",
    model: "anthropic/claude-opus-4-8",
    startedAt: "2026-01-01 00:00:00",
    durationMs: "100",
    turnCount: "5",
    toolCallCount: "10",
    errorCount: "1",
    costUsd: 9.9,
    models: ["anthropic/claude-opus-4-8"],
    userTurnCount: "3",
    rejectedToolCallCount: "1",
    origin: "interactive",
    total: "5",
    interactive: "9",
    agent: "4",
    worker: "2",
  };

  function listQuery(overrides: Partial<ListSessionsQuery> = {}): ListSessionsQuery {
    return { limit: 25, offset: 0, sort: "startedAt", dir: "desc", ...overrides };
  }

  /** Every CH call this method made, as (sql, params) pairs. */
  const chCalls = () =>
    (mockQuery.mock.calls as unknown as [{ query: string; query_params: Record<string, unknown> }][]).map((c) => c[0]);

  beforeEach(() => {
    mockJson.mockResolvedValue([LIST_ROW]);
  });

  it("reports an unpriced row's cost as unknown and a priced row's as its number", async () => {
    // Same rule the detail read applies, so the two surfaces agree: a stored
    // 0 means nothing priced the session, not that it was free.
    mockJson.mockResolvedValue([
      { ...LIST_ROW, traceId: "priced", costUsd: 2.5 },
      { ...LIST_ROW, traceId: "unpriced", costUsd: 0 },
      { ...LIST_ROW, traceId: "garbage", costUsd: "not-a-number" },
    ]);
    const data = await agentSessionsService.listSessions(ctx(), listQuery());
    expect(data.sessions.map((s) => s.costUsd)).toEqual([2.5, null, null]);
  });

  it("returns a paginated, repo-scoped page from the summary rollup", async () => {
    const data = await agentSessionsService.listSessions(ctx(), listQuery());
    expect(data.total).toBe(5);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]?.traceId).toBe(LIST_ROW.traceId);
    // steering signals ride the row as numbers, not CH strings
    expect(data.sessions[0]?.userTurnCount).toBe(3);
    expect(data.sessions[0]?.rejectedToolCallCount).toBe(1);
    expect(data.scope).toBe("team");
  });

  it("passes the stored Origin through onto each row", async () => {
    mockJson.mockResolvedValue([{ ...LIST_ROW, origin: "agent" }, { ...LIST_ROW, sessionId: "legacy", origin: "" }]);
    const data = await agentSessionsService.listSessions(ctx(), listQuery());
    expect(data.sessions.map((s) => s.origin)).toEqual(["agent", ""]);
  });

  it("lists every origin by default — no Origin clause on the list or count query", async () => {
    await agentSessionsService.listSessions(ctx(), listQuery());
    const calls = chCalls();
    const listCall = calls.find((c) => c.query.includes("TraceId AS traceId"))!;
    const countCall = calls.find((c) => c.query.includes("count() AS total"))!;
    expect(listCall.query).not.toContain("Origin IN (");
    expect(countCall.query).not.toContain("Origin");
  });

  it("originCounts: one rollup query buckets legacy rows as interactive and ignores the origin filter, but keeps every other filter", async () => {
    const data = await agentSessionsService.listSessions(ctx(), listQuery({ origin: "agent", q: "review" }));
    expect(data.originCounts).toEqual({ interactive: 9, agent: 4, worker: 2 });
    const calls = chCalls();
    const countsCall = calls.find((c) => c.query.includes("countIf"))!;
    expect(countsCall.query).toContain("countIf(Origin IN ('', 'interactive')) AS interactive");
    expect(countsCall.query).not.toContain("WHERE Origin");
    // The list itself still applies the origin filter.
    const listCall = calls.find((c) => c.query.includes("TraceId AS traceId"))!;
    expect(listCall.query).toContain("Origin IN ('agent')");
  });

  it("topic drill-down runs ONLY the list + count — no dominant-repo, origin rollup, or vocabulary scans", async () => {
    const data = await agentSessionsService.listSessions(ctx(), listQuery({ topicId: "v1-c0", topicFacet: "task" }));
    expect("originCounts" in data).toBe(false);
    const calls = chCalls();
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.query.includes("TraceId AS traceId"))).toHaveLength(1);
    expect(calls.filter((c) => c.query.includes("count() AS total"))).toHaveLength(1);
  });

  it("issues drill-down expands to ROOT sessions: a subagent match pulls in its parent", async () => {
    await agentSessionsService.listSessions(ctx(), listQuery({ topicId: "v1-c9", topicFacet: "issues" }));
    const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
    expect(listCall.query).toContain("OR SessionId IN (");
    expect(listCall.query).toContain("ParentSessionId != ''");
    expect(listCall.query_params.topicId).toBe("v1-c9");
    // Issues stays origin-blind — no agent-origin guard.
    expect(listCall.query).not.toContain("Origin != 'agent'");
  });

  it("threads search/actor/range filters as bound params — never into the SQL string", async () => {
    const needle = "'; DROP TABLE otel_traces; --";
    await agentSessionsService.listSessions(
      ctx(),
      listQuery({ q: needle, actor: "member-1", from: "2026-07-01T00:00:00.000Z" }),
    );
    const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
    expect(listCall.query).toContain("positionCaseInsensitive(Title, {q:String}) > 0");
    expect(listCall.query).toContain("ActorId={actor:String}");
    expect(listCall.query).toContain("StartedAt >= parseDateTimeBestEffort({from:String})");
    expect(listCall.query).not.toContain(needle);
    expect(listCall.query_params.q).toBe(needle);
    expect(listCall.query_params.actor).toBe("member-1");
  });

  it("resolves membership ActorIds to developer display names (actorNames map)", async () => {
    const { seedMembershipMswState } = await import("@/test-helpers/msw-handlers");
    seedMembershipMswState({ memberships: [{ id: "devon", user_id: "u1", tenant_id: "tenant-1" } as never] });
    seedSupabaseMswState({ profiles: [{ id: "u1", name: "Devon Reyes", email: "devon@example.com" } as never] } as never);
    const data = await agentSessionsService.listSessions(ctx(), listQuery());
    expect(data.actorNames).toEqual({ devon: "Devon Reyes" });
  });

  it("sorts via the column whitelist", async () => {
    await agentSessionsService.listSessions(ctx(), listQuery({ sort: "cost", dir: "asc" }));
    const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
    expect(listCall.query).toContain("ORDER BY CostUsd ASC");
  });

  it("sort=toolErrorRate orders by the errors÷tool-calls expression with the zero-guard", async () => {
    await agentSessionsService.listSessions(ctx(), listQuery({ sort: "toolErrorRate" }));
    const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
    expect(listCall.query).toContain("ORDER BY if(ToolCallCount > 0, ErrorCount / ToolCallCount, 0) DESC");
  });

  it("signal filter selects its closed predicate into list, count, AND the origin rollup", async () => {
    await agentSessionsService.listSessions(ctx(), listQuery({ signal: "hands-on" }));
    const calls = chCalls();
    const listCall = calls.find((c) => c.query.includes("TraceId AS traceId"))!;
    const countCall = calls.find((c) => c.query.includes("count() AS total"))!;
    const badgesCall = calls.find((c) => c.query.includes("countIf(Origin"))!;
    for (const q of [listCall.query, countCall.query, badgesCall.query]) {
      expect(q).toContain("(UserTurnCount > 1)");
    }
  });

  it("omits every optional filter clause when its param is absent (no phantom bound-param references)", async () => {
    await agentSessionsService.listSessions(ctx(), listQuery());
    const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
    expect([
      listCall.query.includes("GitBranch={branch:String}"),
      listCall.query.includes("AgentType={agentType:String}"),
      listCall.query.includes("has(Models, {model:String})"),
      listCall.query.includes("WorkerKind={workerKind:String}"),
      listCall.query.includes("positionCaseInsensitive"),
      listCall.query.includes("parseDateTimeBestEffort"),
    ]).toEqual([false, false, false, false, false, false]);
  });

  describe("actor privacy", () => {
    it("pins ?actor= to the caller under self scope and scopes the vocabularies", async () => {
      mockScope.value = { kind: "self", actorId: "me-membership" };
      const data = await agentSessionsService.listSessions(ctx(), listQuery({ actor: "devon" }));
      expect(data.scope).toBe("self");
      // EVERY query this method makes — dominant-repo + list + count + origin
      // rollup + 5 vocabularies — is pinned to the CALLER's id, both in the
      // SQL and in the bound params. A mutant dropping the pin from either
      // side (or forcing it) changes these counts.
      const calls = chCalls();
      expect(calls).toHaveLength(9);
      expect(calls.filter((c) => c.query.includes("ActorId={actor:String}"))).toHaveLength(9);
      expect(calls.filter((c) => c.query_params.actor === "me-membership")).toHaveLength(9);
      for (const call of calls) {
        expect(JSON.stringify(call.query_params)).not.toContain("devon");
      }
    });

    it("with no membership row pins to the impossible sentinel (fail closed)", async () => {
      mockScope.value = { kind: "self", actorId: null };
      await agentSessionsService.listSessions(ctx(), listQuery());
      const calls = chCalls();
      expect(calls).toHaveLength(9);
      expect(calls.filter((c) => c.query_params.actor === "__no_actor__")).toHaveLength(9);
    });

    it("team scope passes ?actor= through to the page, but the vocabularies stay team-wide", async () => {
      const data = await agentSessionsService.listSessions(ctx(), listQuery({ actor: "devon" }));
      expect(data.scope).toBe("team");
      const calls = chCalls();
      expect(calls).toHaveLength(9);
      const withActor = calls.filter((c) => "actor" in c.query_params);
      expect(withActor).toHaveLength(3); // dominant-repo + list + count
      for (const call of withActor) expect(call.query_params.actor).toBe("devon");
      const vocabCalls = calls.filter((c) => c.query.includes("LIMIT 25"));
      expect(vocabCalls).toHaveLength(5);
      for (const call of vocabCalls) {
        expect(call.query).not.toContain("ActorId={actor:String}");
      }
    });
  });

  describe("pr filter", () => {
      beforeEach(() => {
        mockLinkPermission.error = undefined;
      });

      // AC-057-09: several sessions link one PR; following the comment's
      // dashboard link (`…/sessions?pr=<n>`) lands on the list filtered to
      // that PR, restricted to CONFIRMED links on the caller's own app —
      // this is what makes the header link land instead of silently
      // ignoring the param.
      it("filters the list to sessions CONFIRMED-linked to the given PR, scoped to this app", async () => {
        seedPullRequestSessionMswState({
          links: [
            {
              id: "l1",
              tenant_id: "tenant-1",
              app_id: "app-1",
              pr_number: 812,
              trace_id: "trace-confirmed",
              session_id: "s-confirmed",
              method: "pr_link",
              verification: "confirmed",
              git_branch: "feature",
              first_linked_at: "2026-01-01T00:00:00.000Z",
              last_reconciled_at: "2026-01-01T00:00:00.000Z",
            },
            // pending — must NOT widen the filter.
            {
              id: "l2",
              tenant_id: "tenant-1",
              app_id: "app-1",
              pr_number: 812,
              trace_id: "trace-pending",
              session_id: "s-pending",
              method: "branch",
              verification: "pending",
              git_branch: "feature",
              first_linked_at: "2026-01-01T00:00:00.000Z",
              last_reconciled_at: "2026-01-01T00:00:00.000Z",
            },
            // confirmed, but a different app — must NOT leak across apps.
            {
              id: "l3",
              tenant_id: "tenant-1",
              app_id: "other-app",
              pr_number: 812,
              trace_id: "trace-other-app",
              session_id: "s-other-app",
              method: "pr_link",
              verification: "confirmed",
              git_branch: "feature",
              first_linked_at: "2026-01-01T00:00:00.000Z",
              last_reconciled_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });

        await agentSessionsService.listSessions(ctx({ appId: "app-1" }), listQuery({ pr: 812 }));
        const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
        expect(listCall.query).toContain("TraceId IN {traceIdsConstraint:Array(String)}");
        expect(listCall.query_params.traceIdsConstraint).toEqual(["trace-confirmed"]);
      });

      it("resolves to zero rows (never every row) when the pr filter is active but nothing is confirmed-linked", async () => {
        await agentSessionsService.listSessions(ctx({ appId: "app-1" }), listQuery({ pr: 999 }));
        const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
        expect(listCall.query).toContain("1=0");
        expect(listCall.query_params.traceIdsConstraint).toBeUndefined();
      });

      // The comment's footer link carries only `?pr=`, so a dominant-repo pin
      // would still apply — and a PR on any non-dominant repo of the app then
      // intersects to zero rows, i.e. an empty list reached from a link that
      // just said "N sessions".
      it("drops the dominant-repo pin while the pr filter is active", async () => {
        await agentSessionsService.listSessions(ctx({ appId: "app-1" }), listQuery({ pr: 812 }));
        const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
        expect(listCall.query).not.toContain("GitRepo={repo:String}");
      });

      // Permission-empty and genuinely-empty are different answers, and the
      // reader following the comment's link deserves the true one.
      it("says so when the caller cannot read PR links, instead of rendering an empty list", async () => {
        mockLinkPermission.error = "forbidden";

        await expect(
          agentSessionsService.listSessions(ctx({ appId: "app-1" }), listQuery({ pr: 812 })),
        ).rejects.toThrow(/permission/i);
      });

      it("omits the pr clause entirely when no pr param is given", async () => {
        await agentSessionsService.listSessions(ctx({ appId: "app-1" }), listQuery());
        const listCall = chCalls().find((c) => c.query.includes("TraceId AS traceId"))!;
        expect(listCall.query).not.toContain("TraceId IN {traceIdsConstraint:Array(String)}");
        expect(listCall.query).not.toContain("1=0");
      });
    });
});
