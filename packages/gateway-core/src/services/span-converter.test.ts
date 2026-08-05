import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizedSpanToClickHouseRow, normalizeOtlpStatusCode, statusCodeEquivalents, stripRedundantIoAttributes } from "./span-converter";
import { SpanType, type NormalizedSpan, type Message, type ToolCall } from "@repo/shared-utils";
import type { UserMeta } from "../types";

/** Base span with all required NormalizedSpan fields */
const baseSpan: NormalizedSpan = {
  traceId: "trace-123",
  spanId: "span-456",
  type: SpanType.SPAN,
  startTime: 1700000000000, // milliseconds
  duration: 100,
  name: "test-span",
  kind: "INTERNAL",
  statusCode: "1",
  resourceAttributes: {},
  spanAttributes: {},
  events: [],
  links: [],
};

/** Helper to create a NormalizedSpan with optional overrides */
function createMinimalSpan(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return { ...baseSpan, ...overrides };
}

// Helper to create a minimal valid UserMeta
function createMinimalMeta(overrides: Partial<UserMeta> = {}): UserMeta {
  return {
    appId: "app-123",
    tenantId: "tenant-456",
    stripeCustomerId: "cus_789",
    stripeSubscriptionId: "sub_abc",
    appName: "Test App",
    branchId: "main",
    ...overrides,
  };
}

describe("normalizeOtlpStatusCode", () => {
  // Exact mapping table: every OTLP wire variant → canonical numeric string.
  it.each([
    // Unset
    ["0", "0"],
    ["STATUS_CODE_UNSET", "0"],
    ["UNSET", "0"],
    ["Unset", "0"],
    // Ok
    ["1", "1"],
    ["STATUS_CODE_OK", "1"],
    ["OK", "1"],
    ["Ok", "1"],
    // Error
    ["2", "2"],
    ["STATUS_CODE_ERROR", "2"],
    ["ERROR", "2"],
    ["Error", "2"],
  ])("maps %s → %s", (input, expected) => {
    expect(normalizeOtlpStatusCode(input)).toBe(expected);
  });

  it.each([
    [undefined, "0"],
    [null, "0"],
    ["", "0"],
  ])("maps missing status (%s) → '0' (Unset)", (input, expected) => {
    expect(normalizeOtlpStatusCode(input as string | undefined | null)).toBe(expected);
  });

  it("passes unknown values through unchanged (visible, surfaced as UNKNOWN at read time)", () => {
    expect(normalizeOtlpStatusCode("3")).toBe("3");
    expect(normalizeOtlpStatusCode("weird")).toBe("weird");
  });
});

describe("statusCodeEquivalents", () => {
  it("expands each canonical code to canonical + legacy stored variants", () => {
    expect(statusCodeEquivalents("0")).toEqual(["0", "STATUS_CODE_UNSET", "UNSET", "Unset"]);
    expect(statusCodeEquivalents("1")).toEqual(["1", "STATUS_CODE_OK", "OK", "Ok"]);
    expect(statusCodeEquivalents("2")).toEqual(["2", "STATUS_CODE_ERROR", "ERROR", "Error"]);
  });

  it("returns unknown codes as a singleton set", () => {
    expect(statusCodeEquivalents("3")).toEqual(["3"]);
  });
});

describe("normalizedSpanToClickHouseRow", () => {
  describe("StatusCode normalization at the write boundary", () => {
    it.each([
      ["STATUS_CODE_ERROR", "2"],
      ["Error", "2"],
      ["STATUS_CODE_OK", "1"],
      ["OK", "1"],
      ["UNSET", "0"],
      ["1", "1"],
    ])("writes canonical StatusCode for normalizer output %s", (raw, canonical) => {
      const row = normalizedSpanToClickHouseRow(
        createMinimalSpan({ statusCode: raw }),
        createMinimalMeta(),
      );
      expect(row.StatusCode).toBe(canonical);
    });

    it("treats legacy 'STATUS_CODE_ERROR' as an error for pricing (cost = 0)", () => {
      // Before normalization, isSuccess was `statusCode !== '2'`, so a span
      // whose SDK encoded the enum NAME was priced as if it succeeded.
      const row = normalizedSpanToClickHouseRow(
        createMinimalSpan({
          model: "gpt-4",
          inputTokens: 1000,
          outputTokens: 500,
          statusCode: "STATUS_CODE_ERROR",
        }),
        createMinimalMeta(),
      );
      expect(row.StatusCode).toBe("2");
      expect(row.Cost).toBe(0);
    });
  });

  describe("timestamp conversions", () => {
    it("should convert startTime to nanoseconds when given milliseconds", () => {
      const span = createMinimalSpan({ startTime: 1700000000000 });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      // 1700000000000 ms * 1000000 = 1700000000000000000 ns
      expect(row.Timestamp).toBe(1700000000000000000);
    });

    it("should convert endTime to nanoseconds when given milliseconds", () => {
      const span = createMinimalSpan({
        startTime: 1700000000000,
        endTime: 1700000000100,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.EndTime).toBe(1700000000100000000);
    });

    it("should set EndTime to 0 when endTime is undefined", () => {
      const span = createMinimalSpan({ endTime: undefined });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.EndTime).toBe(0);
    });

    it("should truncate duration to integer when given decimal", () => {
      const span = createMinimalSpan({ duration: 150.5 });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Duration).toBe(150);
    });
  });

  describe("basic field mapping", () => {
    it("should map all basic span fields to ClickHouse columns when all fields provided", () => {
      const span = createMinimalSpan({
        traceId: "my-trace-id",
        spanId: "my-span-id",
        parentSpanId: "parent-span-id",
        traceState: "vendor=value",
        name: "my-operation",
        kind: "CLIENT",
        semanticKind: "llm",
        serviceName: "my-service",
        statusCode: "1",
        statusMessage: "OK",
        type: SpanType.GENERATION,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.TraceId).toBe("my-trace-id");
      expect(row.SpanId).toBe("my-span-id");
      expect(row.ParentSpanId).toBe("parent-span-id");
      expect(row.TraceState).toBe("vendor=value");
      expect(row.SpanName).toBe("my-operation");
      expect(row.SpanKind).toBe("llm");
      expect(row.ServiceName).toBe("my-service");
      expect(row.StatusCode).toBe("1");
      expect(row.StatusMessage).toBe("OK");
      expect(row.Type).toBe("GENERATION");
    });

    it("should use empty strings for optional fields when not provided", () => {
      const span = createMinimalSpan({
        parentSpanId: undefined,
        traceState: undefined,
        serviceName: undefined,
        statusMessage: undefined,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.ParentSpanId).toBe("");
      expect(row.TraceState).toBe("");
      expect(row.ServiceName).toBe("");
      expect(row.StatusMessage).toBe("");
    });
  });

  describe("tenant metadata", () => {
    it("should include tenant metadata in row when UserMeta provided", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta({
        appId: "my-app",
        tenantId: "my-tenant",
        stripeCustomerId: "cus_stripe123",
      });

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.AppId).toBe("my-app");
      expect(row.TenantId).toBe("my-tenant");
      expect(row.StripeCustomerId).toBe("cus_stripe123");
    });
  });

  describe("attributes conversion", () => {
    it("should convert resourceAttributes to string map when attributes have various types", () => {
      const span = createMinimalSpan({
        resourceAttributes: {
          "service.name": "my-service",
          "service.version": "1.0.0",
          count: 42,
          enabled: true,
        },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.ResourceAttributes).toEqual({
        "service.name": "my-service",
        "service.version": "1.0.0",
        count: "42",
        enabled: "true",
      });
    });

    it("should convert spanAttributes to string map when numeric values present", () => {
      const span = createMinimalSpan({
        spanAttributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.SpanAttributes["http.method"]).toBe("GET");
      expect(row.SpanAttributes["http.status_code"]).toBe("200");
    });

    it("should convert null and undefined attribute values to empty strings", () => {
      const span = createMinimalSpan({
        resourceAttributes: {
          nullValue: null,
          undefinedValue: undefined,
        },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.ResourceAttributes.nullValue).toBe("");
      expect(row.ResourceAttributes.undefinedValue).toBe("");
    });

    it("should JSON stringify object attribute values when nested objects present", () => {
      const span = createMinimalSpan({
        resourceAttributes: {
          nested: { key: "value", num: 123 },
          array: [1, 2, 3],
        },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.ResourceAttributes.nested).toBe('{"key":"value","num":123}');
      expect(row.ResourceAttributes.array).toBe("[1,2,3]");
    });
  });

  describe("events conversion", () => {
    it("should convert events to parallel arrays when multiple events present", () => {
      const span = createMinimalSpan({
        events: [
          { timestamp: 1700000000000, name: "event1", attributes: { key1: "value1" } },
          { timestamp: 1700000000050, name: "event2", attributes: { key2: "value2" } },
        ],
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row["Events.Timestamp"]).toEqual([1700000000000000000, 1700000000050000000]);
      expect(row["Events.Name"]).toEqual(["event1", "event2"]);
      expect(row["Events.Attributes"]).toEqual([{ key1: "value1" }, { key2: "value2" }]);
    });

    it("should return empty arrays when events array is empty", () => {
      const span = createMinimalSpan({ events: [] });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row["Events.Timestamp"]).toEqual([]);
      expect(row["Events.Name"]).toEqual([]);
      expect(row["Events.Attributes"]).toEqual([]);
    });
  });

  describe("links conversion", () => {
    it("should convert links to parallel arrays when multiple links present", () => {
      const span = createMinimalSpan({
        links: [
          { traceId: "trace1", spanId: "span1", traceState: "state1", attributes: { a: "1" } },
          { traceId: "trace2", spanId: "span2", attributes: { b: "2" } },
        ],
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row["Links.TraceId"]).toEqual(["trace1", "trace2"]);
      expect(row["Links.SpanId"]).toEqual(["span1", "span2"]);
      expect(row["Links.TraceState"]).toEqual(["state1", ""]);
      expect(row["Links.Attributes"]).toEqual([{ a: "1" }, { b: "2" }]);
    });
  });

  describe("generation fields", () => {
    it("should map token counts to row when all token fields provided", () => {
      const span = createMinimalSpan({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 10,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.InputTokens).toBe(100);
      expect(row.OutputTokens).toBe(50);
      expect(row.TotalTokens).toBe(150);
      expect(row.ReasoningTokens).toBe(10);
    });

    it("should default token counts to 0 when token fields not provided", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.InputTokens).toBe(0);
      expect(row.OutputTokens).toBe(0);
      expect(row.TotalTokens).toBe(0);
      expect(row.ReasoningTokens).toBe(0);
    });

    it("should map model and finish reason when both provided", () => {
      const span = createMinimalSpan({
        model: "gpt-4",
        finishReason: "stop",
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Model).toBe("gpt-4");
      expect(row.FinishReason).toBe("stop");
    });

    it("should JSON stringify input messages when input is array", () => {
      const testInput: Message[] = [{ role: "user", content: "Hello" }];
      const span = createMinimalSpan({
        input: testInput,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Input).toBe('[{"role":"user","content":"Hello"}]');
    });

    it("should preserve output as string when output is string", () => {
      const span = createMinimalSpan({
        output: "Hello, how can I help you?",
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Output).toBe("Hello, how can I help you?");
    });

    it("should JSON stringify outputObject when outputObject is provided", () => {
      const span = createMinimalSpan({
        outputObject: { result: "success", data: [1, 2, 3] },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.OutputObject).toBe('{"result":"success","data":[1,2,3]}');
    });

    it("should JSON stringify toolCalls when toolCalls array provided", () => {
      const testToolCalls: ToolCall[] = [{
        type: "tool-call",
        toolCallId: "call-123",
        toolName: "search",
        args: { query: "test" },
      }];
      const span = createMinimalSpan({
        toolCalls: testToolCalls,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.ToolCalls).toBe('[{"type":"tool-call","toolCallId":"call-123","toolName":"search","args":{"query":"test"}}]');
    });

    it("should JSON stringify settings when settings object provided", () => {
      const span = createMinimalSpan({
        settings: { temperature: 0.7, maxTokens: 1000 },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Settings).toBe('{"temperature":0.7,"maxTokens":1000}');
    });
  });

  describe("session and trace fields", () => {
    it("should map session fields to row when all session fields provided", () => {
      const span = createMinimalSpan({
        sessionId: "session-123",
        sessionName: "My Session",
        userId: "user-456",
        traceName: "My Trace",
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.SessionId).toBe("session-123");
      expect(row.SessionName).toBe("My Session");
      expect(row.UserId).toBe("user-456");
      expect(row.TraceName).toBe("My Trace");
    });
  });

  describe("props and metadata fields", () => {
    it("should map props and commit sha to the row", () => {
      const span = createMinimalSpan({
        props: '{"key":"value"}',
        commitSha: "abc123def",
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Props).toBe('{"key":"value"}');
      expect(row.CommitSha).toBe("abc123def");
    });


    it("should preserve metadata as object when metadata object provided", () => {
      const span = createMinimalSpan({
        metadata: { env: "production", version: "1.0" },
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Metadata).toEqual({ env: "production", version: "1.0" });
    });

    it("carries payload-truncation metadata into the Metadata and SpanAttributes columns", () => {
      // The ingest route records truncation as the
      // `agentmark.metadata.truncated_fields` span attribute; the normalizer
      // extracts `agentmark.metadata.*` into span.metadata. Both must land
      // in the ClickHouse row so the dashboard can badge truncated spans.
      const truncatedValue =
        "prompt prefix…[truncated by AgentMark: original 200000 bytes]";
      const span = createMinimalSpan({
        metadata: { truncated_fields: '["ai.prompt.messages"]' },
        spanAttributes: {
          "agentmark.metadata.truncated_fields": '["ai.prompt.messages"]',
          "ai.prompt.messages": truncatedValue,
        },
      });

      const row = normalizedSpanToClickHouseRow(span, createMinimalMeta());

      expect(row.Metadata).toEqual({ truncated_fields: '["ai.prompt.messages"]' });
      expect(row.SpanAttributes["agentmark.metadata.truncated_fields"]).toBe(
        '["ai.prompt.messages"]'
      );
      expect(row.SpanAttributes["ai.prompt.messages"]).toBe(truncatedValue);
    });
  });

  // Env tagging at trace ingest.
  describe("environment stamping", () => {
    it("should stamp Environment and EnvironmentVersion 0 when meta has no resolved env", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta(); // no resolvedEnv

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Environment).toBe("");
      expect(row.EnvironmentVersion).toBe(0);
    });

    it("should keep SDK-supplied CommitSha when env is legacy (no resolved env)", () => {
      const span = createMinimalSpan({ commitSha: "sdk-sha-legacy" });
      const meta = createMinimalMeta(); // no resolvedEnv

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CommitSha).toBe("sdk-sha-legacy");
    });

    it("should override SDK-supplied CommitSha with env's latest-deployment sha when env is resolved + unpinned (regression)", () => {
      // The resolver pulls `latest_deployment.commit_sha` into
      // `pinned_commit_sha` regardless of pin state. For an unpinned env this
      // is the most-recent-sync commit — server-controlled and authoritative.
      // We must NOT trust the SDK-supplied value here; callers can lie about
      // their commit but can't move the server's deploy pointer.
      const span = createMinimalSpan({ commitSha: "sdk-claimed-sha" });
      const meta = createMinimalMeta({
        resolvedEnv: {
          name: "dev",
          pinned_version: null,                  // unpinned (default/dev env)
          pinned_commit_sha: "env-latest-deploy-sha", // = latest_deployment.commit_sha
        },
      });

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Environment).toBe("dev");
      expect(row.EnvironmentVersion).toBe(0);
      // Server pointer wins over SDK-claimed sha.
      expect(row.CommitSha).toBe("env-latest-deploy-sha");
    });

    it("should stamp empty CommitSha when env is resolved but has no deployment yet", () => {
      // Fresh env with current_version=0 and latest_deployment=null. Better an
      // empty stamp than a phantom SDK-claimed sha on an env with nothing
      // deployed.
      const span = createMinimalSpan({ commitSha: "sdk-claimed-sha" });
      const meta = createMinimalMeta({
        resolvedEnv: {
          name: "staging",
          pinned_version: null,
          pinned_commit_sha: null,
        },
      });

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Environment).toBe("staging");
      expect(row.CommitSha).toBe("");
    });

    it("should override SDK-supplied CommitSha with env.pinned_commit_sha when env is pinned", () => {
      const span = createMinimalSpan({ commitSha: "sdk-sha-ignored" });
      const meta = createMinimalMeta({
        resolvedEnv: {
          name: "production",
          pinned_version: 7,
          pinned_commit_sha: "env-pinned-sha",
        },
      });

      const row = normalizedSpanToClickHouseRow(span, meta);

      // Pinned env → the triple is coherent: name, version, and the
      // authoritative pinned commit (the SDK value is discarded).
      expect(row.Environment).toBe("production");
      expect(row.EnvironmentVersion).toBe(7);
      expect(row.CommitSha).toBe("env-pinned-sha");
    });

    // Trust-but-verify matrix (prompt-version linking): an SDK-supplied sha
    // on env-resolved traffic is accepted IFF it exactly matches the server's
    // deploy pointer — which is observationally identical to stamping the
    // server pointer. These pin the verify policy alongside the
    // override/empty/legacy cases above so the full matrix lives here:
    //   resolved + matching sha   → that sha (== server pointer)
    //   resolved + mismatched sha → server pointer        (test above)
    //   resolved + no client sha  → server pointer
    //   resolved + no deployment  → ""                    (test above)
    //   unresolved + client sha   → client sha            (test above)
    //   unresolved + no sha       → ""
    it("should accept SDK-supplied CommitSha when env is resolved AND it matches the env's deploy pointer", () => {
      const span = createMinimalSpan({ commitSha: "served-commit-sha" });
      const meta = createMinimalMeta({
        resolvedEnv: {
          name: "dev",
          pinned_version: null,
          pinned_commit_sha: "served-commit-sha", // SDK echoes the served commit
        },
      });

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CommitSha).toBe("served-commit-sha");
    });

    it("should stamp the env's deploy pointer when env is resolved and the span has no CommitSha", () => {
      const span = createMinimalSpan(); // no commitSha
      const meta = createMinimalMeta({
        resolvedEnv: {
          name: "dev",
          pinned_version: null,
          pinned_commit_sha: "env-latest-deploy-sha",
        },
      });

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CommitSha).toBe("env-latest-deploy-sha");
    });

    it("should stamp empty CommitSha when env is unresolved and the span has none", () => {
      const span = createMinimalSpan(); // no commitSha
      const meta = createMinimalMeta(); // no resolvedEnv

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CommitSha).toBe("");
    });

    it("should always stamp TraceSource 'production' for gateway-resolved ingest", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.TraceSource).toBe("production");
    });
  });

  describe("CreatedAt field (billing-critical)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-19T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should include CreatedAt field in the row when span is converted", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      // Fixed clock (2026-02-19T12:00:00Z) → epoch SECONDS, not millis.
      // Pinning the exact value guards the unit (billing's toYYYYMM math
      // depends on it) and the field's presence.
      expect(row.CreatedAt).toBe(1771502400);
    });

    it("should set CreatedAt to a number when span is converted", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(typeof row.CreatedAt).toBe("number");
    });

    it("should set CreatedAt to current Unix time in seconds when span is converted", () => {
      const fixedNow = new Date("2026-02-19T12:00:00Z");
      const expectedSeconds = Math.floor(fixedNow.getTime() / 1000);
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CreatedAt).toBe(expectedSeconds);
    });

    it("should set CreatedAt in seconds not milliseconds when span is converted", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      // Unix seconds for dates up to year 2633 are below 2e10.
      // If CreatedAt were milliseconds it would be > 1e12.
      expect(row.CreatedAt).toBeLessThan(2e10);
    });

    it("should set CreatedAt to a timestamp within the current calendar month when span is converted", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      const date = new Date(row.CreatedAt * 1000);
      const rowYYYYMM = date.getUTCFullYear() * 100 + (date.getUTCMonth() + 1);
      const now = new Date("2026-02-19T12:00:00Z");
      const expectedYYYYMM = now.getUTCFullYear() * 100 + (now.getUTCMonth() + 1);
      expect(rowYYYYMM).toBe(expectedYYYYMM);
    });

    it("should not set CreatedAt to epoch zero when span is converted", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CreatedAt).not.toBe(0);
    });

    it("should not set CreatedAt to null or undefined when span is converted", () => {
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CreatedAt).not.toBeNull();
      expect(row.CreatedAt).not.toBeUndefined();
    });

    it("should set CreatedAt to a modern timestamp greater than year-2020 epoch seconds when span is converted", () => {
      // Sanity check: guards against any future regression that sets CreatedAt
      // to a value in the distant past (e.g., epoch zero = 1970-01-01).
      const year2020EpochSeconds = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
      const span = createMinimalSpan();
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.CreatedAt).toBeGreaterThan(year2020EpochSeconds);
    });
  });

  describe("cost calculation", () => {
    it("prices a model absent from the registry at cost 0 (accepted delta: no user cost maps)", () => {
      // Pricing is registry-only: a model that isn't in the registry
      // resolves to cost 0, even if a user costMap would price it non-zero.
      const span = createMinimalSpan({
        model: "custom-model",
        inputTokens: 1000,
        outputTokens: 500,
        statusCode: "1", // success
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Cost).toBe(0);
    });

    it("should set cost to 0 when span has error status", () => {
      const span = createMinimalSpan({
        model: "gpt-4",
        inputTokens: 1000,
        outputTokens: 500,
        statusCode: "2", // error status
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      // Cost should be 0 for failed spans (no priceMap lookup)
      expect(row.Cost).toBe(0);
    });

    it("should preserve original cost when model is undefined", () => {
      const span = createMinimalSpan({
        cost: 0.05,
        model: undefined,
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta);

      expect(row.Cost).toBe(0.05);
    });

    it("should compute cost into the Cost column from the registry price", () => {
      const span = createMinimalSpan({
        model: "gpt-4o",
        inputTokens: 1000,
        outputTokens: 500,
        statusCode: "1",
      });
      const meta = createMinimalMeta();

      const row = normalizedSpanToClickHouseRow(span, meta, {
        "gpt-4o": { promptPrice: 2.5, completionPrice: 10 },
      });

      // Pin the computed cost, not just its presence: a bug in the formula
      // (getCost = (promptPrice*in + completionPrice*out) / 1000) would still be
      // "defined". (2.5*1000 + 10*500) / 1000 = 7.5.
      expect(row.Cost).toBe(7.5);
    });

    describe("layered model-id resolution", () => {
      const pricingData = {
        "gpt-4o": { promptPrice: 2.5, completionPrice: 10 },
        "gpt-4o-mini": { promptPrice: 0.15, completionPrice: 0.6 },
      };

      it("prices provider-prefixed model ids against the bare registry entry", () => {
        const span = createMinimalSpan({
          model: "openai/gpt-4o",
          inputTokens: 1000,
          outputTokens: 500,
          statusCode: "1",
        });

        const row = normalizedSpanToClickHouseRow(span, createMinimalMeta(), pricingData);

        // (2.5 * 1000 + 10 * 500) / 1000 = 7.5
        expect(row.Cost).toBe(7.5);
      });

      it("prices unknown dated variants against the longest base-model prefix", () => {
        const span = createMinimalSpan({
          model: "gpt-4o-mini-2099-01-01",
          inputTokens: 1000,
          outputTokens: 1000,
          statusCode: "1",
        });

        const row = normalizedSpanToClickHouseRow(span, createMinimalMeta(), pricingData);

        // Must match gpt-4o-mini, not gpt-4o: (0.15 + 0.6) * 1000 / 1000 = 0.75
        expect(row.Cost).toBe(0.75);
      });

      it("still prices truly unknown models at 0", () => {
        const span = createMinimalSpan({
          model: "some-self-hosted-llm",
          inputTokens: 1000,
          outputTokens: 500,
          statusCode: "1",
        });

        const row = normalizedSpanToClickHouseRow(span, createMinimalMeta(), pricingData);

        expect(row.Cost).toBe(0);
      });
    });

    describe("BlobRefs column", () => {
      it("defaults to '' on a normal row (offload populates it post-build)", () => {
        const row = normalizedSpanToClickHouseRow(createMinimalSpan(), createMinimalMeta());
        expect(row.BlobRefs).toBe("");
      });

      it("does NOT populate BlobRefs from a client-supplied span attribute (server-only)", () => {
        // Security/regression: only the gateway's offload pass may set BlobRefs.
        // A caller injecting agentmark.blob_refs / agentmark.media_refs must not
        // be able to point the column at arbitrary storage keys.
        const span = createMinimalSpan({
          spanAttributes: {
            "agentmark.blob_refs": '[{"field":"Output","blob_id":"other-tenant/secret","size":1}]',
            "agentmark.media_refs": '[{"media_id":"x"}]',
          },
        });
        const row = normalizedSpanToClickHouseRow(span, createMinimalMeta());
        expect(row.BlobRefs).toBe("");
      });
    });
  });
});

describe("stripRedundantIoAttributes", () => {
  const big = (n: number) => "x".repeat(n);

  it("drops a large extracted I/O attribute (its value is offloaded via the normalized column)", () => {
    const attrs: Record<string, unknown> = { "gen_ai.response.output": big(40 * 1024) };
    const dropped = stripRedundantIoAttributes(attrs);
    expect(dropped).toBe(1);
    expect("gen_ai.response.output" in attrs).toBe(false);
  });

  it("keeps a SMALL I/O attribute in place (no change for normal traces)", () => {
    const attrs: Record<string, unknown> = { "gen_ai.response.output": "a short answer" };
    expect(stripRedundantIoAttributes(attrs)).toBe(0);
    expect(attrs["gen_ai.response.output"]).toBe("a short answer");
  });

  it("drops a SMALL media attribute (media is always offloaded — base64 must not linger inline)", () => {
    const attrs: Record<string, unknown> = {
      "agentmark.output": '[{"mimeType":"image/png","base64":"iVBORw0KGgo="}]',
    };
    expect(stripRedundantIoAttributes(attrs)).toBe(1);
    expect("agentmark.output" in attrs).toBe(false);
  });

  it("keeps a SMALL non-media attribute that merely mentions base64/mimeType in prose", () => {
    const text = "to decode base64 with a mimeType you call atob()";
    const attrs: Record<string, unknown> = { "agentmark.output": text };
    expect(stripRedundantIoAttributes(attrs)).toBe(0);
    expect(attrs["agentmark.output"]).toBe(text);
  });

  it("never touches non-I/O attributes, however large", () => {
    const attrs: Record<string, unknown> = { "custom.blob": big(40 * 1024), "gen_ai.request.model": "gpt-4o" };
    expect(stripRedundantIoAttributes(attrs)).toBe(0);
    expect(attrs["custom.blob"]).toBe(big(40 * 1024));
    expect(attrs["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("drops large input AND output (returns the count), keeps the small sibling", () => {
    const attrs: Record<string, unknown> = {
      "gen_ai.request.input": big(40 * 1024),
      "gen_ai.response.output": big(40 * 1024),
      "gen_ai.request.model": "gpt-4o",
    };
    expect(stripRedundantIoAttributes(attrs)).toBe(2);
    expect("gen_ai.request.input" in attrs).toBe(false);
    expect("gen_ai.response.output" in attrs).toBe(false);
    expect(attrs["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("measures object-valued I/O attributes by serialized size", () => {
    const attrs: Record<string, unknown> = {
      "gen_ai.output.messages": [{ role: "assistant", content: big(40 * 1024) }],
    };
    expect(stripRedundantIoAttributes(attrs)).toBe(1);
    expect("gen_ai.output.messages" in attrs).toBe(false);
  });

  it("end-to-end: a large gen_ai.response.output is kept in the Output column but dropped from SpanAttributes", () => {
    const out = big(40 * 1024);
    const span = createMinimalSpan({
      output: out,
      spanAttributes: { "gen_ai.response.output": out, "gen_ai.request.model": "gpt-4o" },
    });
    const row = normalizedSpanToClickHouseRow(span, createMinimalMeta());
    expect(row.Output).toBe(out); // normalized column preserves it (offload lifts it later)
    expect(row.SpanAttributes["gen_ai.response.output"]).toBeUndefined(); // redundant raw copy dropped
    expect(row.SpanAttributes["gen_ai.request.model"]).toBe("gpt-4o"); // other attrs intact
  });
});
