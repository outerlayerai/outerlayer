/**
 * readTopicLabels: best-effort trace → topic-name lookup for the PR session
 * comment. Every case here exercises the map shape and the degrade-to-empty
 * contract without a ClickHouse server — chQuery is a plain mock.
 */
import { describe, it, expect, vi } from "vitest";

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

  it("a query failure degrades to empty labels instead of throwing", async () => {
    const chQuery: ChQueryFn = vi.fn().mockRejectedValue(new Error("ClickHouse unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      "[pr-session-comment] readTopicLabels query failed; continuing with no labels",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("rows with a blank Name are ignored", async () => {
    const chQuery: ChQueryFn = vi.fn().mockResolvedValue([
      { TraceId: "trace-1", Name: "" },
      { TraceId: "trace-1", Name: "Real topic" },
    ]);

    const result = await readTopicLabels({ chQuery, traceIds: ["trace-1"] });

    expect(result.get("trace-1")).toEqual(["Real topic"]);
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
