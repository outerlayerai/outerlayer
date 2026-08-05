import { describe, expect, test } from "vitest";
import {
  ENRICHMENT_QUERY_SETTINGS,
  ENRICHMENT_REQUEST_TIMEOUT_MS,
  buildTraceSpansSql,
  buildUnenrichedCandidatesSql,
} from "./topics-store";

describe("buildUnenrichedCandidatesSql — candidate recency predicate", () => {
  test("keys the candidate lower bound on INGEST time (CreatedAt), never session wall-clock (Timestamp)", () => {
    const sql = buildUnenrichedCandidatesSql(false);

    // Backfilled sessions land with OLD Timestamps but CreatedAt = now(),
    // so the scan must react to arrival for them to be enriched at all.
    expect(sql).toContain(
      "CreatedAt >= now() - INTERVAL {lookbackHours:UInt32} HOUR",
    );
    // Regression guard: a Timestamp-windowed lower bound would make backfill
    // permanently invisible. It must NOT gate candidacy on Timestamp.
    expect(sql).not.toMatch(/Timestamp\s*>=\s*now/);

    // Completion/debounce stays on Timestamp (a trace is done when no NEW
    // spans arrive) — correct for backfill too (old max(Timestamp) qualifies).
    expect(sql).toContain(
      "HAVING max(Timestamp) <= now64(9) - INTERVAL {debounceMinutes:UInt32} MINUTE",
    );
    // Human-first (subagent/programmatic transcripts sort last — they're the
    // rows task/steering generation never samples), then oldest-quiet first,
    // bounded batch, so a large import drains steadily toward the floor.
    const orderBy = sql.slice(sql.indexOf("ORDER BY"));
    expect(orderBy).toContain("FROM agent_session_summary");
    expect(orderBy).toContain("(ParentSessionId != '' OR Origin = 'agent')");
    expect(orderBy.replace(/\s+/g, " ")).toContain(") ASC, max(Timestamp) ASC");
    expect(sql).toContain("LIMIT {limit:UInt32}");
    // Already-enriched traces excluded IN the query (not post-LIMIT).
    expect(sql).toContain("TraceId NOT IN (");
  });

  test("includes the tenant allowlist clause only when an allowlist is present", () => {
    expect(buildUnenrichedCandidatesSql(true)).toContain(
      "AND TenantId IN ({allowlist:Array(String)})",
    );
    expect(buildUnenrichedCandidatesSql(false)).not.toContain("allowlist");
  });
});

describe("buildSteeringBackfillCandidatesSql", () => {
  test("keys on task rows missing a CURRENT-version steering row, parameterized and window-bounded", async () => {
    const { buildSteeringBackfillCandidatesSql } = await import("./topics-store");
    const sql = buildSteeringBackfillCandidatesSql(false);
    expect(sql).toContain("FROM trace_facets");
    expect(sql).toContain("Facet = 'task'");
    expect(sql).toContain("Facet = 'steering'");
    expect(sql).toContain("TraceId NOT IN");
    // Only CURRENT-version steering rows block a candidate — rows written by
    // an older extractor re-qualify, which is the re-extraction mechanism.
    expect(sql).toContain("ExtractorVersion >= {extractorVersion:UInt16}");
    expect(sql).toContain("INTERVAL {lookbackHours:UInt32} HOUR");
    expect(sql).toContain("LIMIT {limit:UInt32}");
    // Human-first: transcripts owned by a subagent or programmatic run sort
    // AFTER everything else (they can never be sampled by task/steering
    // generation), then oldest arrival first within each class.
    const orderBy = sql.slice(sql.indexOf("ORDER BY"));
    expect(orderBy).toContain("FROM agent_session_summary");
    expect(orderBy).toContain("(ParentSessionId != '' OR Origin = 'agent')");
    expect(orderBy.replace(/\s+/g, " ")).toContain(") ASC, min(CreatedAt) ASC");
    expect(sql).not.toContain("{allowlist:Array(String)}");
    const allowlisted = buildSteeringBackfillCandidatesSql(true);
    expect(allowlisted).toContain("TenantId IN ({allowlist:Array(String)})");
    // The allowlist bounds the priority membership set too, not just the scan.
    expect(
      allowlisted.slice(allowlisted.indexOf("ORDER BY")),
    ).toContain("TenantId IN ({allowlist:Array(String)})");
    // Never scans otel_traces — candidates come from facet rows alone.
    expect(sql).not.toContain("otel_traces");
  });
});

describe("buildTraceSpansSql — bounded by the trace-id time-range lookup", () => {
  test("bounded form narrows to the trace's own Timestamp range; unbounded form is the exact fallback", () => {
    const bounded = buildTraceSpansSql(true);
    // The bounds are what turn a whole-retention FINAL merge into a read of
    // the trace's own partitions/granules. They MUST be table-qualified: the
    // projected `toString(Timestamp) AS Timestamp` shadows the raw column,
    // and an unqualified predicate compares String vs DateTime64 and errors
    // on every fetch.
    expect(bounded).toContain("AND spans.Timestamp >= {tsRangeStart:DateTime64(9)}");
    expect(bounded).toContain("AND spans.Timestamp <= {tsRangeEnd:DateTime64(9)}");
    expect(bounded).not.toMatch(/AND Timestamp >=/);

    const unbounded = buildTraceSpansSql(false);
    expect(unbounded).not.toContain("tsRangeStart");
    expect(unbounded).not.toContain("tsRangeEnd");

    // Same core contract either way: env-scoped single trace, dedupe via
    // FINAL, soft-deletes excluded, span cap intact.
    for (const sql of [bounded, unbounded]) {
      expect(sql).toContain("FROM otel_traces AS spans FINAL");
      expect(sql).toContain("TraceId = {traceId:String}");
      expect(sql).toContain("Environment = {environment:String}");
      expect(sql).toContain("IsDeleted = 0");
      expect(sql).toContain("ORDER BY spans.Timestamp ASC");
      expect(sql).toContain("LIMIT 1000");
    }
  });
});

describe("ENRICHMENT_QUERY_SETTINGS", () => {
  test("caps per-query memory far below a small instance's server ceiling, with spill enabled", () => {
    expect(ENRICHMENT_QUERY_SETTINGS).toEqual({
      max_memory_usage: "1200000000",
      max_bytes_before_external_group_by: "600000000",
      max_bytes_before_external_sort: "600000000",
    });
    // Spill thresholds must sit BELOW the hard cap or they can never engage.
    expect(
      Number(ENRICHMENT_QUERY_SETTINGS.max_bytes_before_external_group_by),
    ).toBeLessThan(Number(ENRICHMENT_QUERY_SETTINGS.max_memory_usage));
  });

  test("every enrichment read is time-bounded — a stalled one would strand its whole queue batch", () => {
    // Enrichment runs inside a queue consumer whose messages process
    // concurrently, so one unbounded read outlives its invocation and costs
    // every trace sharing the batch, not just its own.
    expect(ENRICHMENT_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe("buildBatchedRefreshCandidatesSql", () => {
  test("keys on task rows BELOW the current batched version via current-version presence, human-first", async () => {
    const { buildBatchedRefreshCandidatesSql } = await import("./topics-store");
    const sql = buildBatchedRefreshCandidatesSql(false);
    // Candidate side and terminality side are BOTH the task facet: the
    // refresh replaces rows in place, and the presence of a current-version
    // task row is what retires a candidate (an absence test would re-pick
    // every trace until the ReplacingMergeTree merge happened to run).
    expect(sql.match(/Facet = 'task'/g)).toHaveLength(2);
    expect(sql).toContain("ExtractorVersion >= {extractorVersion:UInt16}");
    expect(sql).toContain("TraceId NOT IN");
    expect(sql).toContain("INTERVAL {lookbackHours:UInt32} HOUR");
    expect(sql).toContain("LIMIT {limit:UInt32}");
    const orderBy = sql.slice(sql.indexOf("ORDER BY"));
    expect(orderBy).toContain("(ParentSessionId != '' OR Origin = 'agent')");
    expect(orderBy.replace(/\s+/g, " ")).toContain(") ASC, min(CreatedAt) ASC");
    expect(sql).not.toContain("otel_traces");
    expect(sql).not.toContain("steering");
    const allowlisted = buildBatchedRefreshCandidatesSql(true);
    expect(allowlisted.match(/TenantId IN \({allowlist:Array\(String\)}\)/g)).toHaveLength(2);
  });
});
