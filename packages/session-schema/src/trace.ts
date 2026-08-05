// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { AgentSession } from "./schema.js";

/**
 * The trace span contract — the ONE definition of a session's renderable
 * span-tree, shared by every consumer so a session looks identical everywhere:
 *  - the local viewer renders it from the SQLite `SessionDetail`,
 *  - the cloud ingest maps `AgentSession` → this shape → `otel_traces`,
 *  - the dashboard trace viewer renders it.
 *
 * Field names match the OSS trace viewer's `SpanData`
 * (`@agentmark-ai/ui-components`): a FLAT list per trace, nested via `parentId`.
 */
export interface SpanData {
  id: string;
  name: string;
  parentId?: string; // the nesting field — the tree is built from this
  timestamp: number;
  duration: number;
  data: {
    type?: "GENERATION" | "SPAN" | "EVENT";
    kind?: "session" | "turn" | "tool" | "thinking" | "subagent" | "event";
    role?: "user" | "assistant";
    model?: string;
    cost?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    status?: "ok" | "error" | "rejected";
    text?: string;
    thinking?: string;
    file?: string;
    errorSignature?: string;
    input?: string;
    output?: string;
    isSubagent?: boolean;
    captureTier?: string;
    [key: string]: unknown;
  };
}

export interface TraceData {
  id: string;
  name: string;
  spans: SpanData[];
  data: Record<string, unknown>;
}

/**
 * The normalized mapping INPUT. A structural shape both sides already produce:
 * the local `SessionDetail` (SQLite query result) satisfies it directly, and
 * `agentSessionToTraceSession` produces it from the canonical `AgentSession`.
 * Tool I/O is already string-rendered here (bounded) — the mapping never sees
 * raw payloads, so local and cloud can't diverge on serialization.
 */
export interface TraceToolCall {
  name: string;
  status: string;
  isEdit?: number | boolean;
  file?: string | null;
  errorSignature?: string | null;
  durationMs?: number | null;
  input?: string | null;
  output?: string | null;
}
export interface TraceTurn {
  role: string;
  model?: string | null;
  costUsd?: number | null;
  ts?: string | null;
  durationMs?: number | null;
  text?: string | null;
  thinking?: string | null;
  toolCalls: TraceToolCall[];
}
export interface TraceSession {
  id: string;
  title?: string | null;
  project?: string | null;
  model?: string | null;
  costUsd?: number | null;
  startedAt: string;
  endedAt?: string | null;
  captureTier: string;
  agentId?: string | null;
  isSubagent?: number | boolean;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  turns: TraceTurn[];
  subagents: TraceSession[];
}

const tsOf = (iso: string | null | undefined, fallback: number): number => {
  if (!iso) return fallback;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : fallback;
};
const truthy = (v: number | boolean | undefined): boolean => v === true || v === 1;

/**
 * THE mapping: a session (and its nested subagents) → one flat span tree.
 *   session (root)
 *     └─ turn span (assistant/user)
 *          ├─ thinking span   (present ⇒ reasoning is never a blank row)
 *          └─ tool-call span  (one per tool call, with I/O)
 *     └─ subagent session span  (root of the child's own subtree, nested here)
 */
export function spanTreeFromSession(session: TraceSession): TraceData {
  const spans: SpanData[] = [];
  const baseTs = tsOf(session.startedAt, 0);

  const emit = (s: TraceSession, rootParent: string | undefined): void => {
    const sessionSpanId = `s:${s.id}`;
    const sub = truthy(s.isSubagent);
    spans.push({
      id: sessionSpanId,
      name: s.title || shortProject(s.project) || (sub ? "subagent" : "session"),
      ...(rootParent ? { parentId: rootParent } : {}),
      timestamp: tsOf(s.startedAt, baseTs),
      duration: Math.max(0, tsOf(s.endedAt, tsOf(s.startedAt, baseTs)) - tsOf(s.startedAt, baseTs)),
      data: {
        type: "SPAN",
        kind: sub ? "subagent" : "session",
        model: s.model ?? undefined,
        cost: s.costUsd ?? undefined,
        inputTokens: s.tokens.input,
        outputTokens: s.tokens.output,
        cacheReadTokens: s.tokens.cacheRead,
        isSubagent: sub,
        captureTier: s.captureTier,
        agentId: s.agentId ?? undefined,
      },
    });

    s.turns.forEach((t, ti) => {
      const turnSpanId = `${sessionSpanId}:t${ti}`;
      const turnTs = tsOf(t.ts, tsOf(s.startedAt, baseTs));
      spans.push({
        id: turnSpanId,
        name: t.role === "assistant" ? `assistant${t.model ? ` · ${shortModel(t.model)}` : ""}` : "user",
        parentId: sessionSpanId,
        timestamp: turnTs,
        duration: t.durationMs ?? 0,
        data: {
          type: t.role === "assistant" ? "GENERATION" : "SPAN",
          kind: "turn",
          role: t.role === "assistant" ? "assistant" : "user",
          model: t.model ?? undefined,
          cost: t.costUsd ?? undefined,
          text: t.text ?? undefined,
          thinking: t.thinking ?? undefined,
        },
      });
      if (t.thinking) {
        spans.push({
          id: `${turnSpanId}:think`,
          name: "thinking",
          parentId: turnSpanId,
          timestamp: turnTs,
          duration: 0,
          data: { type: "EVENT", kind: "thinking", thinking: t.thinking },
        });
      }
      t.toolCalls.forEach((c, ci) => {
        spans.push({
          id: `${turnSpanId}:c${ci}`,
          name: c.name,
          parentId: turnSpanId,
          timestamp: turnTs,
          duration: c.durationMs ?? 0,
          data: {
            type: "SPAN",
            kind: "tool",
            status: normStatus(c.status),
            file: c.file ?? undefined,
            errorSignature: c.errorSignature ?? undefined,
            input: c.input ?? undefined,
            output: c.output ?? undefined,
          },
        });
      });
    });

    for (const child of s.subagents) emit(child, sessionSpanId);
  };

  emit(session, undefined);
  return {
    id: session.id,
    name: session.title || shortProject(session.project) || "session",
    spans,
    data: { costUsd: session.costUsd, captureTier: session.captureTier },
  };
}

/** A parsed session plus its subagent sessions, nested (the cloud ingest builds this from the
 * `subagent.parentSessionId` links; each child may have its own children). */
export interface AgentSessionTree {
  session: AgentSession;
  children: AgentSessionTree[];
}

// Bounded to match the local store, so cloud-rendered I/O matches local.
const INPUT_CAP = 8_000;
const OUTPUT_CAP = 16_000;
function boundedString(value: unknown, cap: number): string | null {
  if (value === undefined || value === null) return null;
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value, null, 2);
    } catch {
      s = String(value);
    }
  }
  return s.length <= cap ? s : s.slice(0, cap) + `\n… [truncated ${s.length - cap} more chars]`;
}

/** Placeholder model a capture client stamps on an API-error stub turn. Never
 * a model that did work, so it is excluded here on top of the capture-side
 * exclusion — capture clients update independently, and a session captured
 * by one that predates that exclusion can still carry stub turns/models. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * The model that actually did the session's work, for the single-model surfaces
 * that can only show one value (the sessions list and ClickHouse both carry the
 * full `models` array and are unaffected). Ranked by assistant-turn count, then
 * by summed output tokens, then lexicographically — each tiebreak deterministic
 * so the result never depends on turn order. Falls back to the first non-stub
 * entry in `models` when no turn carries a model (a redacted capture tier may
 * ship without turn detail).
 */
export function dominantModel(session: AgentSession): string | null {
  const stats = new Map<string, { turns: number; outTokens: number }>();
  for (const turn of session.turns) {
    if (turn.role !== "assistant" || !turn.model || turn.model === SYNTHETIC_MODEL) continue;
    const stat = stats.get(turn.model) ?? { turns: 0, outTokens: 0 };
    stat.turns += 1;
    stat.outTokens += turn.usage?.out ?? 0;
    stats.set(turn.model, stat);
  }
  if (stats.size === 0) return session.models.find((m) => m !== SYNTHETIC_MODEL) ?? null;

  let best: string | null = null;
  let bestTurns = -1;
  let bestOutTokens = -1;
  for (const [model, stat] of stats) {
    const better =
      stat.turns > bestTurns ||
      (stat.turns === bestTurns && stat.outTokens > bestOutTokens) ||
      (stat.turns === bestTurns && stat.outTokens === bestOutTokens && best !== null && model < best);
    if (better) {
      best = model;
      bestTurns = stat.turns;
      bestOutTokens = stat.outTokens;
    }
  }
  return best;
}

/**
 * Canonical entry: normalize a parsed `AgentSession` (+ nested subagents) into
 * `TraceSession`. This is what the cloud converter calls, so cloud and local
 * feed the identical `spanTreeFromSession`.
 */
export function agentSessionToTraceSession(node: AgentSessionTree): TraceSession {
  const s = node.session;
  return {
    id: s.id,
    title: s.title ?? null,
    project: s.env.gitRepo ?? s.env.cwd ?? null,
    model: dominantModel(s),
    costUsd: s.totals.costUsd ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    captureTier: s.captureTier,
    agentId: s.subagent?.agentId ?? null,
    isSubagent: s.subagent ? 1 : 0,
    tokens: {
      input: s.totals.inputTokens,
      output: s.totals.outputTokens,
      cacheRead: s.totals.cacheReadTokens,
      cacheCreation: s.totals.cacheCreationTokens,
    },
    turns: s.turns.map((t) => ({
      role: t.role,
      model: t.model ?? null,
      costUsd: t.costUsd ?? null,
      ts: t.ts ?? null,
      durationMs: t.durationMs ?? null,
      text: t.text ?? null,
      thinking: t.thinking ?? null,
      toolCalls: t.toolCalls.map((c) => ({
        name: c.name,
        status: c.status,
        isEdit: c.isEdit,
        file: c.file ?? null,
        errorSignature: c.errorSignature ?? null,
        durationMs: c.durationMs ?? null,
        input: boundedString(c.input, INPUT_CAP),
        output: boundedString(c.output, OUTPUT_CAP),
      })),
    })),
    subagents: node.children.map(agentSessionToTraceSession),
  };
}

/** Convenience: canonical AgentSession tree → span tree in one call. */
export function agentSessionToTrace(node: AgentSessionTree): TraceData {
  return spanTreeFromSession(agentSessionToTraceSession(node));
}

function normStatus(s: string): "ok" | "error" | "rejected" {
  return s === "error" || s === "rejected" ? s : "ok";
}
function shortProject(p: string | null | undefined): string {
  if (!p) return "";
  return p.includes("/") ? p.split("/").filter(Boolean).slice(-2).join("/") : p;
}
function shortModel(m: string): string {
  return m.replace(/^.*\//, "");
}
