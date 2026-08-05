import { describe, expect, test, vi } from "vitest";
import {
  BATCHED_EXTRACTOR_VERSION,
  GeminiRestClient,
  MockTopicsModelClient,
  MOCK_EMBEDDING_MODEL_VERSION,
  NO_MATCH_TOPIC_ID,
  STEERING_EXTRACTOR_VERSION,
} from "@repo/trace-topics";
import {
  RetryableEnrichmentError,
  TopicsEnrichmentService,
  createTopicsModelClients,
  resolveTopicsConfig,
  type TopicsModelClients,
} from "./topics-enrichment-service";
import type {
  EnrichmentSpanRow,
  TopicsStore,
  TraceFacetRow,
  TraceScope,
} from "../stores/clickhouse/topics-store";

const SCOPE: TraceScope = {
  tenantId: "tenant-1",
  appId: "app-1",
  environment: "production",
  traceId: "trace-1",
};

const REFUND_SPANS: EnrichmentSpanRow[] = [
  {
    SpanId: "s1",
    ParentSpanId: "",
    SpanName: "support-agent",
    Type: "SPAN",
    Timestamp: "2026-07-01 10:00:00.000000000",
    Input: "I want a refund for my delayed shipment order 4521",
    Output: "Refund initiated for the delayed shipment",
    },
  {
    SpanId: "s2",
    ParentSpanId: "s1",
    SpanName: "refund-tool",
    Type: "GENERATION",
    Timestamp: "2026-07-01 10:00:01.000000000",
    Input: "process refund shipment 4521",
    Output: "refund queued",
  },
];

function makeStore(overrides: Partial<TopicsStore> = {}): TopicsStore & {
  insertFacetRows: ReturnType<typeof vi.fn>;
} {
  return {
    findUnenrichedTraces: vi.fn().mockResolvedValue([SCOPE]),
    fetchTraceSpans: vi.fn().mockResolvedValue(REFUND_SPANS),
    fetchActiveCentroids: vi.fn().mockResolvedValue([]),
    insertFacetRows: vi.fn().mockResolvedValue(undefined),
    hasTaskFacetRow: vi.fn().mockResolvedValue(false),
    hasFacetRowsAtVersion: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as TopicsStore & { insertFacetRows: ReturnType<typeof vi.fn> };
}

function makeService(store: TopicsStore, clients: TopicsModelClients = mockClients()) {
  return new TopicsEnrichmentService(store, clients, resolveTopicsConfig({
    TOPICS_ENRICHMENT_ENABLED: "true",
  }));
}

function mockClients() {
  const mock = new MockTopicsModelClient();
  return { structured: mock, embedding: mock };
}

describe("resolveTopicsConfig", () => {
  test("defaults: disabled, empty allowlist, debounce 5, batch 25, 1024-D", () => {
    expect(resolveTopicsConfig({})).toEqual({
      enabled: false,
      tenantAllowlist: [],
      debounceMinutes: 5,
      lookbackHours: 24,
      batchLimit: 25,
      facetModel: "gemini-2.5-flash-lite",
      embeddingModel: "gemini-embedding-001",
      embeddingDimension: 1024,
      assignMaxDistance: 0.5,
    });
  });

  test("parses allowlist (trimmed, empties dropped) and numeric overrides", () => {
    const config = resolveTopicsConfig({
      TOPICS_ENRICHMENT_ENABLED: "true",
      TOPICS_TENANT_ALLOWLIST: " t1, t2 ,,",
      TOPICS_DEBOUNCE_MINUTES: "10",
      TOPICS_BATCH_LIMIT: "50",
      TOPICS_LOOKBACK_HOURS: "2160",
    });
    expect(config.enabled).toBe(true);
    expect(config.tenantAllowlist).toEqual(["t1", "t2"]);
    expect(config.debounceMinutes).toBe(10);
    expect(config.batchLimit).toBe(50);
    // Widen the ingest window so a historical backfill is eligible.
    expect(config.lookbackHours).toBe(2160);
  });

  test("garbage numerics fall back to defaults", () => {
    const config = resolveTopicsConfig({
      TOPICS_DEBOUNCE_MINUTES: "soon",
      TOPICS_BATCH_LIMIT: "-3",
      TOPICS_LOOKBACK_HOURS: "nope",
    });
    expect(config.debounceMinutes).toBe(5);
    expect(config.batchLimit).toBe(25);
    expect(config.lookbackHours).toBe(24);
  });
});

describe("createTopicsModelClients", () => {
  test("no key and no mock opt-in → throws (refuse silent mock)", () => {
    expect(() => createTopicsModelClients({})).toThrow(
      /needs GEMINI_API_KEY/,
    );
  });

  test("TOPICS_MOCK_MODEL=true → deterministic mock (explicit opt-in)", () => {
    const { structured, embedding, mode } = createTopicsModelClients({
      TOPICS_MOCK_MODEL: "true",
    });
    expect(mode).toBe("mock");
    expect(structured).toBeInstanceOf(MockTopicsModelClient);
    expect(embedding).toBe(structured);
  });

  test("key present → real Gemini client", () => {
    const { structured, mode } = createTopicsModelClients({
      GEMINI_API_KEY: "sk-live",
    });
    expect(mode).toBe("gemini");
    expect(structured).toBeInstanceOf(GeminiRestClient);
  });

  test("TOPICS_MOCK_MODEL=true forces mock even with a key", () => {
    const { structured, mode } = createTopicsModelClients({
      GEMINI_API_KEY: "sk-live",
      TOPICS_MOCK_MODEL: "true",
    });
    expect(mode).toBe("mock");
    expect(structured).toBeInstanceOf(MockTopicsModelClient);
  });
});

describe("TopicsEnrichmentService.run", () => {
  test("stops picking new chunks once the live tick budget is spent — leftovers re-enter the next scan", async () => {
    // Six candidates, budget exhausted after the first 3-concurrent chunk.
    // The pass must stop so the steering sweep (sequenced after it in the
    // same invocation) still gets its share of the tick.
    const six = Array.from({ length: 6 }, (_, i) => ({ ...SCOPE, traceId: `t-${i}` }));
    const store = makeStore({ findUnenrichedTraces: vi.fn().mockResolvedValue(six) });
    const nowMs = vi
      .fn()
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // first chunk check → proceed
      .mockReturnValue(21_000); // second chunk check → budget spent
    const result = await makeService(store).run(nowMs);
    // scanned reports traces actually ATTEMPTED, so the tick log never
    // claims coverage the budget cut off.
    expect(result).toEqual({ scanned: 3, enriched: 3, failed: 0 });
    expect(store.fetchTraceSpans).toHaveBeenCalledTimes(3);
  });

  test("no candidates → zero result and no span fetches", async () => {
    const store = makeStore({
      findUnenrichedTraces: vi.fn().mockResolvedValue([]),
    });
    const result = await makeService(store).run();
    expect(result).toEqual({ scanned: 0, enriched: 0, failed: 0 });
    expect(store.fetchTraceSpans).not.toHaveBeenCalled();
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("passes the resolved scan parameters to the store", async () => {
    const store = makeStore({
      findUnenrichedTraces: vi.fn().mockResolvedValue([]),
    });
    await makeService(store).run();
    expect(store.findUnenrichedTraces).toHaveBeenCalledWith({
      debounceMinutes: 5,
      lookbackHours: 24,
      limit: 25,
      tenantAllowlist: [],
    });
  });

  test("happy path writes exactly one row per facet with mock summaries, unit embeddings, and no topic (no map yet)", async () => {
    const store = makeStore();
    const result = await makeService(store).run();

    expect(result).toEqual({ scanned: 1, enriched: 1, failed: 0 });
    expect(store.insertFacetRows).toHaveBeenCalledTimes(1);

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => r.Facet)).toEqual(["task", "sentiment", "issues"]);
    expect(rows.every((r) => r.TraceId === "trace-1" && r.TenantId === "tenant-1")).toBe(true);

    const task = rows[0]!;
    expect(task.Status).toBe("ok");
    // Mock template over the refund spans — pins Stage 1 → Stage 2 wiring.
    expect(task.Summary).toContain("refund");
    expect(task.Embedding).toHaveLength(1024);
    const norm = Math.hypot(...task.Embedding);
    expect(norm).toBeCloseTo(1, 6);
    expect(task.EmbeddingModel).toBe(MOCK_EMBEDDING_MODEL_VERSION);
    expect(task.TopicId).toBe("");
    expect(task.MapVersion).toBe(0);

    const sentiment = rows[1]!;
    expect(sentiment.Status).toBe("ok");
    expect(sentiment.Label).toBe("NEUTRAL");
    expect(sentiment.Embedding).toEqual([]);

    const issues = rows[2]!;
    // A clean trace's issues extraction is the NONE sentinel → a marker row
    // (labeled, no prose, no vector). Embedded no-op prose was 42% of a real
    // corpus's issues facet and clustered into its top "topic".
    expect(issues.Status).toBe("ok");
    expect(issues.Label).toBe("NONE");
    expect(issues.Summary).toBe("");
    expect(issues.Embedding).toEqual([]);
  });

  test("a harness-only session (/clear envelopes, no typed text) terminates as NONE markers with ZERO model calls", async () => {
    const clearSpans: EnrichmentSpanRow[] = [
      {
        SpanId: "s1",
        ParentSpanId: "",
        SpanName: "agent.session",
        Type: "SPAN",
        Timestamp: "2026-07-01 10:00:00.000000000",
        Input: "",
        Output: "",
      },
      {
        SpanId: "s2",
        ParentSpanId: "s1",
        SpanName: "agent.turn.user",
        Type: "SPAN",
        Timestamp: "2026-07-01 10:00:01.000000000",
        Input:
          "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
        Output: "",
      },
      {
        SpanId: "s3",
        ParentSpanId: "s1",
        SpanName: "agent.turn.user",
        Type: "SPAN",
        Timestamp: "2026-07-01 10:00:02.000000000",
        Input: "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
        Output: "",
      },
    ];
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue(clearSpans) });
    const structured = { generateObject: vi.fn() };
    const embedding = { embed: vi.fn() };
    const result = await makeService(store, {
      structured: structured as unknown as TopicsModelClients["structured"],
      embedding: embedding as unknown as TopicsModelClients["embedding"],
    }).run();

    expect(result).toEqual({ scanned: 1, enriched: 1, failed: 0 });
    // Summarizing a harness-only transcript is how "/clear the session"
    // became a live map's fourth-biggest task topic: the gate must decide
    // BEFORE any model sees it.
    expect(structured.generateObject).not.toHaveBeenCalled();
    expect(embedding.embed).not.toHaveBeenCalled();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => [r.Facet, r.Label, r.Summary, r.Status])).toEqual([
      ["task", "NONE", "", "ok"],
      ["sentiment", "NONE", "", "ok"],
      ["issues", "NONE", "", "ok"],
    ]);
    expect(rows.every((r) => r.ExtractorVersion === BATCHED_EXTRACTOR_VERSION)).toBe(true);
    expect(rows.every((r) => r.Embedding.length === 0)).toBe(true);
  });

  test("classifies against active centroids: matching topic assigned with map version; orthogonal map yields no_match", async () => {
    // A failing span keeps the issues facet embedded (a clean trace's issues
    // extraction is a NONE marker with nothing to classify).
    const failingSpans = [
      ...REFUND_SPANS,
      {
        SpanId: "s3",
        ParentSpanId: "s1",
        SpanName: "refund-tool",
        Type: "GENERATION",
        Timestamp: "2026-07-01 10:00:02.000000000",
        Input: "retry refund",
        Output: "the retry failed with a gateway error",
      },
    ];
    // First run with no map to capture the task embedding the mock produces.
    const captureStore = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue(failingSpans) });
    await makeService(captureStore).run();
    const captured = (
      captureStore.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[]
    )[0]!.Embedding;

    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(failingSpans),
      fetchActiveCentroids: vi.fn().mockResolvedValue([
        {
          facet: "task",
          mapVersion: 3,
          centroids: [{ topicId: "v1-c0", centroid: captured }],
        },
        {
          facet: "issues",
          mapVersion: 3,
          // Orthogonal to anything the mock produces for these spans.
          centroids: [
            { topicId: "v1-c9", centroid: [1, ...new Array(1023).fill(0)] },
          ],
        },
      ]),
    });
    await makeService(store).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const task = rows[0]!;
    expect(task.TopicId).toBe("v1-c0");
    expect(task.TopicDistance).toBeCloseTo(0, 6);
    expect(task.MapVersion).toBe(3);

    const issues = rows[2]!;
    expect(issues.TopicId).toBe(NO_MATCH_TOPIC_ID);
    expect(issues.MapVersion).toBe(3);
  });

  test("a structured-client failure still writes all three rows as errors (loop prevention)", async () => {
    const store = makeStore();
    const failing = {
      structured: { generateObject: vi.fn().mockRejectedValue(new Error("503 down")) },
      embedding: new MockTopicsModelClient(),
    };
    const result = await makeService(store, failing).run();

    expect(result).toEqual({ scanned: 1, enriched: 1, failed: 0 });
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.Status === "error" && r.Error === "503 down")).toBe(true);
    expect(rows.every((r) => r.Embedding.length === 0)).toBe(true);
  });

  test("an embedding failure keeps the summary (Status ok) but records the error and skips classification", async () => {
    const store = makeStore({
      fetchActiveCentroids: vi.fn().mockResolvedValue([
        {
          facet: "task",
          mapVersion: 1,
          centroids: [{ topicId: "t", centroid: [1, 0] }],
        },
      ]),
    });
    const clients = {
      structured: new MockTopicsModelClient(),
      embedding: { embed: vi.fn().mockRejectedValue(new Error("quota")) },
    };
    await makeService(store, clients).run();

    const task = (store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[])[0]!;
    expect(task.Status).toBe("ok");
    expect(task.Summary.length).toBeGreaterThan(0);
    expect(task.Embedding).toEqual([]);
    expect(task.Error).toBe("embedding_failed: quota");
    expect(task.TopicId).toBe("");
  });

  test("one trace failing hard does not sink the batch (per-trace isolation)", async () => {
    const scope2: TraceScope = { ...SCOPE, traceId: "trace-2" };
    const store = makeStore({
      findUnenrichedTraces: vi.fn().mockResolvedValue([SCOPE, scope2]),
      fetchTraceSpans: vi
        .fn()
        .mockRejectedValueOnce(new Error("clickhouse timeout"))
        .mockResolvedValue(REFUND_SPANS),
    });
    const result = await makeService(store).run();

    expect(result).toEqual({ scanned: 2, enriched: 1, failed: 1 });
    expect(store.insertFacetRows).toHaveBeenCalledTimes(1);
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows[0]!.TraceId).toBe("trace-2");
  });

  test("a trace whose spans vanished is skipped without an insert", async () => {
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue([]),
    });
    const result = await makeService(store).run();
    expect(result).toEqual({ scanned: 1, enriched: 1, failed: 0 });
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("centroids are fetched once per scope, not once per trace", async () => {
    const scope2: TraceScope = { ...SCOPE, traceId: "trace-2" };
    const store = makeStore({
      findUnenrichedTraces: vi.fn().mockResolvedValue([SCOPE, scope2]),
    });
    await makeService(store).run();
    expect(store.fetchActiveCentroids).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Steering facet — rides its own user-turns-only call; only agent traces with
// a surviving mid-session developer turn get a row at all.
// ---------------------------------------------------------------------------

const AGENT_SPANS: EnrichmentSpanRow[] = [
  {
    SpanId: "u1",
    ParentSpanId: "root",
    SpanName: "agent.turn.user",
    Type: "SPAN",
    Timestamp: "2026-07-01 10:00:00.000000000",
    Input: "Add a steering column to the sessions list please.",
    Output: "",
  },
  {
    SpanId: "a1",
    ParentSpanId: "root",
    SpanName: "agent.turn.assistant",
    Type: "GENERATION",
    Timestamp: "2026-07-01 10:00:01.000000000",
    Input: "",
    Output: "Done — I fetched the data with the legacy client.",
  },
  {
    SpanId: "u2",
    ParentSpanId: "root",
    SpanName: "agent.turn.user",
    Type: "SPAN",
    Timestamp: "2026-07-01 10:00:02.000000000",
    Input: "No — use @repo/api instead of the legacy client for dashboard calls.",
    Output: "",
  },
];

describe("TopicsEnrichmentService steering facet", () => {
  test("agent trace with a mid-session correction writes a 4th steering row: mock rule summary, unit embedding, no topic (no map yet)", async () => {
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    await makeService(store).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => r.Facet)).toEqual(["task", "sentiment", "issues", "steering"]);

    const steering = rows[3]!;
    expect(steering.Status).toBe("ok");
    // The extraction-time kind rides the Label ("use X instead of Y" -> preference).
    expect(steering.Label).toBe("preference");
    expect(steering.Summary).toContain("Follow the team convention about");
    expect(steering.Embedding).toHaveLength(1024);
    expect(Math.hypot(...steering.Embedding)).toBeCloseTo(1, 6);
    expect(steering.EmbeddingModel).toBe(MOCK_EMBEDDING_MODEL_VERSION);
    expect(steering.TopicId).toBe("");
    expect(steering.MapVersion).toBe(0);
    expect(steering.ItemIndex).toBe(0);
    expect(steering.ExtractorVersion).toBe(STEERING_EXTRACTOR_VERSION);
  });

  test("a session with several corrections fans out one row PER correction, each at its ItemIndex with its own summary and embedding", async () => {
    const multiCorrectionSpans: EnrichmentSpanRow[] = [
      ...AGENT_SPANS,
      {
        SpanId: "a2",
        ParentSpanId: "root",
        SpanName: "agent.turn.assistant",
        Type: "GENERATION",
        Timestamp: "2026-07-01 10:00:03.000000000",
        Input: "",
        Output: "Switched to @repo/api and pushed the branch.",
      },
      {
        SpanId: "u3",
        ParentSpanId: "root",
        SpanName: "agent.turn.user",
        Type: "SPAN",
        Timestamp: "2026-07-01 10:00:04.000000000",
        Input: "Never push until the tests pass locally.",
      Output: "",
      },
    ];
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(multiCorrectionSpans),
    });
    await makeService(store).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const steering = rows.filter((r) => r.Facet === "steering");
    expect(steering.map((r) => r.ItemIndex)).toEqual([0, 1]);
    expect(steering.map((r) => r.ExtractorVersion)).toEqual([
      STEERING_EXTRACTOR_VERSION,
      STEERING_EXTRACTOR_VERSION,
    ]);
    // Each row summarizes ITS OWN correction, not a blend.
    expect(steering[0]!.Summary).toContain("legacy");
    expect(steering[1]!.Summary).toContain("tests pass");
    expect(steering[0]!.Summary).not.toContain("tests pass");
    for (const row of steering) {
      expect(row.Status).toBe("ok");
      expect(row.Embedding).toHaveLength(1024);
    }
    // The two corrections embed as DIFFERENT vectors — one per correction,
    // not one shared session vector.
    expect(steering[0]!.Embedding).not.toEqual(steering[1]!.Embedding);
  });

  test("non-clusterable kinds are STORED but never embedded — a one-off can't become a pattern", async () => {
    const mixedKindSpans: EnrichmentSpanRow[] = [
      ...AGENT_SPANS, // "use @repo/api instead …" → preference (clusterable)
      {
        SpanId: "a2",
        ParentSpanId: "root",
        SpanName: "agent.turn.assistant",
        Type: "GENERATION",
        Timestamp: "2026-07-01 10:00:03.000000000",
        Input: "",
        Output: "Switched to @repo/api.",
      },
      {
        SpanId: "u3",
        ParentSpanId: "root",
        SpanName: "agent.turn.user",
        Type: "SPAN",
        Timestamp: "2026-07-01 10:00:04.000000000",
        // No rule/preference wording → mock kind task_direction.
        Input: "Close that ticket and start on the dashboard item next.",
        Output: "",
      },
    ];
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(mixedKindSpans),
    });
    await makeService(store).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const steering = rows.filter((r) => r.Facet === "steering");
    expect(steering.map((r) => [r.ItemIndex, r.Label])).toEqual([
      [0, "preference"],
      [1, "task_direction"],
    ]);
    // The preference clusters; the task direction is queryable but carries
    // no embedding, so it can never enter the sample, the counts, or a topic.
    expect(steering[0]!.Embedding).toHaveLength(1024);
    expect(steering[1]!.Embedding).toEqual([]);
    expect(steering[1]!.Status).toBe("ok");
    expect(steering[1]!.Error).toBe("");
    expect(steering[1]!.Summary).toContain("dashboard");
    expect(steering[1]!.ExtractorVersion).toBe(STEERING_EXTRACTOR_VERSION);
  });

  test("non-agent traces write NO steering row (exactly the three builtin facets)", async () => {
    const store = makeStore(); // REFUND_SPANS — no agent.turn.* spans
    await makeService(store).run();
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => r.Facet)).toEqual(["task", "sentiment", "issues"]);
  });

  test("NONE sentinel → labeled row with no summary, no embedding, never clustered", async () => {
    const mock = new MockTopicsModelClient();
    const clients: TopicsModelClients = {
      structured: {
        generateObject: vi.fn(async (request: { responseSchema: Record<string, unknown> }) => {
          const properties = request.responseSchema["properties"] as Record<string, unknown>;
          if ("steering" in properties) return { steering: { summary: "NONE" } };
          return mock.generateObject(request as never);
        }),
      },
      embedding: mock,
    };
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    await makeService(store, clients).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const steering = rows[3]!;
    expect(steering).toEqual(
      expect.objectContaining({
        Facet: "steering",
        Status: "ok",
        Label: "NONE",
        Summary: "",
        Embedding: [],
        TopicId: "",
      }),
    );
  });

  test("steering extraction failure degrades only the steering row", async () => {
    const mock = new MockTopicsModelClient();
    const clients: TopicsModelClients = {
      structured: {
        generateObject: vi.fn(async (request: { responseSchema: Record<string, unknown> }) => {
          const properties = request.responseSchema["properties"] as Record<string, unknown>;
          if ("steering" in properties) throw new Error("steering model down");
          return mock.generateObject(request as never);
        }),
      },
      embedding: mock,
    };
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    await makeService(store, clients).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows[0]!.Status).toBe("ok");
    const steering = rows[3]!;
    expect(steering.Status).toBe("error");
    expect(steering.Error).toBe("steering model down");
    expect(steering.Embedding).toEqual([]);
  });

  test("a custom own-pass facet is pure configuration: its render/extract/version flow into rows with no service changes", async () => {
    const customFacet = {
      key: "churn_risk",
      name: "Churn risk",
      description: "test facet",
      instruction: "irrelevant",
      extractorVersion: 7,
      // Eligibility lives in render: only traces with a user turn qualify.
      render: (spans: readonly { name: string }[]) =>
        spans.some((s) => s.name === "agent.turn.user") ? "rendered-document" : null,
      extract: async (text: string) => ({
        status: "ok" as const,
        summaries: [`risk summary for ${text}`, "second churn signal"],
      }),
    };
    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    const service = new TopicsEnrichmentService(
      store,
      mockClients(),
      resolveTopicsConfig({ TOPICS_ENRICHMENT_ENABLED: "true" }),
      [customFacet],
    );
    await service.run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const custom = rows.filter((r) => r.Facet === "churn_risk");
    expect(custom.map((r) => [r.ItemIndex, r.ExtractorVersion, r.Summary])).toEqual([
      [0, 7, "risk summary for rendered-document"],
      [1, 7, "second churn signal"],
    ]);
    // The batched builtins still ran alongside; steering did NOT (replaced
    // by the injected facet list).
    expect(rows.map((r) => r.Facet)).toEqual(["task", "sentiment", "issues", "churn_risk", "churn_risk"]);
  });

  test("classifies steering against the scope's active steering centroids", async () => {
    const captureStore = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    await makeService(captureStore).run();
    const captured = (
      captureStore.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[]
    )[3]!.Embedding;

    const store = makeStore({
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
      fetchActiveCentroids: vi.fn().mockResolvedValue([
        {
          facet: "steering",
          mapVersion: 2,
          centroids: [{ topicId: "v1-s0", centroid: captured }],
        },
      ]),
    });
    await makeService(store).run();

    const steering = (store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[])[3]!;
    expect(steering.TopicId).toBe("v1-s0");
    expect(steering.TopicDistance).toBeCloseTo(0, 6);
    expect(steering.MapVersion).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Steering backfill — the sweep over already-enriched history.
// ---------------------------------------------------------------------------

describe("TopicsEnrichmentService.runSteeringBackfill", () => {
  test("no candidates → zero result, no span fetches, no inserts", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([]),
    });
    const result = await makeService(store).runSteeringBackfill();
    expect(result).toEqual({ scanned: 0, enriched: 0, failed: 0 });
    expect(store.fetchTraceSpans).not.toHaveBeenCalled();
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("passes the shared config (lookback, batch, allowlist) to the candidate scan", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([]),
    });
    await makeService(store).runSteeringBackfill();
    expect(store.findSteeringBackfillCandidates).toHaveBeenCalledWith({
      lookbackHours: 24,
      limit: 25,
      tenantAllowlist: [],
      extractorVersion: STEERING_EXTRACTOR_VERSION,
    });
  });

  test("agent trace with a correction gets a REAL embedded steering row, plus tombstones sealing the fan-out tail", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    const result = await makeService(store).runSteeringBackfill();
    expect(result).toEqual({ scanned: 1, enriched: 1, failed: 0 });

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    // One real correction at item 0, then tombstones for items 1..7: a prior
    // extractor version may have written MORE items for this trace, and
    // without the tombstones those stale rows would survive as live fan-out.
    expect(rows).toHaveLength(8);
    const steering = rows[0]!;
    expect(steering.Facet).toBe("steering");
    expect(steering.Status).toBe("ok");
    expect(steering.Label).toBe("preference");
    expect(steering.Summary).toContain("Follow the team convention about");
    expect(steering.Embedding).toHaveLength(1024);
    expect(steering.IsDeleted).toBeUndefined();
    expect(rows.slice(1).map((r) => [r.ItemIndex, r.IsDeleted, r.Facet])).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((i) => [i, 1, "steering"]),
    );
    for (const tombstone of rows.slice(1)) {
      expect(tombstone.Embedding).toEqual([]);
      expect(tombstone.ExtractorVersion).toBe(STEERING_EXTRACTOR_VERSION);
    }
  });

  test("non-agent traces get a terminal NONE marker row with no embedding — never re-enter, never count toward the floor", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([SCOPE]),
      // REFUND_SPANS: a plain LLM trace, no agent.turn.* spans.
    });
    await makeService(store).runSteeringBackfill();
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows[0]).toEqual(
      expect.objectContaining({
        Facet: "steering",
        Status: "ok",
        Label: "NONE",
        Summary: "",
        Embedding: [],
        // Version-stamped so the version-keyed candidate scan treats the
        // marker as terminal — an unstamped marker would re-enter forever.
        ExtractorVersion: STEERING_EXTRACTOR_VERSION,
      }),
    );
    // The marker seals item 0; tombstones seal 1..7 against stale fan-out
    // from a prior extractor version.
    expect(rows.map((r) => [r.ItemIndex, r.IsDeleted ?? 0])).toEqual([
      [0, 0],
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => [i, 1]),
    ]);
  });

  test("a trace deleted between scan and fetch still gets the marker row (loop prevention)", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue([]),
    });
    await makeService(store).runSteeringBackfill();
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows[0]!.Label).toBe("NONE");
    expect(rows[0]!.Embedding).toEqual([]);
  });

  test("classifies backfilled steering rows against active steering centroids", async () => {
    const captureStore = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    await makeService(captureStore).runSteeringBackfill();
    const captured = (
      captureStore.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[]
    )[0]!.Embedding;

    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
      fetchActiveCentroids: vi.fn().mockResolvedValue([
        { facet: "steering", mapVersion: 5, centroids: [{ topicId: "v1-s0", centroid: captured }] },
      ]),
    });
    await makeService(store).runSteeringBackfill();
    const steering = (store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[])[0]!;
    expect(steering.TopicId).toBe("v1-s0");
    expect(steering.MapVersion).toBe(5);
  });
});

describe("TopicsEnrichmentService.runSteeringBackfill drain behavior", () => {
  const fullBatch = Array.from({ length: 25 }, (_, i) => ({
    ...SCOPE,
    traceId: `trace-${i}`,
  }));

  test("drains batches back-to-back within one tick and stops on a short batch", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi
        .fn()
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([SCOPE]),
    });
    const result = await makeService(store).runSteeringBackfill();
    expect(store.findSteeringBackfillCandidates).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scanned: 26, enriched: 26, failed: 0 });
    expect(store.insertFacetRows).toHaveBeenCalledTimes(26);
  });

  test("stops when the tick wall-clock budget is spent MID-BATCH — one batch of LLM latency must not eat the invocation", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue(fullBatch),
    });
    const nowMs = vi
      .fn()
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // batch-loop check → proceed
      .mockReturnValueOnce(0) // chunk 1 check → proceed
      .mockReturnValue(31_000); // chunk 2 check → budget spent
    const result = await makeService(store).runSteeringBackfill(nowMs);
    expect(store.findSteeringBackfillCandidates).toHaveBeenCalledTimes(1);
    // Only the first 6-concurrent chunk was attempted; scanned reports
    // attempts, so the tick log never claims coverage the budget cut off.
    expect(result).toEqual({ scanned: 6, enriched: 6, failed: 0 });
    expect(store.fetchTraceSpans).toHaveBeenCalledTimes(6);
  });

  test("caps traces per tick so a marker-heavy drain stays inside the subrequest budget", async () => {
    const store = makeStore({
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue(fullBatch),
    });
    const result = await makeService(store).runSteeringBackfill(() => 0);
    // 200-trace cap → exactly 8 full batches of 25.
    expect(store.findSteeringBackfillCandidates).toHaveBeenCalledTimes(8);
    expect(result.scanned).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// NONE sentinel + batched extractor versioning + the batched refresh.
// ---------------------------------------------------------------------------

describe("batched NONE sentinel and versioning", () => {
  function sentinelClients(): TopicsModelClients & { embedInputs: string[] } {
    const mock = new MockTopicsModelClient();
    const embedInputs: string[] = [];
    return {
      structured: {
        generateObject: async () => ({
          task: { summary: "Fix the flaky billing test suite." },
          sentiment: { label: "NEUTRAL", summary: "Routine work." },
          issues: { summary: "NONE" },
        }),
      },
      embedding: {
        embed: async (opts: { input: string; model: string; dimension: number }) => {
          embedInputs.push(opts.input);
          return mock.embed(opts);
        },
      },
      embedInputs,
    } as unknown as TopicsModelClients & { embedInputs: string[] };
  }

  test("a sentinel issues summary becomes a labeled marker row — never embedded, never clusterable", async () => {
    const clients = sentinelClients();
    const store = makeStore();
    await makeService(store, clients).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const issues = rows.find((r) => r.Facet === "issues")!;
    // Marker shape: labeled, no prose, no vector. Prose here is the bug this
    // guards against: "No issues encountered" would embed and cluster, so a
    // phrase meaning "nothing went wrong" becomes a top reported issue.
    expect(issues).toEqual(
      expect.objectContaining({
        Status: "ok",
        Label: "NONE",
        Summary: "",
        Embedding: [],
        ExtractorVersion: BATCHED_EXTRACTOR_VERSION,
      }),
    );
    // The sentinel text itself must never reach the embedder.
    expect(clients.embedInputs).toEqual(["Fix the flaky billing test suite."]);
    // Non-sentinel batched rows carry the batched extractor version too —
    // that stamp is what the refresh sweep keys history re-extraction on.
    const task = rows.find((r) => r.Facet === "task")!;
    const sentiment = rows.find((r) => r.Facet === "sentiment")!;
    expect(task.ExtractorVersion).toBe(BATCHED_EXTRACTOR_VERSION);
    expect(task.Summary).toBe("Fix the flaky billing test suite.");
    expect(task.Embedding).toHaveLength(1024);
    expect(sentiment.ExtractorVersion).toBe(BATCHED_EXTRACTOR_VERSION);
  });
});

describe("TopicsEnrichmentService.runBatchedRefresh", () => {
  test("re-extracts the batched trio ONLY — version-stamped rows, no own-pass steering row", async () => {
    const store = makeStore({
      findBatchedRefreshCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    const result = await makeService(store).runBatchedRefresh();
    expect(result).toEqual({ scanned: 1, enriched: 1, failed: 0 });
    expect(store.findBatchedRefreshCandidates).toHaveBeenCalledWith({
      lookbackHours: 24,
      limit: 25,
      tenantAllowlist: [],
      extractorVersion: BATCHED_EXTRACTOR_VERSION,
    });

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    // Exactly the batched trio — steering has its own version + sweep, and a
    // refresh that re-ran it would double-pay its LLM calls for no change.
    expect(rows.map((r) => r.Facet).sort()).toEqual(["issues", "sentiment", "task"]);
    for (const row of rows) {
      expect(row.ExtractorVersion).toBe(BATCHED_EXTRACTOR_VERSION);
    }
  });

  test("a trace deleted since original enrichment gets version-stamped markers — terminal, never re-picked", async () => {
    const store = makeStore({
      findBatchedRefreshCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue([]),
    });
    await makeService(store).runBatchedRefresh();
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => [r.Facet, r.Label, r.ExtractorVersion])).toEqual([
      ["task", "NONE", BATCHED_EXTRACTOR_VERSION],
      ["sentiment", "NONE", BATCHED_EXTRACTOR_VERSION],
      ["issues", "NONE", BATCHED_EXTRACTOR_VERSION],
    ]);
    expect(rows.every((r) => r.Embedding.length === 0)).toBe(true);
  });

  test("stops when the refresh budget is spent MID-BATCH — leftovers re-enter the next scan", async () => {
    const batch = Array.from({ length: 25 }, (_, i) => ({ ...SCOPE, traceId: `t-${i}` }));
    const store = makeStore({
      findBatchedRefreshCandidates: vi.fn().mockResolvedValue(batch),
      fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS),
    });
    const nowMs = vi
      .fn()
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // batch-loop check → proceed
      .mockReturnValueOnce(0) // chunk 1 check → proceed
      .mockReturnValue(16_000); // chunk 2 check → budget spent
    const result = await makeService(store).runBatchedRefresh(nowMs);
    expect(store.findBatchedRefreshCandidates).toHaveBeenCalledTimes(1);
    // Refresh chunks are 3-concurrent (full-transcript LLM calls, live-pass
    // sized); scanned reports attempts, never promised coverage.
    expect(result).toEqual({ scanned: 3, enriched: 3, failed: 0 });
  });
});

describe("oversized-transcript poison-pill guard", () => {
  const bigSpans = Array.from({ length: 1000 }, (_, i) => ({
    SpanId: `s${i}`,
    ParentSpanId: "",
    SpanName: "agent.turn.user",
    Type: "SPAN",
    Timestamp: "2026-07-01 10:00:00.000000000",
    Input: "x",
    Output: "",
  }));

  test("a span-cap transcript is PROCESSED — bounded head+tail rendering makes it an ordinary call", async () => {
    // Very long sessions must be digested, not refused: 1,000 spans render
    // into a budget-bounded prompt and produce real rows like any other trace.
    const requests: string[] = [];
    const mock = new MockTopicsModelClient();
    const clients = {
      structured: {
        generateObject: (req: { userPrompt: string; responseSchema: Record<string, unknown> }) => {
          requests.push(req.userPrompt);
          return mock.generateObject(req as never);
        },
      },
      embedding: mock,
    } as unknown as TopicsModelClients;
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue(bigSpans) });

    await makeService(store, clients).run();

    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    const task = rows.find((r) => r.Facet === "task")!;
    expect(task.Status).toBe("ok");
    expect(task.Summary.length).toBeGreaterThan(0);
    // Every prompt stays within the enrichment budget (32k tokens × 4 chars),
    // with slack for the prompt scaffolding around the rendering.
    expect(requests.length).toBeGreaterThan(0);
    for (const prompt of requests) {
      expect(prompt.length).toBeLessThanOrEqual(32_000 * 4);
    }
  });

  test("a truly pathological payload (> 5MB) trips the last-resort refusal with terminal rows", async () => {
    const generateObject = vi.fn();
    const clients = {
      structured: { generateObject },
      embedding: new MockTopicsModelClient(),
    } as unknown as TopicsModelClients;
    const monstrous = [
      { SpanId: "m1", ParentSpanId: "", SpanName: "agent.turn.user", Type: "SPAN", Timestamp: "2026-07-01 10:00:00.000000000", Input: "z".repeat(3_000_000), Output: "" },
      { SpanId: "m2", ParentSpanId: "m1", SpanName: "agent.turn.assistant", Type: "GENERATION", Timestamp: "2026-07-01 10:00:01.000000000", Input: "", Output: "z".repeat(3_000_000) },
    ];
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue(monstrous) });

    await makeService(store, clients).run();

    expect(generateObject).not.toHaveBeenCalled();
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => [r.Facet, r.Status, r.Label])).toEqual([
      ["task", "error", ""],
      ["sentiment", "error", ""],
      ["issues", "error", ""],
      ["steering", "ok", "NONE"],
    ]);
    for (const row of rows.slice(0, 3)) {
      expect(row.Error).toContain("exceeds enrichment bounds");
      expect(row.ExtractorVersion).toBe(BATCHED_EXTRACTOR_VERSION);
    }
    expect(rows[3]!.ExtractorVersion).toBe(STEERING_EXTRACTOR_VERSION);
  });

  test("over-budget rendering keeps BOTH the opening and the ending visible to the model", async () => {
    const requests: string[] = [];
    const mock = new MockTopicsModelClient();
    const clients = {
      structured: {
        generateObject: (req: { userPrompt: string; responseSchema: Record<string, unknown> }) => {
          requests.push(req.userPrompt);
          return mock.generateObject(req as never);
        },
      },
      embedding: mock,
    } as unknown as TopicsModelClients;
    const long = [
      { SpanId: "h", ParentSpanId: "", SpanName: "agent.turn.user", Type: "SPAN", Timestamp: "2026-07-01 10:00:00.000000000", Input: "OPENING-BEACON build the dataset importer " + "pad ".repeat(60_000), Output: "" },
      { SpanId: "t", ParentSpanId: "h", SpanName: "agent.turn.assistant", Type: "GENERATION", Timestamp: "2026-07-01 10:00:01.000000000", Input: "", Output: "pad ".repeat(60_000) + " FAILURE-BEACON the deploy step crashed at the end" },
    ];
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue(long) });

    await makeService(store, clients).run();

    // The issues facet's signal lives at the END of long sessions —
    // head-only truncation hid it from every over-budget trace.
    const prompt = requests[0]!;
    expect(prompt).toContain("OPENING-BEACON");
    expect(prompt).toContain("FAILURE-BEACON");
    expect(prompt).toContain("[middle of transcript elided]");
  });

  test("refresh path: a > 5MB payload refuses with the batched trio only — steering untouched", async () => {
    const fat = [
      { SpanId: "a", ParentSpanId: "", SpanName: "agent.turn.user", Type: "SPAN", Timestamp: "2026-07-01 10:00:00.000000000", Input: "y".repeat(3_000_000), Output: "" },
      { SpanId: "b", ParentSpanId: "a", SpanName: "agent.turn.assistant", Type: "GENERATION", Timestamp: "2026-07-01 10:00:01.000000000", Input: "", Output: "y".repeat(3_000_000) },
    ];
    const store = makeStore({
      findBatchedRefreshCandidates: vi.fn().mockResolvedValue([SCOPE]),
      fetchTraceSpans: vi.fn().mockResolvedValue(fat),
    });
    await makeService(store).runBatchedRefresh();
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    // Refresh owns only the batched trio — steering untouched.
    expect(rows.map((r) => r.Facet)).toEqual(["task", "sentiment", "issues"]);
    expect(rows.every((r) => r.Status === "error" && r.ExtractorVersion === BATCHED_EXTRACTOR_VERSION)).toBe(true);
  });
});

describe("tick deadline donation", () => {
  test("an absolute deadline overrides the pass's internal budget", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...SCOPE, traceId: `d-${i}` }));
    const store = makeStore({ findUnenrichedTraces: vi.fn().mockResolvedValue(six) });
    const nowMs = vi
      .fn()
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // chunk 1 check → proceed
      .mockReturnValue(6_000); // chunk 2 check → past the 5s deadline (well inside the 20s internal budget)
    const result = await makeService(store).run(nowMs, 5_000);
    expect(result).toEqual({ scanned: 3, enriched: 3, failed: 0 });
  });
});

describe("enrichQueuedTrace", () => {
  test("writes exactly the rows the scan path would write for the same trace", async () => {
    const scanStore = makeStore();
    await makeService(scanStore).run();
    const scanRows = scanStore.insertFacetRows.mock.calls[0]![0];

    const queueStore = makeStore();
    const outcome = await makeService(queueStore).enrichQueuedTrace(SCOPE, {
      finalAttempt: false,
    });

    expect(outcome).toBe("enriched");
    expect(queueStore.insertFacetRows).toHaveBeenCalledTimes(1);
    expect(queueStore.insertFacetRows.mock.calls[0]![0]).toEqual(scanRows);
  });

  test("a task facet row means the trace is owned — no fetch, no model call, no rows", async () => {
    const store = makeStore({ hasTaskFacetRow: vi.fn().mockResolvedValue(true) });
    const outcome = await makeService(store).enrichQueuedTrace(SCOPE, {
      finalAttempt: false,
    });

    expect(outcome).toBe("already_enriched");
    expect(store.fetchTraceSpans).not.toHaveBeenCalled();
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("unreadable trace reports trace_missing and stays rowless", async () => {
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue([]) });
    const outcome = await makeService(store).enrichQueuedTrace(SCOPE, {
      finalAttempt: false,
    });

    expect(outcome).toBe("trace_missing");
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("quiet window: spans inside the debounce defer, spans past it enrich", async () => {
    // Latest REFUND_SPANS Timestamp is 10:00:01Z; debounce is 5 minutes.
    const store = makeStore();
    const service = makeService(store);

    const during = await service.enrichQueuedTrace(
      SCOPE,
      { finalAttempt: false },
      () => Date.parse("2026-07-01T10:04:59Z"),
    );
    expect(during).toBe("trace_not_quiet");
    expect(store.insertFacetRows).not.toHaveBeenCalled();

    const after = await service.enrichQueuedTrace(
      SCOPE,
      { finalAttempt: false },
      () => Date.parse("2026-07-01T10:05:02Z"),
    );
    expect(after).toBe("enriched");
    expect(store.insertFacetRows).toHaveBeenCalledTimes(1);
  });

  test("transient model failure throws RetryableEnrichmentError with NO rows written", async () => {
    const store = makeStore();
    const failing: TopicsModelClients = {
      structured: {
        generateObject: vi
          .fn()
          .mockRejectedValue(
            new Error("OpenAI-compatible chat/completions failed with HTTP 429: rate limited"),
          ),
      },
      embedding: mockClients().embedding,
    };

    await expect(
      makeService(store, failing).enrichQueuedTrace(SCOPE, { finalAttempt: false }),
    ).rejects.toBeInstanceOf(RetryableEnrichmentError);
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("the same transient failure on the FINAL attempt records terminal error rows", async () => {
    const store = makeStore();
    const failing: TopicsModelClients = {
      structured: {
        generateObject: vi
          .fn()
          .mockRejectedValue(
            new Error("OpenAI-compatible chat/completions failed with HTTP 429: rate limited"),
          ),
      },
      embedding: mockClients().embedding,
    };

    const outcome = await makeService(store, failing).enrichQueuedTrace(SCOPE, {
      finalAttempt: true,
    });

    expect(outcome).toBe("enriched");
    const rows = store.insertFacetRows.mock.calls[0]![0] as { Facet: string; Status: string; Error: string }[];
    const batched = rows.filter((r) => ["task", "sentiment", "issues"].includes(r.Facet));
    expect(batched.map((r) => r.Status)).toEqual(["error", "error", "error"]);
    for (const row of batched) {
      expect(row.Error).toContain("HTTP 429");
    }
  });

  test("a deterministic model failure records rows immediately — retrying can't fix it", async () => {
    const store = makeStore();
    const failing: TopicsModelClients = {
      structured: {
        generateObject: vi
          .fn()
          .mockRejectedValue(
            new Error("OpenAI-compatible chat/completions returned non-JSON content (first 120 chars): oops"),
          ),
      },
      embedding: mockClients().embedding,
    };

    const outcome = await makeService(store, failing).enrichQueuedTrace(SCOPE, {
      finalAttempt: false,
    });

    expect(outcome).toBe("enriched");
    expect(store.insertFacetRows).toHaveBeenCalledTimes(1);
  });
});

describe("queued backfill wrappers", () => {
  test("refreshQueuedTrace: version-current rows short-circuit before any fetch or model call", async () => {
    const store = makeStore({ hasFacetRowsAtVersion: vi.fn().mockResolvedValue(true) });
    const outcome = await makeService(store).refreshQueuedTrace(SCOPE, { finalAttempt: false });

    expect(outcome).toBe("already_enriched");
    expect(store.hasFacetRowsAtVersion).toHaveBeenCalledWith(SCOPE, "task", BATCHED_EXTRACTOR_VERSION);
    expect(store.fetchTraceSpans).not.toHaveBeenCalled();
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("refreshQueuedTrace: transient model failure throws with NOTHING written; the final attempt records it", async () => {
    const failing: TopicsModelClients = {
      structured: {
        generateObject: vi
          .fn()
          .mockRejectedValue(new Error("OpenAI-compatible chat/completions failed with HTTP 429: slow down")),
      },
      embedding: mockClients().embedding,
    };

    const store = makeStore();
    await expect(
      makeService(store, failing).refreshQueuedTrace(SCOPE, { finalAttempt: false }),
    ).rejects.toBeInstanceOf(RetryableEnrichmentError);
    expect(store.insertFacetRows).not.toHaveBeenCalled();

    const finalStore = makeStore();
    const outcome = await makeService(finalStore, failing).refreshQueuedTrace(SCOPE, {
      finalAttempt: true,
    });
    expect(outcome).toBe("enriched");
    const rows = finalStore.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => [r.Facet, r.Status])).toEqual([
      ["task", "error"],
      ["sentiment", "error"],
      ["issues", "error"],
    ]);
  });

  test("refreshQueuedTrace: a deleted trace stays TERMINAL — version-stamped markers, never a retry loop", async () => {
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue([]) });
    const outcome = await makeService(store).refreshQueuedTrace(SCOPE, { finalAttempt: false });

    expect(outcome).toBe("enriched");
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows.map((r) => [r.Facet, r.Label, r.ExtractorVersion])).toEqual([
      ["task", "NONE", BATCHED_EXTRACTOR_VERSION],
      ["sentiment", "NONE", BATCHED_EXTRACTOR_VERSION],
      ["issues", "NONE", BATCHED_EXTRACTOR_VERSION],
    ]);
  });

  test("sweepQueuedTrace: version-current steering rows short-circuit; otherwise rows + tombstones land", async () => {
    const current = makeStore({ hasFacetRowsAtVersion: vi.fn().mockResolvedValue(true) });
    const skipped = await makeService(current).sweepQueuedTrace(SCOPE, { finalAttempt: false });
    expect(skipped).toBe("already_enriched");
    expect(current.hasFacetRowsAtVersion).toHaveBeenCalledWith(
      SCOPE,
      "steering",
      STEERING_EXTRACTOR_VERSION,
    );
    expect(current.insertFacetRows).not.toHaveBeenCalled();

    // Non-agent transcript (REFUND_SPANS): the sweep writes its NONE marker
    // plus the tombstoned fan-out tail — terminality intact via the queue.
    const store = makeStore();
    const outcome = await makeService(store).sweepQueuedTrace(SCOPE, { finalAttempt: false });
    expect(outcome).toBe("enriched");
    const rows = store.insertFacetRows.mock.calls[0]![0] as TraceFacetRow[];
    expect(rows).toHaveLength(8);
    expect(rows[0]!.Label).toBe("NONE");
    expect(rows.slice(1).every((r) => r.IsDeleted === 1)).toBe(true);
  });

  test("sweepQueuedTrace: transient steering-extraction failure throws with nothing written", async () => {
    const failing: TopicsModelClients = {
      structured: {
        generateObject: vi
          .fn()
          .mockRejectedValue(new Error("OpenAI-compatible chat/completions timed out after 65000ms (hard bound)")),
      },
      embedding: mockClients().embedding,
    };
    // Agent-shaped spans so the steering render is eligible and extraction runs.
    const store = makeStore({ fetchTraceSpans: vi.fn().mockResolvedValue(AGENT_SPANS) });
    await expect(
      makeService(store, failing).sweepQueuedTrace(SCOPE, { finalAttempt: false }),
    ).rejects.toBeInstanceOf(RetryableEnrichmentError);
    expect(store.insertFacetRows).not.toHaveBeenCalled();
  });

  test("candidate finders pass the service config and CURRENT versions to the store scans", async () => {
    const store = makeStore({
      findBatchedRefreshCandidates: vi.fn().mockResolvedValue([]),
      findSteeringBackfillCandidates: vi.fn().mockResolvedValue([]),
    });
    const service = makeService(store);
    await service.findRefreshCandidateScopes(100);
    await service.findSweepCandidateScopes(100);

    expect(store.findBatchedRefreshCandidates).toHaveBeenCalledWith({
      lookbackHours: 24,
      limit: 100,
      tenantAllowlist: [],
      extractorVersion: BATCHED_EXTRACTOR_VERSION,
    });
    expect(store.findSteeringBackfillCandidates).toHaveBeenCalledWith({
      lookbackHours: 24,
      limit: 100,
      tenantAllowlist: [],
      extractorVersion: STEERING_EXTRACTOR_VERSION,
    });
  });
});
