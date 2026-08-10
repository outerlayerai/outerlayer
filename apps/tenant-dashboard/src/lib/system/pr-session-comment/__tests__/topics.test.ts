/**
 * readTopicLabels: best-effort trace → topic-name lookup for the PR session
 * comment. Every case here exercises the map shape and the degrade-to-empty
 * contract without a ClickHouse server — chQuery is a plain mock.
 */
import { describe, it, expect, vi } from "vitest";

const mockLoggerError = vi.fn();
vi.mock("@/lib/observability/server-logger", () => ({
  serverLogger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { readTopicLabels, type ChQueryFn } from "../topics";

describe("readTopicLabels", () => {
  it("groups labels per trace, deduped, in stable first-seen order", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-1", Name: "Auth flows" },
      { TraceId: "trace-1", Name: "Auth flows" }, // duplicate facet row → deduped
      { TraceId: "trace-1", Name: "Retry storms" },
      { TraceId: "trace-2", Name: "Billing edge cases" },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1", "trace-2"] });

    expect(result.get("trace-1")).toEqual(["Auth flows", "Retry storms"]);
    expect(result.get("trace-2")).toEqual(["Billing edge cases"]);
  });

  it("every requested trace id is present in the map, even with no matching rows", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-1", Name: "Auth flows" },
    ]);

    const result = await readTopicLabels({
      chQuery,
      traceIds: ["trace-1", "trace-2", "trace-3"],
    });

    expect(result.get("trace-1")).toEqual(["Auth flows"]);
    expect(result.get("trace-2")).toEqual([]);
    expect(result.get("trace-3")).toEqual([]);
    expect(result.size).toBe(3);
  });

  it("empty traceIds → empty map, chQuery never called", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([]);

    const result = await readTopicLabels({ chQuery, traceIds: [] });

    expect(result.size).toBe(0);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("null chQuery (ClickHouse unconfigured) → every trace resolves to []", async () => {
    const result = await readTopicLabels({ chQuery: null, traceIds: ["trace-1", "trace-2"] });

    expect(result.get("trace-1")).toEqual([]);
    expect(result.get("trace-2")).toEqual([]);
  });

  // Labels degrading to blank is indistinguishable from Topics being off or
  // not yet clustered, so a persistently broken query is invisible unless it
  // reaches Logtail — a `console.error` here would never leave the container.
  it("a query failure degrades to empty labels and reports a structured event", async () => {
    mockLoggerError.mockClear();
    const chQuery: ChQueryFn = vi.fn().mockRejectedValue(new Error("ClickHouse unreachable"));

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual([]);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ event: "pr_session_comment.topics_query_failed", _metric: true }),
    );
  });

  // The SELECT list is one defense; this is the structural one — whatever
  // the SQL returns, only TraceId and Name can travel onward (AC-057-08).
  it("never surfaces a column outside the TraceId/Name allowlist", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      {
        TraceId: "trace-1",
        Name: "Auth flows",
        Summary: "the user pasted a production database password",
      },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual(["Auth flows"]);
    expect(JSON.stringify([...result])).not.toContain("production database password");
  });

  it("rows with a blank Name are ignored", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-1", Name: "" },
      { TraceId: "trace-1", Name: "Real topic" },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual(["Real topic"]);
  });

  it("coerces a non-string TraceId/Name to a string rather than dropping the row", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      // ClickHouse hands back untyped JSON — a numeric TraceId/Name must
      // still resolve to a usable string key/label, not `[object Object]`
      // or a silently dropped row.
      { TraceId: 12345, Name: 67890 },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["12345"] });

    expect(result.get("12345")).toEqual(["67890"]);
  });

  it("drops a row with a missing TraceId or Name rather than coercing null/undefined to a label", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-1", Name: null },
      { TraceId: null, Name: "Orphan label" },
      { TraceId: "trace-1", Name: "Real topic" },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual(["Real topic"]);
  });

  it("still collects labels for a row whose TraceId was not in the requested list", async () => {
    // Defensive path: every row in the initial map comes pre-seeded with []
    // from `traceIds`, but a row for a trace outside that list has no entry
    // yet — this is the one case where the map actually gains a new key
    // while processing rows, rather than appending to an existing one.
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-unrequested", Name: "Surprise topic" },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual([]);
    expect(result.get("trace-unrequested")).toEqual(["Surprise topic"]);
  });

  it("appends to an already-seeded trace's label list rather than starting a fresh array", async () => {
    // trace-1 is present in the returned map from traceIds seeding BEFORE any
    // row is processed (see the "every requested trace id is present" test);
    // this pins that a matching row for it APPENDS rather than replacing.
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-1", Name: "First" },
      { TraceId: "trace-1", Name: "Second" },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual(["First", "Second"]);
  });

  it("passes traceIds through as the SQL parameter", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([]);

    await readTopicLabels({ chQuery, traceIds: ["trace-1", "trace-2"] });

    expect(chQuery).toHaveBeenCalledWith(expect.any(String), {
      traceIds: ["trace-1", "trace-2"],
    });
  });

  // PRIVACY: trace_facets.Summary is transcript-derived and must never reach
  // a world-readable PR comment. This is a regression test on the generated
  // SQL string itself, not just the returned shape.
  it("the generated SQL never references trace_facets.Summary", async () => {
    let capturedSql = "";
    const chQuery: ChQueryFn = vi.fn().mockImplementation(async (sql) => {
      capturedSql = sql;
      return [];
    });

    await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(capturedSql).not.toMatch(/Summary/i);
  });

  it("the generated SQL is scoped to Status = 'ok' and IsDeleted = 0, and reads from trace_facets/trace_topic_maps", async () => {
    let capturedSql = "";
    const chQuery: ChQueryFn = vi.fn().mockImplementation(async (sql) => {
      capturedSql = sql;
      return [];
    });

    await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(capturedSql).toContain("trace_facets");
    expect(capturedSql).toContain("trace_topic_maps");
    expect(capturedSql).toContain("Status = 'ok'");
    expect(capturedSql).toContain("IsDeleted = 0");
    expect(capturedSql).toContain("MapVersion");
  });
});
