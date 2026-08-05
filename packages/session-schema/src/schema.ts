// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { z } from "zod";
import { CAPTURE_TIERS, FIELD_TIERS } from "./tiers.js";

/**
 * AgentSession schema v1 — the contract every pillar reads.
 *
 * Design rules:
 *  1. Nothing agent-vendor-specific at top level; vendor quirks go in `vendor`.
 *  2. Every content-bearing field is tier-gated and marked `tier:<min>` in its
 *     description; the machine-readable source of truth is `FIELD_TIERS`.
 *  3. Unknown input never throws — parsers degrade it into `vendor` plus a
 *     `ParseWarning`. All objects are loose (unknown keys pass through) so a
 *     newer writer's additive fields survive an older reader.
 *  4. `schemaVersion` stays 1 across additive changes; only removals or
 *     meaning changes bump it.
 */
export const SCHEMA_VERSION = 1 as const;

const consumedTierPaths = new Set<string>();

/** Annotate a tier-gated field from FIELD_TIERS — throws on a path typo, so
 * the schema cannot drift from the table. */
function tiered<T extends z.ZodType>(path: string, schema: T): T {
  const tier = FIELD_TIERS[path];
  if (!tier) throw new Error(`FIELD_TIERS has no entry for "${path}"`);
  consumedTierPaths.add(path);
  return schema.describe(`tier:${tier}`) as T;
}

/** Internal — lets tests prove schema↔FIELD_TIERS consistency. */
export function _tierPathsUsedBySchema(): string[] {
  return [...consumedTierPaths].sort();
}

const isoTimestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const money = z.number().nonnegative();

/**
 * Well-known `SessionEvent.type` values (open set — writers may emit others;
 * readers must not reject unknown types). Sources, per the ADR mapping table:
 * Claude Code JSONL line types/subtypes observed across 2.1.141–2.1.198.
 */
export const EVENT_TYPES = {
  /** Context compaction (`system/compact_boundary`, `isCompactSummary`). */
  compaction: "compaction",
  /** A skill attribution appeared (`attributionSkill`). */
  skillActivated: "skill_activated",
  /** Subagent span (Task tool / sidechain / separate subagent transcript). */
  subagent: "subagent",
  /** Hook execution report (`system/stop_hook_summary`). Only `Stop` hooks
   * are recorded this way — Claude Code emits no equivalent summary for
   * PreToolUse/PostToolUse hooks. */
  hookExecuted: "hook_executed",
  /** A hook blocked continuation (`attachment/hook_blocking_error`, exit 2). */
  hookBlocked: "hook_blocked",
  /** Human sat at a permission prompt (feeds permission-stall). NO ADAPTER
   * EMITS THIS: an approved prompt leaves no record in any agent transcript,
   * and a denied one is already a `rejected` tool call. Reserved for a source
   * that can observe prompts directly (a permission hook). */
  permissionPrompt: "permission_prompt",
  /** Permission mode changed (`permission-mode`). */
  permissionModeChanged: "permission_mode_changed",
  /** Provider/API error surfaced mid-session. Claude Code writes this as a
   * stub assistant line flagged `isApiErrorMessage`; other writers use a
   * `system/api_error` line. */
  apiError: "api_error",
  /** Prompt queue operation (`queue-operation`). */
  queueOperation: "queue_operation",
  /** A pull request was linked to the session (`pr-link`). */
  prLinked: "pr_linked",
  /** User ran a local `!` command (`system/local_command`). */
  localCommand: "local_command",
} as const;
export type WellKnownEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const ParseWarningSchema = z.looseObject({
  /** Stable machine code, e.g. `unknown_line_type`, `version_newer_than_supported`,
   * `truncated_final_line`, `ambiguous_timezone`, `unknown_model_cost`. */
  code: z.string().min(1),
  /** Occurrences of this code (aggregated by parsers). */
  count: z.number().int().min(1),
  detail: tiered("warnings[].detail", z.string()).optional(),
});

export const SessionEventSchema = z.looseObject({
  /** Open set; see EVENT_TYPES for well-known values. */
  type: z.string().min(1),
  /** Transcript-order sequence — total order even when `ts` is missing. */
  seq: count,
  ts: isoTimestamp.optional(),
  /** Index into `turns` when the event is anchored to a turn. */
  turnIndex: count.optional(),
  /** Structured, content-free payload (identifiers, durations, counts).
   * Free text belongs in `vendor` or `errorText`, never here. */
  data: tiered("events[].data", z.record(z.string(), z.unknown())).optional(),
  /** Raw error/stderr text for this event (e.g. a hook's failure output).
   * Process OUTPUT, not an identifier — tiered separately from `data` so it
   * can be gated at `full` while counts/identifiers in `data` stay `redacted`. */
  errorText: tiered("events[].errorText", z.array(z.string())).optional(),
});

export const UsageSchema = z.looseObject({
  in: count,
  out: count,
  cacheRead: count,
  cacheCreate: count,
});

export const ToolCallSchema = z.looseObject({
  name: z.string().min(1),
  startTs: isoTimestamp.optional(),
  durationMs: count.optional(),
  /** `rejected` = the human denied the permission prompt. */
  status: z.enum(["ok", "error", "rejected"]),
  /** Edit/Write/MultiEdit/NotebookEdit-class tools (file mutations). */
  isEdit: z.boolean(),
  /** The provider's tool_use id for this call. Identifies an EXECUTION of the
   * run, not the code — same class as `spanId`/`seq` — so it is metrics-safe
   * and untiered. Lets a hook-wrap execution (which carries the same id from
   * the hook payload) be parented to the exact tool call it ran around,
   * instead of the session root. */
  toolUseId: z.string().optional(),
  file: tiered("turns[].toolCalls[].file", z.string()).optional(),
  /** Normalized error text (paths/line numbers/uuids stripped) — stable
   * clustering key for the error-cluster detector. Raw error text is tier:full via `output`. */
  errorSignature: tiered("turns[].toolCalls[].errorSignature", z.string()).optional(),
  input: tiered("turns[].toolCalls[].input", z.unknown()).optional(),
  output: tiered("turns[].toolCalls[].output", z.unknown()).optional(),
});

export const TurnSchema = z.looseObject({
  index: count,
  role: z.enum(["user", "assistant"]),
  ts: isoTimestamp.optional(),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  /** Cache-aware cost; null = model price unknown (never silently guessed). */
  costUsd: money.nullable().optional(),
  /** Wall-clock for the turn (`system/turn_duration`). */
  durationMs: count.optional(),
  toolCalls: z.array(ToolCallSchema),
  /** Provenance of a user turn: `human` (the developer typed it), `peer`
   * (relayed from another agent/session), or `notification` (a harness-injected
   * task event). In multi-agent harnesses peer mail and notifications arrive as
   * `role:"user"` transcript entries; this field is what separates real human
   * steering from that machine traffic. Metrics-safe (a classification, never
   * content) so it survives every capture tier. Absent on assistant turns and
   * on turns from adapters that don't classify provenance — treated as human
   * downstream so tightening never zeroes a legacy count. */
  source: z.enum(["human", "peer", "notification"]).optional(),
  /** Message text; null when captured below `full` tier. */
  text: tiered("turns[].text", z.string().nullable()).optional(),
  /** Assistant reasoning (`thinking` blocks), joined; null below `full` tier.
   * Kept distinct from `text` so the UI can render/collapse it separately and
   * so a thinking-only turn is never blank. */
  thinking: tiered("turns[].thinking", z.string().nullable()).optional(),
  /** Image attachments — REFERENCES only (sha256), never the bytes, so the
   * session stays lean and syncs cheaply. Bytes live in a blob store
   * (local blob table / cloud R2), fetched by hash. tier:full (content). */
  images: tiered(
    "turns[].images",
    z.array(z.looseObject({ mediaType: z.string(), sha256: z.string(), bytes: count.optional() })),
  ).optional(),
  /** Provider message id — the grouping key that collapses the multiple JSONL
   * lines of one logical turn (thinking/text/tool_use written separately). */
  messageId: z.string().optional(),
  /** Turn-level vendor passthrough (unknown per-line fields). */
  vendor: tiered("turns[].vendor", z.record(z.string(), z.unknown())).optional(),
});

/**
 * Where the agent ran, worker-first (attribution is per-worker, not per-human):
 * - `seat`   — a developer's own machine (CLI sync of a local session)
 * - `cloud`  — a managed cloud worker (dispatched run, eval trial)
 * - `ci`     — a CI pipeline (detected via CI env at capture time)
 * - `shared` — synced with a shared (non-actor-bound) key; origin unknown
 * Metrics-safe (never content): present at every capture tier. Ingest defaults
 * a missing value from the API key's binding (actor-bound → seat, else shared).
 */
export const WORKER_KINDS = ["seat", "cloud", "ci", "shared"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const AgentSessionSchema = z.looseObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Stable across re-parses — the source session id. */
  id: z.string().min(1),
  /** See WORKER_KINDS. Optional on the wire (additive, v1). */
  workerKind: z.enum(WORKER_KINDS).optional(),
  agent: z.looseObject({
    /** `claude-code` first; open for future adapters (cursor, copilot…). */
    type: z.string().min(1),
    version: z.string().optional(),
    /** How the agent was invoked (`cli`, `vscode`, …). */
    entrypoint: z.string().optional(),
    /** How the session was initiated: `interactive` (a human at the controls)
     * or `agent` (spawned programmatically — SDK runs, headless invocations,
     * subagent sidechains). Open string so each adapter maps its own vendor
     * fields; unset ⇒ treated as interactive downstream. */
    origin: z.string().optional(),
  }),
  /** Developer identity. `id` is a pseudonymous membership/device id and is
   * metrics-safe; `email` is redacted-tier. Optional locally. */
  actor: z
    .looseObject({
      id: z.string().optional(),
      email: tiered("actor.email", z.string()).optional(),
    })
    .optional(),
  env: z.looseObject({
    cwd: tiered("env.cwd", z.string()).optional(),
    /** Normalized git remote (`github.com/org/repo`) — the STABLE repo identity
     * (survives clones/worktrees), the app join key. Resolved from cwd at
     * capture time; a transcript never carries it. */
    gitRepo: tiered("env.gitRepo", z.string()).optional(),
    gitBranch: tiered("env.gitBranch", z.string()).optional(),
    /** HEAD commit at run time — the precise context-version key (A/B beyond
     * branch). Resolved from cwd at capture time. */
    commitSha: tiered("env.commitSha", z.string()).optional(),
    os: z.string().optional(),
  }),
  /** Present when this session IS a subagent transcript (separate file). */
  subagent: z
    .looseObject({
      agentId: z.string().optional(),
      parentSessionId: z.string().optional(),
    })
    .optional(),
  /** Present when this object is ONE PART of a chunked upload: sessions whose
   * serialized form exceeds the per-request ingest budget ship as several
   * parts, each a complete session envelope with a SUBSET of turns. Turn span
   * identity derives from each turn's own `index` (never array position), so
   * parts are idempotent by construction. `counts` are WHOLE-session numbers,
   * identical on every part — the summary row a part writes is therefore
   * byte-identical to every other part's, and replace is a no-op. */
  chunk: z
    .object({
      /** 1-based part number (diagnostics only — parts are order-independent). */
      part: z.number().int().min(1),
      of: z.number().int().min(1),
      counts: z.object({
        turns: z.number().int().min(0),
        toolCalls: z.number().int().min(0),
        errors: z.number().int().min(0),
        /** Whole-session count of user (human) turns. Optional for backward
         * compatibility — producers that predate the field omit it, and the
         * converter falls back to counting `role === 'user'` turns in the part
         * (exact for unchunked sessions; the last part wins for chunked ones,
         * which — being large — are steered regardless). */
        userTurns: z.number().int().min(0).optional(),
        /** Whole-session steering-signal counts. Same back-compat contract as
         * `userTurns`: optional, with the converter falling back to counting
         * the part's own slice when absent (exact for unchunked sessions,
         * an undercount for chunked ones from older producers). */
        rejectedToolCalls: z.number().int().min(0).optional(),
        permissionPrompts: z.number().int().min(0).optional(),
        apiErrors: z.number().int().min(0).optional(),
      }),
    })
    .optional(),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp.optional(),
  /** All models seen across turns. */
  models: z.array(z.string()),
  turns: z.array(TurnSchema),
  events: z.array(SessionEventSchema),
  totals: z.looseObject({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheCreationTokens: count,
    costUsd: money.nullable().optional(),
    wallClockMs: count.optional(),
  }),
  /** Filled natively (`pr-link` lines, `git commit` tool results) or by later
   * joins. A session can link MANY pull requests (stacked PRs, long-lived seat
   * sessions): `prs` carries every link; the scalar `prNumber`/`prUrl` mirror
   * the LAST-linked PR for readers of the scalar contract. */
  outcome: tiered(
    "outcome",
    z.looseObject({
      /** Session-wide commit SHAs (union across all PRs + unlinked work).
       * May be short (7+) hashes — consumers must prefix-match. */
      commitShas: z.array(z.string()).optional(),
      /** Last-linked PR; `prs` is the complete set. */
      prNumber: z.number().int().positive().optional(),
      prUrl: z.string().optional(),
      /** Every PR linked in the session, transcript order, deduped by number. */
      prs: z
        .array(
          z.looseObject({
            prNumber: z.number().int().positive(),
            prUrl: z.string().optional(),
            /** In-session commits attributed to THIS PR (best-effort: commits
             * observed since the previous link). May be short hashes. */
            commitShas: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    }),
  ).optional(),
  /** Session title (`ai-title`) — LLM-generated from content, hence full. */
  title: tiered("title", z.string()).optional(),
  /** Raw passthrough for anything the parser didn't recognize — never
   * dropped, never tier-classifiable, therefore full-only. */
  vendor: tiered("vendor", z.record(z.string(), z.unknown())).optional(),
  captureTier: z.enum(CAPTURE_TIERS),
  warnings: z.array(ParseWarningSchema),
});

export type ParseWarning = z.infer<typeof ParseWarningSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * The single definition of "a human steering turn", consumed by every path
 * that counts `UserTurnCount` (gateway ingest converter and CLI chunk counter)
 * so no two counts can drift. A user turn is human unless its `source` marks it
 * as peer-relayed or a harness notification. An unset `source` (other adapters,
 * transcripts parsed without provenance classification) defaults to human,
 * which matches a plain `role === "user"` count, so tightening the semantics
 * never retroactively zeroes an already-stored session's steering.
 */
export function isHumanUserTurn(turn: Turn): boolean {
  return turn.role === "user" && turn.source !== "peer" && turn.source !== "notification";
}

/** Validate unknown data as an AgentSession (throws ZodError on mismatch). */
export function parseAgentSession(data: unknown): AgentSession {
  return AgentSessionSchema.parse(data);
}

/** Non-throwing variant. */
export function safeParseAgentSession(data: unknown) {
  return AgentSessionSchema.safeParse(data);
}
