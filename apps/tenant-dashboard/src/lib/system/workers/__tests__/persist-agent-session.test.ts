/**
 * AC-2: a completed cloud-worker run persists as an Agent Session through the
 * SAME gateway-core pipeline as /v1/agents/sync. Supabase rides MSW (run row,
 * events, git_connection, membership, tenant tier); ClickHouse is the mocked
 * client-factory seam (the agents-routes convention) so the assertions pin the
 * exact rows written: deterministic TraceId, workerKind=cloud, dispatcher
 * attribution, tier clamping, and the host-qualified repo join key.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@repo/db-types";
import {
  seedWorkerRunMswState,
  seedMembershipMswState,
  seedManagedDeploymentTablesState,
} from "@/test-helpers/msw-handlers";
import {
  persistWorkerRunAgentSession,
  persistWorkerRunTranscript,
  repoJoinKey,
  CLOUD_WORKER_ACTOR,
} from "../persist-agent-session";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn() },
}));

const mockInsert = vi.fn(async () => undefined);
/** Dedupe lookup result: rows already persisted for the run's TraceId. */
let persistedCount = 0;
const mockChQuery = vi.fn(async (_args: { query: string; query_params: Record<string, unknown> }) => ({
  json: async () => [{ n: String(persistedCount) }],
}));
vi.mock("@/lib/analytics/client", () => ({
  createClickHouseClient: () => ({ insert: mockInsert, query: mockChQuery }),
}));

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";
const supabase = () => createClient<Database>(SUPABASE_URL, ANON);

const RUN_ID = "11111111-2222-4333-8444-555555555555";
/** Same recipe as gateway-core traceIdForSession for a non-UUID session id. */
const EXPECTED_TRACE_ID = createHash("sha256").update(`worker-run:${RUN_ID}`).digest("hex").slice(0, 32);

const CALLBACK = {
  worker_run_id: RUN_ID,
  app_id: "app-1",
  status: "succeeded" as const,
  outcome: "changes" as const,
  changes: [{ path: "a.ts", operation: "write" as const, content: "x", encoding: "utf8" as const }],
  raw_log: "",
  duration_ms: 60_000,
  cost_usd: 0.42,
  num_turns: 2,
  session_ref: "claude-1",
};

function seedRun(over: Record<string, unknown> = {}, tier: string = "full") {
  seedWorkerRunMswState({
    rows: [
      {
        id: RUN_ID,
        tenant_id: "tenant-1",
        app_id: "app-1",
        agent: "claude-code",
        task_prompt: "Fix the login flake",
        base_branch: "main",
        status: "completed",
        dispatch: "fly",
        wall_clock_cap_s: 1800,
        started_at: "2026-07-14T10:00:00.000Z",
        created_at: "2026-07-14T09:59:00.000Z",
        created_by: "user-1",
        ...over,
      },
    ],
    events: [
      {
        id: "e1",
        worker_run_id: RUN_ID,
        tenant_id: "tenant-1",
        app_id: "app-1",
        seq: 0,
        event_type: "status",
        payload: { phase: "agent-launched", model: "claude-opus-4-8" },
        created_at: "2026-07-14T10:00:01.000Z",
      },
      {
        id: "e2",
        worker_run_id: RUN_ID,
        tenant_id: "tenant-1",
        app_id: "app-1",
        seq: 1,
        event_type: "agent-message",
        payload: { text: "Fixed it. Also set STRIPE_KEY=sk_test_abcdefghij1234567890 locally." },
        created_at: "2026-07-14T10:00:05.000Z",
      },
    ],
  });
  seedManagedDeploymentTablesState({
    gitConnections: [{ app_id: "app-1", provider: "github", installation_id: 1, repository: "acme/api" }],
  });
  seedMembershipMswState({
    memberships: [{ id: "membership-7", user_id: "user-1", tenant_id: "tenant-1" } as never],
    // Explicit ceiling per test — 'full' is the product default (2026-07-15).
    tenants: [{ tenant_id: "tenant-1", agent_capture_tier: tier } as never],
  });
}

const insertedTable = (table: string) =>
  mockInsert.mock.calls.map((c) => (c as unknown[])[0] as { table: string; values: Record<string, unknown>[] }).find((c) => c.table === table);

beforeEach(() => {
  mockInsert.mockClear();
  mockChQuery.mockClear();
  persistedCount = 0;
});

describe("persistWorkerRunAgentSession (AC-2)", () => {
  it("writes the summary row: deterministic TraceId, workerKind=cloud, dispatcher membership, host-qualified repo key", async () => {
    seedRun();
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z"));

    const summary = insertedTable("agent_session_summary");
    expect(summary?.values).toHaveLength(1);
    const row = summary!.values[0]!;
    expect(row).toEqual(
      expect.objectContaining({
        TenantId: "tenant-1",
        AppId: "app-1",
        TraceId: EXPECTED_TRACE_ID,
        SessionId: `worker-run:${RUN_ID}`,
        AgentType: "claude-code",
        ActorId: "membership-7",
        WorkerKind: "cloud",
        Origin: "worker",
        GitRepo: "github.com/acme/api",
        GitBranch: "main",
        TurnCount: 2,
        CostUsd: 0.42,
        Models: ["claude-opus-4-8"],
        CaptureTier: "full",
      }),
    );
  });

  it("re-running the same callback writes the same TraceId — idempotent under the replacing tables", async () => {
    seedRun();
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z"));
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:05:00.000Z"));
    const traceIds = mockInsert.mock.calls
      .map((c) => (c as unknown[])[0] as { table: string; values: Record<string, unknown>[] })
      .filter((c) => c.table === "agent_session_summary")
      .map((c) => c.values[0]!.TraceId);
    expect(traceIds).toEqual([EXPECTED_TRACE_ID, EXPECTED_TRACE_ID]);
  });

  it("clamps to a redacted tenant ceiling: span rows carry no message text, and secrets never land anywhere", async () => {
    seedRun({}, "redacted");
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z"));

    const spans = insertedTable("otel_traces");
    // root + user turn + assistant turn at minimum
    expect(spans!.values.length).toBeGreaterThanOrEqual(3);
    const serialized = JSON.stringify(spans!.values);
    // redacted tier: the assistant prose (and the secret inside it) is gone
    expect(serialized).not.toContain("sk_test_abcdefghij1234567890");
    expect(serialized).not.toContain("Fixed it.");
    // structure survives: the session root + turn spans exist with the repo key
    const names = spans!.values.map((r) => r.SpanName);
    expect(names).toContain("agent.session");
    expect(names).toContain("agent.turn.assistant");
    expect(spans!.values.every((r) => r.WorkerKind === undefined)).toBe(true); // spans carry it in Metadata, not a column
    const root = spans!.values.find((r) => r.SpanName === "agent.session")!;
    expect((root.Metadata as Record<string, string>).workerKind).toBe("cloud");
  });

  it("attributes to key:cloud-worker (fail closed, never a guessed human) when the dispatcher has no membership", async () => {
    seedRun({ created_by: null });
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z"));
    expect(insertedTable("agent_session_summary")!.values[0]!.ActorId).toBe(CLOUD_WORKER_ACTOR);
  });

  it("swallows persistence failures — a session is telemetry, never a callback failure", async () => {
    seedRun();
    mockInsert.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z")),
    ).resolves.toBeUndefined();
  });

  it("no-ops when the run row is missing", async () => {
    seedWorkerRunMswState({ rows: [], events: [] });
    await persistWorkerRunAgentSession(supabase(), CALLBACK);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("skips the event bridge when a session for the run already landed (transcript won the race)", async () => {
    seedRun();
    persistedCount = 1;
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z"));
    expect(mockInsert).not.toHaveBeenCalled();
    // The dedupe lookup is pinned to the run's exact identity — a mutant that
    // drops a predicate or mis-derives the TraceId would dedupe across runs
    // (lost sessions) or never dedupe (bridge clobbers the transcript).
    expect(mockChQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { tenantId: "tenant-1", appId: "app-1", traceId: EXPECTED_TRACE_ID },
        query: expect.stringContaining("TenantId = {tenantId:String}"),
      }),
    );
    expect(mockChQuery).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("AppId = {appId:String}") }),
    );
    expect(mockChQuery).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("TraceId = {traceId:String}") }),
    );
  });

  it("anchors the bridge session to the run row's timestamps exactly", async () => {
    seedRun();
    await persistWorkerRunAgentSession(supabase(), CALLBACK, new Date("2026-07-14T10:01:00.000Z"));
    const row = insertedTable("agent_session_summary")!.values[0]!;
    expect(row.StartedAt).toBe("2026-07-14 10:00:00.000");
    expect(row.EndedAt).toBe("2026-07-14 10:01:00.000");
  });
});

describe("persistWorkerRunTranscript (AC-9 cloud fidelity)", () => {
  /** Real claude-code stream-json lines — parsed by the ACTUAL
   * @outerlayer/capture adapter, not a mock (this test breaks if the parser
   * and the persist stamping drift apart). */
  const transcript = [
    {
      sessionId: "claude-real-1",
      type: "user",
      version: "2.1.193",
      cwd: "/work",
      gitBranch: "other-branch",
      timestamp: "2026-07-14T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Fix the login flake" }] },
    },
    {
      sessionId: "claude-real-1",
      type: "assistant",
      version: "2.1.193",
      cwd: "/work",
      gitBranch: "other-branch",
      timestamp: "2026-07-14T10:00:30.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Racy wait — fixing." }],
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 5 },
      },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");

  it("parses the raw transcript with the capture adapter and persists under the run's canonical identity", async () => {
    seedRun();
    const ok = await persistWorkerRunTranscript(supabase(), RUN_ID, transcript, new Date("2026-07-14T10:01:00.000Z"));
    expect(ok).toBe(true);

    const summary = insertedTable("agent_session_summary");
    const row = summary!.values[0]!;
    expect(row).toEqual(
      expect.objectContaining({
        // canonical run identity, NOT the transcript's own session id
        TraceId: EXPECTED_TRACE_ID,
        SessionId: `worker-run:${RUN_ID}`,
        WorkerKind: "cloud",
        ActorId: "membership-7",
        // the app's join keys override what the transcript claims
        GitRepo: "github.com/acme/api",
        GitBranch: "main",
        Models: ["claude-opus-4-8"],
        TurnCount: 2,
      }),
    );

    // Full fidelity the event bridge can't provide: real per-turn token usage
    // on the assistant GENERATION span (redacted tier strips text, never counts).
    const spans = insertedTable("otel_traces")!.values;
    const generation = spans.find((s) => s.SpanName === "agent.turn.assistant")!;
    expect(Number(generation.TotalTokens)).toBe(535); // 10 + 20 + 500 + 5
  });

  it("stamps Origin=worker even when the launched transcript looks like a headless SDK run", async () => {
    seedRun();
    // A real worker launches the agent headless, so its transcript carries
    // sdk markers (entrypoint sdk-cli, promptSource sdk) that would otherwise
    // classify as an agent run. The run's own origin must win regardless.
    const sdkShaped = [
      {
        sessionId: "claude-real-1",
        type: "user",
        version: "2.1.211",
        entrypoint: "sdk-cli",
        promptSource: "sdk",
        timestamp: "2026-07-14T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix it" }] },
      },
      {
        sessionId: "claude-real-1",
        type: "assistant",
        version: "2.1.211",
        entrypoint: "sdk-cli",
        timestamp: "2026-07-14T10:00:30.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");

    const ok = await persistWorkerRunTranscript(supabase(), RUN_ID, sdkShaped, new Date("2026-07-14T10:01:00.000Z"));
    expect(ok).toBe(true);
    expect(insertedTable("agent_session_summary")!.values[0]!.Origin).toBe("worker");
  });

  it("returns false for a launcher with no parser (event bridge covers it)", async () => {
    seedRun({ agent: "opencode" });
    const ok = await persistWorkerRunTranscript(supabase(), RUN_ID, transcript);
    expect(ok).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("anchors timestamp-less transcripts (stream-json tees) to the run row instead of stranding them in 1970", async () => {
    seedRun();
    const timestampless = [
      {
        sessionId: "claude-real-1",
        type: "user",
        version: "2.1.193",
        message: { role: "user", content: [{ type: "text", text: "Fix it" }] },
      },
      {
        sessionId: "claude-real-1",
        type: "assistant",
        version: "2.1.193",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");

    const ok = await persistWorkerRunTranscript(supabase(), RUN_ID, timestampless, new Date("2026-07-14T10:05:00.000Z"));
    expect(ok).toBe(true);
    const row = insertedTable("agent_session_summary")!.values[0]!;
    // started_at from the run row; ended anchored to the upload time
    expect(row.StartedAt).toBe("2026-07-14 10:00:00.000");
    expect(row.EndedAt).toBe("2026-07-14 10:05:00.000");
  });

  it("keeps sane transcript timestamps instead of overwriting them with the run row's", async () => {
    seedRun();
    await persistWorkerRunTranscript(supabase(), RUN_ID, transcript, new Date("2026-07-14T11:00:00.000Z"));
    const row = insertedTable("agent_session_summary")!.values[0]!;
    // both bounds come from the transcript lines, NOT the run/upload times
    expect(row.StartedAt).toBe("2026-07-14 10:00:00.000");
    expect(row.EndedAt).toBe("2026-07-14 10:00:30.000");
  });

  it("ships image blobs to agent_blobs at full tier, and never below it", async () => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const sha256 = createHash("sha256").update(pixel).digest("hex");
    const withImage = [
      {
        sessionId: "claude-real-1",
        type: "user",
        version: "2.1.193",
        timestamp: "2026-07-14T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "what is this screenshot" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: pixel.toString("base64") } },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");

    // Redacted ceiling: images are stripped by the gate — no blob write.
    seedRun({}, "redacted");
    await persistWorkerRunTranscript(supabase(), RUN_ID, withImage, new Date("2026-07-14T10:01:00.000Z"));
    expect(insertedTable("agent_blobs")).toBe(undefined);

    // Full-tier tenant: the blob lands content-addressed.
    mockInsert.mockClear();
    seedRun();
    seedMembershipMswState({
      memberships: [{ id: "membership-7", user_id: "user-1", tenant_id: "tenant-1" } as never],
      tenants: [{ tenant_id: "tenant-1", agent_capture_tier: "full" } as never],
    });
    await persistWorkerRunTranscript(supabase(), RUN_ID, withImage, new Date("2026-07-14T10:01:00.000Z"));
    const blobs = insertedTable("agent_blobs");
    expect(blobs?.values).toEqual([
      expect.objectContaining({
        TenantId: "tenant-1",
        AppId: "app-1",
        Sha256: sha256,
        MediaType: "image/png",
        Bytes: pixel.byteLength,
      }),
    ]);
  });
});

describe("repoJoinKey", () => {
  it.each([
    ["acme/api", "github", "github.com/acme/api"],
    ["https://github.com/acme/api.git", "github", "github.com/acme/api"],
    ["git@github.com:acme/api.git", "github", "github.com/acme/api"],
  ])("%s (%s) → %s", (repository, provider, expected) => {
    expect(repoJoinKey(repository, provider)).toBe(expected);
  });
});
