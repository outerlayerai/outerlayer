/**
 * readVerificationSpans: the production ClickHouse read behind verification
 * facts. Pins the query's load-bearing shape (Input left-slice, Output
 * RIGHT-slice — the runner's verdict summary prints at the end), the
 * row → TimelineSpan projection across every field fallback, and the
 * (session order, row order) sort that makes refs meaningful.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readVerificationSpans } from "../span-source";

type Row = {
  TraceId: string;
  SpanName: string;
  StatusMessage: string | null;
  Input: string | null;
  Output: string | null;
  Metadata: Record<string, string> | null;
};

function chQueryOf(rows: Row[]) {
  return vi.fn<(sql: string, params: Record<string, unknown>) => Promise<Row[]>>(
    async () => rows,
  );
}

function bashRow(over: Partial<Row> = {}): Row {
  return {
    TraceId: "t1",
    SpanName: "agent.tool.Bash",
    StatusMessage: "",
    Input: JSON.stringify([{ role: "user", content: '{"command":"vitest run"}' }]),
    Output: " Tests  20 passed (20)",
    Metadata: { turnIndex: "61", toolName: "Bash", toolStatus: "ok" },
    ...over,
  };
}

describe("readVerificationSpans", () => {
  it("returns [] for zero trace ids without querying at all", async () => {
    const chQuery = chQueryOf([]);
    await expect(readVerificationSpans(chQuery, [])).resolves.toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it("sends the span query with the trace ids and the load-bearing slices", async () => {
    const chQuery = chQueryOf([]);
    await readVerificationSpans(chQuery, ["t1", "t2"]);

    expect(chQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = chQuery.mock.calls[0]!;
    expect(params).toEqual({ traceIds: ["t1", "t2"] });
    expect(sql).toContain("FROM otel_traces");
    expect(sql).toContain("SpanName LIKE 'agent.tool.%'");
    expect(sql).toContain("TraceId IN {traceIds:Array(String)}");
    // Input keeps the START (commands live there); Output keeps the END
    // (test-runner summaries print last — the signal failure detection reads).
    expect(sql).toContain("substringUTF8(Input, 1, 4096)");
    expect(sql).toContain("substringUTF8(Output, greatest(1, lengthUTF8(Output) - 8191))");
    expect(sql).toContain("ORDER BY Timestamp ASC, SpanName ASC");
  });

  it("projects a command span with every field mapped exactly", async () => {
    const chQuery = chQueryOf([
      bashRow({
        StatusMessage: "assertion failed",
        Metadata: { turnIndex: "61", toolName: "Bash", toolStatus: "error" },
      }),
    ]);
    await expect(readVerificationSpans(chQuery, ["t1"])).resolves.toEqual([
      {
        sessionIndex: 0,
        turnIndex: 61,
        toolName: "Bash",
        status: "error",
        isEdit: false,
        errorSignature: "assertion failed",
        command: '{"command":"vitest run"}',
        output: " Tests  20 passed (20)",
      },
    ]);
  });

  it("projects an edit span: isEdit flag, file, and rejected status", async () => {
    const chQuery = chQueryOf([
      bashRow({
        SpanName: "agent.tool.Edit",
        Input: null,
        Output: null,
        Metadata: {
          turnIndex: "7",
          toolName: "Edit",
          toolStatus: "rejected",
          isEdit: "1",
          file: "src/lib/a.ts",
        },
      }),
    ]);
    await expect(readVerificationSpans(chQuery, ["t1"])).resolves.toEqual([
      {
        sessionIndex: 0,
        turnIndex: 7,
        toolName: "Edit",
        status: "rejected",
        isEdit: true,
        file: "src/lib/a.ts",
      },
    ]);
  });

  it("falls back per field: span-name tool, null turn, ok status, raw non-JSON input", async () => {
    const chQuery = chQueryOf([
      bashRow({
        SpanName: "agent.tool.Grep",
        StatusMessage: null,
        Input: "not json at all",
        Output: "",
        Metadata: null,
      }),
    ]);
    await expect(readVerificationSpans(chQuery, ["t1"])).resolves.toEqual([
      {
        sessionIndex: 0,
        turnIndex: null,
        toolName: "Grep",
        status: "ok",
        isEdit: false,
        command: "not json at all",
      },
    ]);
  });

  it("omits command when the input envelope carries no string content", async () => {
    const chQuery = chQueryOf([
      bashRow({ Input: JSON.stringify([{ role: "user", content: 42 }]) }),
      bashRow({ Input: "" }),
    ]);
    const spans = await readVerificationSpans(chQuery, ["t1"]);
    expect(spans.map((s) => s.command)).toEqual([undefined, undefined]);
  });

  it("degrades a non-numeric turnIndex to null, never NaN", async () => {
    const chQuery = chQueryOf([
      bashRow({ Metadata: { turnIndex: "not-a-number", toolName: "Bash", toolStatus: "ok" } }),
    ]);
    const spans = await readVerificationSpans(chQuery, ["t1"]);
    expect(spans[0]!.turnIndex).toEqual(null);
  });

  it("drops rows whose trace id was not requested", async () => {
    const chQuery = chQueryOf([bashRow({ TraceId: "intruder" }), bashRow()]);
    const spans = await readVerificationSpans(chQuery, ["t1"]);
    expect(spans.map((s) => s.sessionIndex)).toEqual([0]);
  });

  it("orders by session position first, preserving row order within a session", async () => {
    const chQuery = chQueryOf([
      bashRow({ TraceId: "t2", Metadata: { turnIndex: "5", toolName: "Bash", toolStatus: "ok" } }),
      bashRow({ TraceId: "t1", Metadata: { turnIndex: "9", toolName: "Bash", toolStatus: "ok" } }),
      bashRow({ TraceId: "t2", Metadata: { turnIndex: "6", toolName: "Bash", toolStatus: "ok" } }),
      bashRow({ TraceId: "t1", Metadata: { turnIndex: "1", toolName: "Bash", toolStatus: "ok" } }),
    ]);
    const spans = await readVerificationSpans(chQuery, ["t1", "t2"]);
    expect(spans.map((s) => [s.sessionIndex, s.turnIndex])).toEqual([
      [0, 9],
      [0, 1],
      [1, 5],
      [1, 6],
    ]);
  });
});
