"use client";

/**
 * Session timeline — the waterfall over the session's turn/tool spans,
 * answering the question the transcript hides: where did the time (and the
 * stalls) actually go. Same spans the transcript renders; no extra fetch.
 *
 * Each row is a native disclosure: collapsed, it carries a one-line preview of
 * what the span actually did (the Bash command, the file touched, the words
 * spoken); opening it reveals the span's full input/output, timing, cost and
 * model. So a wide bar is never an anonymous "assistant" you can't trace back —
 * you can see, and drill into, the thing that ate the time.
 *
 * The axis is GAP-COMPRESSED. A session's wall clock is often hours or days
 * but almost all of it is idle (the user stepped away, the run resumed); on a
 * raw time axis every operation collapses into the first pixel and the "wall
 * clock" bar is an empty column with a smear on the left. So idle stretches
 * between consecutive spans are capped to a small spacer while span durations
 * stay at true scale: the active work spreads across the axis in chronological
 * order, long steps read wide, short ones read short, and the gaps between
 * bursts read as gaps without eating the row. The header still reports the true
 * wall clock so the compression is never hidden.
 *
 * Timing honesty: sessions whose transcript carried per-turn timestamps get a
 * real waterfall. Sessions without them were ingested with synthetic 1ms
 * cursor spacing (the converter never invents meaningful-looking durations) —
 * those render as ordered slivers, which is the truthful picture.
 */
import { Box, Typography } from "@mui/material";
import { useState } from "react";
import type { SyntheticEvent } from "react";
import { agentColor, compactNum, fmtMs, money, shortModel } from "./agent-format";
import type { AgentSpan } from "../types";

const COLORS = {
  user: "#8A8F98",
  assistant: "#2065D1",
  tool: "#0E7490",
  hook: "#9F1239",
  error: "#B42318",
} as const;

// Fixed columns bracket the flexible bar track; keeping them constant across
// every row is what makes the bars share one time axis you can read down. The
// text columns are kept tight so the bar track — the point of the view — gets
// the bulk of the row width rather than being squeezed into a sliver on the right.
const LABEL_W = 124;
const PREVIEW_W = 200;
const DUR_W = 60;

function rowColor(span: AgentSpan): string {
  if (span.statusCode === "2") return COLORS.error;
  if (span.name === "agent.turn.user") return COLORS.user;
  if (span.name === "agent.turn.assistant") return COLORS.assistant;
  if (isHook(span)) return COLORS.hook;
  return COLORS.tool;
}

function rowLabel(span: AgentSpan): string {
  if (span.name.startsWith("agent.turn.")) return span.name.replace("agent.turn.", "");
  if (isHook(span)) return `${span.name.replace("agent.hook.", "").replace(/_/g, " ")} hook`;
  return span.name.replace("agent.tool.", "");
}

const isTool = (s: AgentSpan): boolean => s.name.startsWith("agent.tool.");
const isHook = (s: AgentSpan): boolean => s.name.startsWith("agent.hook.");

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Tool inputs usually arrive as a JSON arg object; surface the field that says
// what the call did rather than dumping the raw payload into the row preview.
const TOOL_INPUT_KEYS = ["command", "description", "prompt", "query", "pattern", "file_path", "path", "url", "content"] as const;

/** One-line hint of what a span actually did, for the collapsed row. */
function previewText(span: AgentSpan): string {
  if (isHook(span)) return span.metadata.hookCommand ?? "";
  if (isTool(span) && span.metadata.file) return span.metadata.file;
  const raw = span.input ?? span.output ?? "";
  if (!raw) return "";
  if (raw[0] === "{") {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const k of TOOL_INPUT_KEYS) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return oneLine(v);
      }
    } catch {
      /* not JSON — fall through to the raw text */
    }
  }
  return oneLine(raw);
}

function LabeledBlock({ label, body }: { label: string; body: string }) {
  return (
    <Box sx={{ mt: 0.75 }}>
      <Typography sx={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em", color: "text.disabled", mb: 0.25 }}>{label}</Typography>
      <Typography
        component="pre"
        sx={{
          m: 0,
          fontFamily: "monospace",
          fontSize: 11.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 280,
          overflow: "auto",
          bgcolor: "#FBFAF6",
          border: "1px solid #EEEAE0",
          borderRadius: 1,
          p: 1,
        }}
      >
        {body.slice(0, 4000)}
      </Typography>
    </Box>
  );
}

/** The drill-in for one span: what it was, when it ran, how long, and its I/O. */
function RowDetail({ span, offsetMs }: { span: AgentSpan; offsetMs: number }) {
  const dur = span.durationMs ?? 0;
  const durText = span.metadata.durationUnreported ? "—" : dur ? fmtMs(dur) : "0ms";
  const timing = [span.name, `+${fmtMs(offsetMs)}`, durText].join("  ·  ");
  const stats: string[] = [];
  if (span.model) stats.push(shortModel(span.model));
  if (span.cost) stats.push(money(span.cost));
  if (span.inputTokens || span.outputTokens) stats.push(`${compactNum(span.inputTokens)}→${compactNum(span.outputTokens)} tok`);
  const hasIO = Boolean(span.input || span.output || span.statusMessage);
  return (
    <Box sx={{ ml: `${LABEL_W + 8}px`, mt: 0.5, mb: 1, p: 1.25, border: "1px solid #E4E0D6", borderRadius: 1, bgcolor: "#fff" }}>
      <Typography sx={{ fontFamily: "monospace", fontSize: 11, color: "text.secondary" }}>{timing}</Typography>
      {stats.length > 0 && (
        <Typography sx={{ fontFamily: "monospace", fontSize: 11, color: "text.disabled", mt: 0.25 }}>{stats.join("  ·  ")}</Typography>
      )}
      {isTool(span) && span.metadata.file && (
        <Typography sx={{ fontFamily: "monospace", fontSize: 11.5, color: "text.secondary", mt: 0.5, wordBreak: "break-all" }}>{span.metadata.file}</Typography>
      )}
      {span.statusCode === "2" && span.statusMessage && (
        <Typography sx={{ fontSize: 12, color: COLORS.error, mt: 0.75, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{span.statusMessage.slice(0, 800)}</Typography>
      )}
      {span.input && <LabeledBlock label="input" body={span.input} />}
      {span.output && <LabeledBlock label="output" body={span.output} />}
      {!hasIO && <Typography sx={{ fontSize: 12, color: "text.disabled", mt: 0.5 }}>No captured input or output for this span.</Typography>}
    </Box>
  );
}

/** Minimum gap spacer (ms) when the session has no typical step to size against. */
const GAP_FLOOR_MS = 1000;

/**
 * One waterfall row. The drill-in (`RowDetail`) is mounted only once the row is
 * opened — a big session has thousands of rows, and rendering every span's
 * input/output up front (even hidden inside a collapsed <details>) floods the
 * DOM with text nodes. `leftPct`/`widthPct` are the span's position/length on
 * the shared compressed axis; `offsetMs` is its REAL offset from t0, for the
 * timing line in the drill-in.
 */
function TimelineRow({
  span,
  agentType,
  leftPct,
  widthPct,
  duration,
  offsetMs,
}: {
  span: AgentSpan;
  agentType: string;
  leftPct: number;
  widthPct: number;
  duration: number;
  offsetMs: number;
}) {
  const [open, setOpen] = useState(false);
  const color = rowColor(span);
  const err = span.statusCode === "2";
  const preview = previewText(span);
  return (
    <Box
      component="details"
      data-testid={`timeline-row-${span.spanId}`}
      onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
      sx={{ "&[open] .tl-caret": { transform: "rotate(90deg)" } }}
    >
      <Box
        component="summary"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          listStyle: "none",
          "&::-webkit-details-marker": { display: "none" },
          py: 0.5,
          pl: isTool(span) ? 3 : 0,
          borderRadius: 0.5,
          "&:hover": { bgcolor: "#F7F5EF" },
        }}
      >
        <Box sx={{ width: LABEL_W, flex: "none", display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
          <Box component="span" className="tl-caret" sx={{ flex: "none", width: 8, fontSize: 9, lineHeight: 1, color: "text.disabled", transition: "transform .12s" }}>
            ▸
          </Box>
          <Typography noWrap sx={{ fontFamily: "monospace", fontSize: 11.5, minWidth: 0, color: err ? COLORS.error : "text.secondary" }} title={span.name}>
            {rowLabel(span)}
          </Typography>
        </Box>
        <Typography
          noWrap
          className="tl-preview"
          sx={{ width: PREVIEW_W, flex: "none", fontFamily: "monospace", fontSize: 11, color: "text.disabled" }}
          title={preview}
        >
          {preview}
        </Typography>
        <Box
          sx={{
            position: "relative",
            flexGrow: 1,
            height: 22,
            minWidth: 120,
            // Faint baseline the bars sit on, so the axis reads as a continuous
            // track across the full row width. "1px" (not 1, which MUI sizing
            // resolves to 100%) keeps it a hairline rather than a full-height band.
            "&::before": {
              content: '""',
              position: "absolute",
              left: 0,
              right: 0,
              top: "50%",
              height: "1px",
              bgcolor: "#E4E0D6",
            },
          }}
        >
          <Box
            data-testid="timeline-bar"
            // Continuous per-span values ride inline style (an sx class per
            // unique offset/width would churn the stylesheet for every span).
            style={{
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              backgroundColor: span.name === "agent.turn.assistant" ? agentColor(agentType) : color,
            }}
            sx={{
              position: "absolute",
              top: 4,
              bottom: 4,
              minWidth: 3,
              borderRadius: 0.75,
              opacity: err ? 1 : 0.85,
              ...(err ? { outline: `1.5px solid ${COLORS.error}` } : {}),
            }}
          />
        </Box>
        <Typography sx={{ width: DUR_W, flex: "none", textAlign: "right", fontFamily: "monospace", fontSize: 11, color: "text.disabled" }}>
          {/* durationUnreported: the hook process didn't report timing — "—" is
           * honest, "0ms" would lie (it ran, just not for zero time). */}
          {span.metadata.durationUnreported ? "—" : duration ? fmtMs(duration) : "—"}
        </Typography>
      </Box>
      {open && <RowDetail span={span} offsetMs={offsetMs} />}
    </Box>
  );
}

export function SessionTimeline({ spans, agentType }: { spans: AgentSpan[]; agentType: string }) {
  const rows = spans
    .filter((s) => s.name.startsWith("agent.turn.") || s.name.startsWith("agent.tool.") || s.name.startsWith("agent.hook."))
    .map((s) => ({ span: s, start: Date.parse(s.startTime), duration: Math.max(0, s.durationMs ?? 0) }))
    .filter((r) => Number.isFinite(r.start))
    .sort((a, b) => a.start - b.start);

  if (rows.length === 0) {
    return <Typography sx={{ py: 4, color: "text.secondary", fontSize: 13 }}>No timed spans in this session.</Typography>;
  }

  const t0 = rows[0]!.start;
  const wallClock = Math.max(...rows.map((r) => r.start + r.duration), t0 + 1) - t0;

  // Cap idle gaps at a "typical step" (the median non-zero duration, floored at
  // 1s) so idle time can't dominate the axis. Lay each span onto the compressed
  // axis by advancing a cursor by (capped gap + real duration): left = when it
  // started, width = how long it ran. A plain loop keeps the accumulator local
  // to render — no escaping mutation for the React Compiler to flag.
  const durs = rows.map((r) => r.duration).filter((d) => d > 0).sort((a, b) => a - b);
  const typical = durs.length ? durs[Math.floor(durs.length / 2)]! : 0;
  const gapCap = Math.max(typical, GAP_FLOOR_MS);
  const laid: { span: AgentSpan; duration: number; left: number; offsetMs: number }[] = [];
  let cursor = 0;
  let prevEnd = rows[0]!.start;
  for (const r of rows) {
    cursor += Math.min(Math.max(r.start - prevEnd, 0), gapCap);
    laid.push({ span: r.span, duration: r.duration, left: cursor, offsetMs: r.start - t0 });
    cursor += r.duration;
    prevEnd = Math.max(prevEnd, r.start + r.duration);
  }
  const total = Math.max(cursor, 1);

  return (
    <Box>
      <Typography sx={{ fontFamily: "monospace", fontSize: 11.5, color: "text.secondary", mb: 1 }}>
        {fmtMs(wallClock)} wall clock · {rows.length} spans · idle time compressed
      </Typography>
      {laid.map(({ span, duration, left, offsetMs }) => (
        <TimelineRow
          key={span.spanId}
          span={span}
          agentType={agentType}
          leftPct={(left / total) * 100}
          widthPct={Math.max((duration / total) * 100, 0.4)}
          duration={duration}
          offsetMs={offsetMs}
        />
      ))}
    </Box>
  );
}
