import "server-only";

import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";
import type { TimelineSpan } from "./types";

/**
 * Reads the tool-call spans behind a PR's confirmed sessions and projects
 * them to the fact layer's `TimelineSpan` shape — the production read behind
 * verification facts.
 *
 * Ordering: `traceIds` arrives in session order (the caller sorts by session
 * start); rows sort by (that order, Timestamp), and `sessionIndex` is the
 * position in `traceIds` — which is how a fact's refs map back to a trace.
 *
 * Input is left-sliced (commands live at the start); Output is RIGHT-sliced
 * because test runners print their verdict summary at the END, and the
 * summary is what failure detection reads — a left slice would keep the
 * noise and cut the signal.
 */

const INPUT_CAP = 4096;
const OUTPUT_CAP = 8192;

export async function readVerificationSpans(
  chQuery: ChQueryFn,
  traceIds: readonly string[],
): Promise<TimelineSpan[]> {
  if (traceIds.length === 0) return [];
  const rows = await chQuery(
    `SELECT TraceId, SpanName, StatusMessage,
            substringUTF8(Input, 1, ${INPUT_CAP}) AS Input,
            substringUTF8(Output, greatest(1, lengthUTF8(Output) - ${OUTPUT_CAP - 1})) AS Output,
            Metadata
     FROM otel_traces
     WHERE TraceId IN {traceIds:Array(String)}
       AND SpanName LIKE 'agent.tool.%'
     ORDER BY Timestamp ASC, SpanName ASC`,
    { traceIds: [...traceIds] },
  );

  const orderOf = new Map(traceIds.map((traceId, index) => [traceId, index]));
  const spans = rows
    .filter((row) => orderOf.has(String(row.TraceId)))
    .map((row) => toTimelineSpan(row, orderOf.get(String(row.TraceId))!));
  // Stable by construction: sort key is (session order, original row order).
  return spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.sessionIndex - b.span.sessionIndex || a.index - b.index)
    .map((entry) => entry.span);
}

/** ClickHouse's `Map(String, String)` arrives as a plain object; anything
 * else (null, arrays, non-string entries) contributes nothing. */
function metadataOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toTimelineSpan(row: Record<string, unknown>, sessionIndex: number): TimelineSpan {
  const md = metadataOf(row.Metadata);
  const toolStatus =
    md["toolStatus"] === "error" || md["toolStatus"] === "rejected" ? md["toolStatus"] : "ok";
  // Non-numeric metadata must degrade to null (no turn), never NaN — the
  // renderer filters null but would print "turn NaN".
  const turn = md["turnIndex"] !== undefined ? Number(md["turnIndex"]) : NaN;
  const input = stringOf(row.Input);
  const statusMessage = stringOf(row.StatusMessage);
  const output = stringOf(row.Output);
  let command: string | undefined;
  if (input) {
    // Ingest serializes tool input as `[{"role":"user","content":…}]`; the
    // content is what the classifier reads. A non-JSON Input is itself the
    // command (older writers).
    try {
      const parsed = JSON.parse(input) as Array<{ content?: string }>;
      if (Array.isArray(parsed) && typeof parsed[0]?.content === "string") {
        command = parsed[0].content;
      }
    } catch {
      command = input;
    }
  }
  return {
    sessionIndex,
    turnIndex: Number.isFinite(turn) ? turn : null,
    toolName: md["toolName"] ?? stringOf(row.SpanName).replace("agent.tool.", ""),
    status: toolStatus,
    isEdit: md["isEdit"] === "1",
    ...(md["file"] ? { file: md["file"] } : {}),
    ...(statusMessage ? { errorSignature: statusMessage } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(output ? { output } : {}),
  };
}
