// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Codex CLI source adapter. Rollout files live at
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * one line per event: `{ timestamp, type, payload }` with
 *   session_meta                        → id, cwd, cli_version, originator
 *   turn_context                        → model for subsequent turns
 *   event_msg/user_message              → the REAL user prompt (response_item
 *                                         user messages are mostly injected
 *                                         context/noise — skipped)
 *   response_item/message (assistant)   → assistant turns
 *   response_item/reasoning             → thinking (summary text; encrypted
 *                                         content is unreadable by design)
 *   response_item/function_call(+output)→ tool calls, resolved by call_id
 *   event_msg/token_count               → cumulative usage (info.total_token_usage)
 *
 * Mapped straight onto the canonical AgentSession — the same schema the
 * Claude Code adapter emits, so store/viewer/insights need zero changes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAgentSession, SCHEMA_VERSION, EVENT_TYPES, type AgentSession, type Turn, type ToolCall, type SessionEvent } from "@outerlayer/session-schema";
import { normalizeErrorSignature, type ParseResult } from "./claude-code/parse.js";
import { costOfUsage, isPriceKnown } from "../pricing.js";
import { WarningCollector, WARNING_CODES } from "../warnings.js";
import type { TranscriptEntry } from "./claude-code/discover.js";
import type { SourceAdapter } from "./types.js";

const TEXT_CAP = 4000;
const INPUT_CAP = 4000;
const OUTPUT_CAP = 8000;

/** Default Codex CLI session root. */
export function defaultCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Find rollout files under the codex sessions root, newest-first. */
export function findCodexRollouts(root = defaultCodexSessionsDir()): TranscriptEntry[] {
  const found: TranscriptEntry[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // missing root ⇒ [] — codex simply isn't installed
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl") && st.size > 0) {
        found.push({ file: p, mtimeMs: st.mtimeMs, bytes: st.size, isSubagent: false });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** `rollout-2026-04-23T10-35-33-<uuid>.jsonl` → the uuid (fallback session id). */
export function codexSessionIdFromPath(file: string): string {
  const stem = (file.split(/[/\\]/).pop() ?? "").replace(/\.jsonl$/, "");
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem);
  return m?.[1] ?? stem;
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface CodexParseOptions {
  fallbackId?: string;
  captureTier?: AgentSession["captureTier"];
}

export function parseCodexRollout(content: string, opts: CodexParseOptions = {}): ParseResult {
  const warnings = new WarningCollector();
  const stats = { lines: 0, parsed: 0, skipped: 0, unmapped: 0 };
  const versions = new Set<string>();
  const models = new Set<string>();

  let id = opts.fallbackId ?? "";
  let cwd: string | undefined;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let startedAt: string | undefined;
  let endMs = 0;
  let currentModel: string | undefined;
  let pendingThinking: string | undefined;
  let title: string | undefined;

  const turns: Turn[] = [];
  const events: SessionEvent[] = [];
  let seq = 0;
  let metaSeen = false;
  let subagent: { parentSessionId: string; agentId?: string } | undefined;
  let lastAssistant: Turn | null = null;
  // Real prompts come from `event_msg/user_message` in interactive (TUI)
  // rollouts. Non-interactive `codex exec` rollouts emit no such event — the
  // only record of the human ask is the `response_item` user message. We
  // capture those as PROVISIONAL user turns and keep them only when the session
  // produced no event_msg prompt, so interactive sessions (which echo each
  // prompt as BOTH a response_item AND an event_msg) never double-count.
  let eventUserTurns = 0;
  const provisionalUserTurns = new Set<Turn>();
  // call_id → the open call + its start time (durationMs on resolve)
  const openCalls = new Map<string, { call: ToolCall; startMs: number }>();
  // final cumulative usage wins
  let totals: { input: number; cached: number; output: number } | null = null;

  // one compaction writes BOTH a `compacted` line and a context_compacted
  // event, always as a 1:1 pair — count ONLY the `compacted` line (the
  // adjacent-dedupe trick claude-code uses is unsafe here: this events
  // stream is sparse, so back-to-back real compactions would collapse)
  const pushCompaction = (ts?: string): void => {
    events.push({ type: EVENT_TYPES.compaction, seq: seq++, ...(ts ? { ts } : {}) });
  };

  const rawLines = content.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i]!.trim();
    if (!trimmed) continue;
    stats.lines += 1;
    let line: RolloutLine;
    try {
      line = JSON.parse(trimmed) as RolloutLine;
    } catch {
      warnings.add(i === rawLines.length - 1 || i === rawLines.length - 2 ? WARNING_CODES.truncatedFinalLine : WARNING_CODES.malformedLine, trimmed.slice(0, 80));
      stats.skipped += 1;
      continue;
    }
    stats.parsed += 1;
    const p = line.payload ?? {};
    const tsMs = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (Number.isFinite(tsMs) && tsMs > endMs) endMs = tsMs;

    switch (line.type) {
      case "session_meta": {
        // First meta wins. `codex resume` APPENDS to the existing file (never
        // a second meta — verified against rollout recorder source), so a
        // later meta line is malformed input; ignoring it keeps the id stable.
        if (metaSeen) break;
        metaSeen = true;
        // newer schema carries both `id` (thread) and `session_id`
        if (typeof p.id === "string" && p.id) id = p.id;
        else if (typeof p.session_id === "string" && p.session_id) id = p.session_id;
        if (typeof p.timestamp === "string") startedAt = p.timestamp;
        if (typeof p.cwd === "string") cwd = p.cwd;
        if (typeof p.cli_version === "string") {
          version = p.cli_version;
          versions.add(p.cli_version);
        }
        if (typeof p.originator === "string") entrypoint = p.originator;
        // AgentControl sub-agents carry a parent thread id (only sub-agents
        // do) — same parent/child linkage claude-code subagents get
        if (typeof p.parent_thread_id === "string" && p.parent_thread_id) {
          subagent = {
            parentSessionId: p.parent_thread_id,
            ...(typeof p.agent_nickname === "string" && p.agent_nickname ? { agentId: p.agent_nickname } : {}),
          };
        }
        break;
      }
      case "turn_context": {
        if (typeof p.model === "string" && p.model) {
          currentModel = p.model;
          models.add(p.model);
        }
        break;
      }
      case "compacted": {
        pushCompaction(line.timestamp);
        break;
      }
      case "event_msg": {
        const pt = p.type;
        if (pt === "user_message" && typeof p.message === "string" && p.message.trim()) {
          const text = p.message.trim();
          turns.push({ index: turns.length, role: "user", toolCalls: [], text: text.slice(0, TEXT_CAP), ...(line.timestamp ? { ts: line.timestamp } : {}) });
          eventUserTurns += 1;
          if (!title) title = text.split("\n")[0]!.slice(0, 80);
          // a user boundary closes attribution — later token_counts must not
          // bleed back onto the previous assistant turn
          lastAssistant = null;
        } else if (pt === "token_count") {
          const info = p.info as Record<string, unknown> | null | undefined;
          const usage = info?.total_token_usage as Record<string, unknown> | undefined;
          const last = info?.last_token_usage as Record<string, unknown> | undefined;
          if (usage) {
            totals = {
              input: num(usage.input_tokens),
              cached: num(usage.cached_input_tokens),
              output: num(usage.output_tokens),
            };
          }
          // Per-turn usage is a documented APPROXIMATION (last API call of the
          // turn wins). Empirically Σ(last_token_usage) overshoots the final
          // cumulative total by 5–40% on real rollouts (aborted/retried calls
          // emit counts the authoritative total drops), so per-turn numbers
          // can't be made exact from this stream — session totals (final
          // cumulative total_token_usage) are the trustworthy figure.
          if (last && lastAssistant) {
            const cached = num(last.cached_input_tokens);
            lastAssistant.usage = {
              in: Math.max(0, num(last.input_tokens) - cached),
              out: num(last.output_tokens),
              cacheRead: cached,
              cacheCreate: 0,
            };
          }
        } else if (pt === "error") {
          events.push({ type: EVENT_TYPES.apiError, seq: seq++, ...(line.timestamp ? { ts: line.timestamp } : {}) });
        }
        break;
      }
      case "response_item": {
        const pt = p.type;
        if (pt === "message" && p.role === "assistant") {
          const text = blockText(p.content);
          const turn: Turn = {
            index: turns.length,
            role: "assistant",
            toolCalls: [],
            ...(text ? { text: text.slice(0, TEXT_CAP) } : {}),
            ...(currentModel ? { model: currentModel } : {}),
            ...(line.timestamp ? { ts: line.timestamp } : {}),
          };
          if (pendingThinking) {
            turn.thinking = pendingThinking.slice(0, TEXT_CAP);
            pendingThinking = undefined;
          }
          turns.push(turn);
          lastAssistant = turn;
        } else if (pt === "message" && p.role === "user") {
          // The human prompt as recorded in the API history. Interactive
          // rollouts ALSO emit it as event_msg/user_message (deduped below);
          // non-interactive ones don't, so this is their only prompt record.
          // Injected context (env dump, interruptions, image echoes) carries no
          // ask and is stripped.
          const text = realUserPrompt(p.content);
          if (text) {
            const turn: Turn = { index: turns.length, role: "user", toolCalls: [], text: text.slice(0, TEXT_CAP), ...(line.timestamp ? { ts: line.timestamp } : {}) };
            turns.push(turn);
            provisionalUserTurns.add(turn);
            // a user boundary closes attribution (same as event_msg prompts)
            lastAssistant = null;
          }
        } else if (pt === "reasoning") {
          const summary = Array.isArray(p.summary)
            ? p.summary
                .map((s) => (s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string" ? ((s as Record<string, unknown>).text as string) : ""))
                .filter(Boolean)
                .join("\n")
            : "";
          if (summary) pendingThinking = pendingThinking ? `${pendingThinking}\n${summary}` : summary;
        } else if (pt === "function_call") {
          const name = typeof p.name === "string" ? p.name : "unknown";
          const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
          const edit = editInfo(name, args);
          const call: ToolCall = {
            name,
            status: "ok",
            isEdit: edit.isEdit,
            ...(edit.file ? { file: edit.file } : {}),
            input: args.slice(0, INPUT_CAP),
          };
          // tool calls belong to the assistant turn that issued them; a call
          // arriving before any message opens an implicit tool-only turn
          if (!lastAssistant) {
            lastAssistant = { index: turns.length, role: "assistant", toolCalls: [], ...(currentModel ? { model: currentModel } : {}), ...(line.timestamp ? { ts: line.timestamp } : {}) };
            turns.push(lastAssistant);
          }
          lastAssistant.toolCalls.push(call);
          if (typeof p.call_id === "string") openCalls.set(p.call_id, { call, startMs: Number.isFinite(tsMs) ? tsMs : 0 });
        } else if (pt === "custom_tool_call") {
          // codex's built-in tools (apply_patch = THE edit path): input is the
          // raw patch text, not JSON arguments
          const name = typeof p.name === "string" ? p.name : "custom_tool";
          const input = typeof p.input === "string" ? p.input : "";
          const edit = name === "apply_patch" ? patchInfo(input) : { isEdit: false as const };
          const call: ToolCall = {
            name,
            status: "ok",
            isEdit: edit.isEdit,
            ...("file" in edit && edit.file ? { file: edit.file } : {}),
            ...(input ? { input: input.slice(0, INPUT_CAP) } : {}),
          };
          if (!lastAssistant) {
            lastAssistant = { index: turns.length, role: "assistant", toolCalls: [], ...(currentModel ? { model: currentModel } : {}), ...(line.timestamp ? { ts: line.timestamp } : {}) };
            turns.push(lastAssistant);
          }
          lastAssistant.toolCalls.push(call);
          if (typeof p.call_id === "string") openCalls.set(p.call_id, { call, startMs: Number.isFinite(tsMs) ? tsMs : 0 });
        } else if (pt === "function_call_output" || pt === "custom_tool_call_output") {
          const open = typeof p.call_id === "string" ? openCalls.get(p.call_id) : undefined;
          if (open) {
            let out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
            // custom_tool_call_output nests the text as JSON `{"output":"…"}`
            if (pt === "custom_tool_call_output") {
              try {
                const inner = JSON.parse(out) as Record<string, unknown>;
                if (typeof inner.output === "string") out = inner.output;
              } catch {
                /* raw string is fine */
              }
            }
            open.call.output = out.slice(0, OUTPUT_CAP);
            const exit = /(?:Process exited|exited) with (?:exit )?code (\d+)/.exec(out);
            if (exit && exit[1] !== "0") {
              open.call.status = "error";
              open.call.errorSignature = normalizeErrorSignature(firstErrorLines(out));
            } else if (pt === "custom_tool_call_output" && !out.startsWith("Success") && /\berror\b|\bfailed\b/i.test(out.slice(0, 200))) {
              open.call.status = "error";
              open.call.errorSignature = normalizeErrorSignature(out.split("\n")[0]!.slice(0, 300));
            }
            if (open.startMs > 0 && Number.isFinite(tsMs) && tsMs >= open.startMs) {
              open.call.durationMs = tsMs - open.startMs;
            }
            openCalls.delete(p.call_id as string);
          }
        } else if (pt === "web_search_call") {
          const call: ToolCall = {
            name: "web_search",
            status: "ok",
            isEdit: false,
            ...(p.action ? { input: JSON.stringify(p.action).slice(0, INPUT_CAP) } : {}),
          };
          if (lastAssistant) lastAssistant.toolCalls.push(call);
        }
        // developer response_item messages are sandbox/permissions instructions
        // injected by the harness, never a turn
        break;
      }
      default:
        stats.unmapped += 1;
        break;
    }
  }

  // Reconcile the two prompt sources: when event_msg carried the canonical
  // prompts, the provisional response_item user turns are duplicates — drop
  // them and re-index the turn sequence so `turn.index` stays contiguous
  // (it's the span-path identity downstream).
  if (eventUserTurns > 0 && provisionalUserTurns.size > 0) {
    const kept = turns.filter((t) => !provisionalUserTurns.has(t));
    turns.length = 0;
    kept.forEach((t, i) => {
      t.index = i;
      turns.push(t);
    });
  }

  // Every session gets a human title: the first real prompt's opening line.
  // event_msg prompts set it inline above; exec sessions (response_item only)
  // get it here from the first surviving user turn.
  if (!title) {
    const firstAsk = turns.find((t) => t.role === "user" && typeof t.text === "string" && t.text.trim());
    if (firstAsk?.text) title = firstAsk.text.trim().split("\n")[0]!.slice(0, 80);
  }

  if (!id || turns.length === 0) {
    // no meta and no content — nothing worth a session row
    if (turns.length === 0) {
      return { session: null, warnings: warnings.histogram(), stats, versions: [...versions].sort(), blobs: [] };
    }
  }

  // price per-turn (approximate usage → display-grade turn costs) and warn
  // only for models the registry genuinely can't price
  for (const t of turns) {
    if (t.role === "assistant" && t.model && t.usage) {
      const c = costOfUsage(t.model, t.usage);
      if (c !== null) t.costUsd = c;
    }
  }
  for (const m of models) if (!isPriceKnown(m)) warnings.add(WARNING_CODES.unknownModelCost, m);

  // session cost: EXACT when one model ran the whole session (price the
  // authoritative cumulative totals); multi-model sessions fall back to the
  // sum of approximate turn costs
  let sessionCost: number | null = null;
  const modelList = [...models];
  if (totals && modelList.length === 1 && isPriceKnown(modelList[0]!)) {
    sessionCost = costOfUsage(modelList[0]!, {
      in: Math.max(0, totals.input - totals.cached),
      out: totals.output,
      cacheRead: totals.cached,
      cacheCreate: 0,
    });
  } else if (modelList.length > 1) {
    const turnCosts = turns.map((t) => t.costUsd).filter((c): c is number => typeof c === "number");
    if (turnCosts.length > 0) sessionCost = turnCosts.reduce((a, b) => a + b, 0);
  }

  const session: AgentSession = {
    schemaVersion: SCHEMA_VERSION,
    id,
    agent: { type: "codex", ...(version ? { version } : {}), ...(entrypoint ? { entrypoint } : {}) },
    ...(subagent ? { subagent } : {}),
    env: { ...(cwd ? { cwd } : {}) },
    startedAt: startedAt ?? (endMs > 0 ? new Date(endMs).toISOString() : new Date(0).toISOString()),
    ...(endMs > 0 ? { endedAt: new Date(endMs).toISOString() } : {}),
    models: [...models].sort(),
    turns,
    events,
    totals: {
      inputTokens: totals ? Math.max(0, totals.input - totals.cached) : 0,
      outputTokens: totals ? totals.output : 0,
      cacheReadTokens: totals ? totals.cached : 0,
      cacheCreationTokens: 0,
      costUsd: sessionCost !== null ? Math.round(sessionCost * 100) / 100 : null,
    },
    ...(title ? { title } : {}),
    captureTier: opts.captureTier ?? "full",
    warnings: warnings.toArray(),
  };

  const validated = parseAgentSession(session);
  return { session: validated, warnings: warnings.histogram(), stats, versions: [...versions].sort(), blobs: [] };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function blockText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string" ? ((b as Record<string, unknown>).text as string) : ""))
    .filter(Boolean)
    .join("\n");
}

// Codex prepends a self-contained context block to the first user message.
const CONTEXT_WRAPPER = /^\s*<(environment_context|user_instructions|user_shell)>[\s\S]*?<\/\1>\s*/i;
// Harness-noise user messages that carry no ask: interruption notices, UI
// action echoes, injected reminders, bare image references, and any context
// block left un-stripped above (e.g. an unclosed wrapper).
const NOISE_PREFIX = /^\s*<(turn_aborted|user_action|system[_-]reminder|permissions|image|environment_context|user_instructions|user_shell)\b/i;

/** The human ask inside a `response_item` user message, or "" if the message is
 * pure injected context / harness noise. Strips a leading context wrapper so a
 * prompt appended after one still surfaces. */
function realUserPrompt(content: unknown): string {
  let text = blockText(content).trim();
  let prev: string;
  do {
    prev = text;
    text = text.replace(CONTEXT_WRAPPER, "").trim();
  } while (text !== prev);
  if (!text || NOISE_PREFIX.test(text)) return "";
  return text;
}

/** apply_patch input is raw patch text naming files as
 * `*** Update|Add|Delete File: <path>` — first named file wins. */
function patchInfo(patch: string): { isEdit: true; file?: string } {
  const m = /\*{3} (?:Update|Add|Delete) File: ([^\n]+)/.exec(patch);
  return { isEdit: true, ...(m?.[1] ? { file: m[1].trim() } : {}) };
}

/** Codex edits also land as exec_command running an `apply_patch` heredoc, or
 * plain shell redirection — flag the detectable ones. */
function editInfo(name: string, args: string): { isEdit: boolean; file?: string } {
  const isPatch = name === "apply_patch" || ((name === "exec_command" || name === "shell") && args.includes("apply_patch"));
  if (!isPatch) return { isEdit: false };
  const m = /\*{3} (?:Update|Add|Delete) File: ([^\\"\n]+)/.exec(args);
  return { isEdit: true, ...(m?.[1] ? { file: m[1].trim() } : {}) };
}

/** First interesting lines of a failed command's output (skip the chunk
 * header codex prepends), for error-signature normalization. */
function firstErrorLines(out: string): string {
  const lines = out.split("\n").filter((l) => l.trim() && !/^(Chunk ID:|Wall time:|Original token count:|Total output lines:|Output:)/.test(l));
  const afterExit = lines.filter((l) => !/exited with (?:exit )?code/.test(l));
  return (afterExit.slice(-3).join(" ") || lines.slice(-3).join(" ")).slice(0, 300);
}

export const codexAdapter: SourceAdapter = {
  id: "codex",
  discover(roots) {
    return findCodexRollouts(roots.codexRoot ?? defaultCodexSessionsDir());
  },
  parse(entry, opts) {
    return parseCodexRollout(readFileSync(entry.file, "utf8"), {
      fallbackId: codexSessionIdFromPath(entry.file),
      ...(opts.captureTier ? { captureTier: opts.captureTier } : {}),
    });
  },
};
