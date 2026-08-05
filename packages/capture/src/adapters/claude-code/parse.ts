// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { createHash } from "node:crypto";
import {
  EVENT_TYPES,
  SCHEMA_VERSION,
  parseAgentSession,
  isHumanUserTurn,
  type AgentSession,
  type SessionEvent,
  type ToolCall,
  type Turn,
  type Usage,
} from "@outerlayer/session-schema";
import { costOfUsage } from "../../pricing.js";
import { WarningCollector, WARNING_CODES } from "../../warnings.js";
import { isNewerThanSupported } from "../../versions.js";

/** Edit/Write/MultiEdit/NotebookEdit-class tools (mutate files). */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const REJECTION_MARKERS = [
  "The user doesn't want to proceed",
  "[Request interrupted by user",
  "user doesn't want to take this action",
];
const TEXT_CAP = 4000;
// stop_hook_summary bounds: p99 hookCount in the wild is single digits and
// commands/errors are short shell one-liners — these are bomb-proofing caps
// against a pathological transcript, not real limits.
const HOOK_INFOS_CAP = 50;
const HOOK_COMMAND_CAP = 300;
const HOOK_ERRORS_CAP = 3;
const HOOK_ERROR_TEXT_CAP = 500;

/** A duration Claude Code claims a hook took. Anything not a finite,
 * non-negative integer (negative, NaN, Infinity, a float) is dropped rather
 * than carried as a literal value — downstream treats a missing key as "not
 * reported", which is also the right read for a value that can't be real. */
function isValidHookDurationMs(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Content markers that identify a machine-relayed peer message when a user
 * line carries no `origin` (legacy writers). A peer turn is wholly relayed —
 * wrapper, payload, and guardrail — so a single anchored match classifies it.
 * The LLM steering path keeps its own equivalent set
 * (`trace-topics` steering-facet `DROP_TURN_PATTERNS` / block strippers); the
 * two live apart because neither package depends on the other, and both must
 * classify the same relayed-message corpus as non-human — keep them in step. */
const PEER_MARKERS: readonly RegExp[] = [
  /<teammate-message/,
  /<agent-message/,
  /^Another Claude session sent a message:/,
];
/** Content markers that identify a harness notification / injected preamble
 * when a user line carries no `origin`. Same cross-path parity note as
 * {@link PEER_MARKERS}.
 *
 * `<system-reminder` is deliberately absent: this path classifies WHOLE turns,
 * and a system-reminder block routinely rides alongside genuine developer text
 * (it opens most sessions' first prompt), so matching it here would drop real
 * human steering. The LLM path can carry that pattern because it strips such
 * blocks in place, leaving whatever the developer typed. */
const NOTIFICATION_MARKERS: readonly RegExp[] = [
  /<task-notification/,
  /^\[SYSTEM NOTIFICATION/,
  /This is an automated background-task event/,
  /^Caveat: The messages below/,
  /<command-name>|<local-command-stdout>|<command-message>|<local-command-caveat>/,
  /^Base directory for this skill:/,
  /^Path to the skill:/,
  /^You are (?:the|an?)\s/,
];

/** Provenance of a captured user turn: was it typed by the developer, relayed
 * from a peer agent/session, or injected by the harness? */
type UserTurnSource = "human" | "peer" | "notification";

/**
 * Classify one user-role line's provenance. Evaluated first-match-wins:
 * `origin` is authoritative when present (modern writers stamp it); otherwise
 * `isMeta` and content markers stand in (legacy writers). A line with neither
 * signal is the developer's own prompt — the critical default that keeps
 * pre-provenance transcripts counting as human steering.
 */
function classifyUserSource(line: Line, text: string): UserTurnSource {
  const kind = line.origin?.kind;
  if (typeof kind === "string") {
    if (kind === "human") return "human";
    if (kind === "peer") return "peer";
    return "notification";
  }
  if (line.isMeta === true) return "notification";
  if (PEER_MARKERS.some((re) => re.test(text))) return "peer";
  if (NOTIFICATION_MARKERS.some((re) => re.test(text))) return "notification";
  return "human";
}

/**
 * Line types we recognize but deliberately don't map to schema entities in v1
 * (harness/UI bookkeeping). They go to `vendor.unmappedLineTypes` as counts —
 * "never dropped" — but do NOT raise `unknown_line_type` (that warning is
 * reserved for types we've genuinely never seen, so version drift is visible).
 * Surveyed 2026-07-06.
 */
const KNOWN_UNMAPPED = new Set([
  "attachment",
  "last-prompt",
  "file-history-snapshot",
  "bridge-session",
  "started",
  "result",
  "frame-link",
  "diff-summary",
  "agent-name",
]);

export interface ParseOptions {
  /** Source session id (from the file name) — used when a transcript never
   * emits `sessionId` on any line. */
  fallbackId?: string;
  /** This transcript is a subagent file (caller knows from directory depth). */
  isSubagent?: boolean;
  /** For a subagent transcript: the PARENT session's id (from the file path,
   * `.../<parent>/subagents/agent-<id>.jsonl`). A subagent's own JSONL
   * `sessionId` field is inherited from the parent, so we must NOT key the
   * subagent by it — that collides with (and clobbers) the parent's row. */
  parentSessionId?: string;
  /** The subagent's own stable id (from the filename), used as the session id
   * so it's distinct from the parent. */
  ownId?: string;
  /** Capture tier of the emitted session (default `full` — local capture). */
  captureTier?: AgentSession["captureTier"];
  /** Agent type override (default `claude-code`). */
  agentType?: string;
}

/** A captured image, kept OUT of the AgentSession (which holds only a
 * sha256 ref). Deduped by hash; the caller persists these to a blob store. */
export interface CapturedBlob {
  sha256: string;
  mediaType: string;
  /** base64-encoded bytes. */
  data: string;
  bytes: number;
}

export interface ParseResult {
  session: AgentSession | null;
  /** Warning histogram for `--verbose` reporting. */
  warnings: Record<string, number>;
  /** Total lines seen, parsed, and skipped. */
  stats: { lines: number; parsed: number; skipped: number; unmapped: number };
  /** Distinct writer versions seen. */
  versions: string[];
  /** Image bytes referenced by `turn.images[].sha256`, deduped. */
  blobs: CapturedBlob[];
}

interface Line {
  type?: string;
  subtype?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  version?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  /** How this line's prompt originated (`typed`, `queued`, `sdk`, …). `sdk`
   * marks a programmatically-driven run. */
  promptSource?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  /** How a user-role line originated in a multi-agent harness. `kind:"human"`
   * is the developer at the keyboard; `"peer"` is mail relayed from another
   * session; `"task-notification"` (or any other kind) is a harness event.
   * Absent on older writers, which predate multi-agent provenance. */
  origin?: { kind?: string } | null;
  /** `external` for a developer session; harness-internal actors differ. */
  userType?: string;
  /** Harness-injected bookkeeping text (skill preambles, caveats) surfaced as a
   * user line — never typed by the developer. */
  isMeta?: boolean;
  agentId?: string;
  attributionSkill?: string;
  attributionAgent?: string;
  /** Set on a placeholder assistant line the CLI writes when the API connection
   * drops mid-response. Its `message.model` is a stub (e.g. `<synthetic>`), not
   * a model that did any work, and its usage is all zeros. */
  isApiErrorMessage?: boolean;
  message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: unknown };
  toolUseResult?: unknown;
  // system subtypes
  durationMs?: number;
  hookCount?: number;
  /** Per-hook detail on a `stop_hook_summary` line. `durationMs` is absent
   * (never `0`) for hooks that don't report timing — a self-backgrounding
   * hook process, observed in ~40% of executions in the wild. */
  hookInfos?: { command?: string; durationMs?: number }[];
  hookErrors?: unknown[];
  toolUseID?: string;
  // event-ish
  operation?: string;
  mode?: string;
  permissionMode?: string;
  prNumber?: number;
  prUrl?: string;
  error?: { message?: string; formatted?: string; code?: string } | string;
  /** `type: "attachment"` line payload — a grab-bag of harness-internal
   * notices; only `hook_blocking_error` is mapped to a session event today. */
  attachment?: {
    type?: string;
    hookName?: string;
    hookEvent?: string;
    toolUseID?: string;
  };
}

/** Parse one Claude Code transcript (full file contents) into an AgentSession.
 * Never throws on content — malformed lines are skipped with a warning; the
 * only throw path is a truly unusable file (zero parseable records). */
export function parseTranscript(content: string, opts: ParseOptions = {}): ParseResult {
  const warnings = new WarningCollector();
  const versions = new Set<string>();
  const lines = content.split("\n");
  const stats = { lines: 0, parsed: 0, skipped: 0, unmapped: 0 };

  let sessionId = "";
  let cwd: string | undefined;
  let gitRepo: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let title: string | undefined;
  // Any line carrying `promptSource: "sdk"` marks the whole session as a
  // programmatically-driven agent run (SDK fan-out, hook automation).
  let sawSdkPromptSource = false;
  // The raw agent id from the line (`a7d9…`); distinct from opts.ownId, which
  // is the filename stem (`agent-a7d9…`) used as the session id.
  let subagentAgentId: string | undefined;
  const parentSessionId: string | undefined = opts.parentSessionId;

  const turns: Turn[] = [];
  const events: SessionEvent[] = [];
  const models = new Set<string>();
  const toolCallsById = new Map<string, { call: ToolCall; startMs?: number }>();
  const seenSubagents = new Set<string>();
  const unmappedTypes = new Map<string, number>();
  const unknownModels = new Set<string>();
  const blobs = new Map<string, CapturedBlob>(); // image bytes, deduped by sha256

  // Assistant turn accumulator: Claude Code writes one logical assistant turn
  // as several JSONL lines (thinking / text / tool_use) that share
  // `message.id`. We group by that id so a thinking-only line is never a blank
  // turn, and take MAX usage per group (duplicated/streamed lines otherwise
  // multiply the cost).
  let open: OpenAssistant | null = null;
  const flushOpen = (): void => {
    if (!open) return;
    const turn = finalizeAssistant(open, turnIndex, toolCallsById, models, unknownModels);
    if (turn.usage) {
      totals.in += turn.usage.in;
      totals.out += turn.usage.out;
      totals.cacheRead += turn.usage.cacheRead;
      totals.cacheCreate += turn.usage.cacheCreate;
    }
    if (typeof turn.costUsd === "number") {
      totalCost += turn.costUsd;
      anyCostKnown = true;
    }
    turns.push(turn);
    turnIndex += 1;
    open = null;
  };

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let wallClockMs = 0;
  let seq = 0;
  let turnIndex = 0;
  // The skill currently attributed, tracked across lines so a run of same-skill
  // lines counts as one activation rather than one per line (see the emit site).
  let attributedSkill: string | undefined;
  const totals: Usage = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
  let totalCost = 0;
  let anyCostKnown = false;
  const outcome: { prNumber?: number; prUrl?: string } = {};
  // A session can link MANY PRs (stacked PRs, long seat sessions) — collect
  // every `pr-link`, deduped by number; the scalar `outcome` keeps the last.
  const prLinks: PrLink[] = [];
  const prLinksByNumber = new Map<number, PrLink>();
  // Commit SHAs from `git commit` tool results, in transcript order. SHAs seen
  // since the previous pr-link attach to the NEXT link (a PR is opened after
  // its commits); leftovers stay session-level only.
  const shas: ShaCollector = { pending: [], all: [], seen: new Set() };

  const noteTs = (ts?: string): string | undefined => {
    if (typeof ts !== "string") return undefined;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return undefined;
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)) warnings.add(WARNING_CODES.ambiguousTimezone, ts);
    if (ms < startMs) startMs = ms;
    if (ms > endMs) endMs = ms;
    return new Date(ms).toISOString();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    stats.lines += 1;

    let line: Line;
    try {
      line = JSON.parse(trimmed) as Line;
    } catch {
      const isFinal = i >= lines.length - 2; // last content line (maybe + trailing "")
      warnings.add(isFinal ? WARNING_CODES.truncatedFinalLine : WARNING_CODES.malformedLine, trimmed.slice(0, 80));
      stats.skipped += 1;
      continue;
    }
    stats.parsed += 1;

    if (typeof line.sessionId === "string" && !sessionId) sessionId = line.sessionId;
    if (typeof line.cwd === "string" && !cwd) cwd = line.cwd;
    if (typeof line.gitBranch === "string" && !gitBranch) gitBranch = line.gitBranch;
    if (typeof line.entrypoint === "string" && !entrypoint) entrypoint = line.entrypoint;
    if (line.promptSource === "sdk") sawSdkPromptSource = true;
    if (typeof line.version === "string") {
      version = version ?? line.version;
      versions.add(line.version);
      if (isNewerThanSupported(line.version)) warnings.add(WARNING_CODES.versionNewer, line.version);
    }
    if (opts.isSubagent && typeof line.agentId === "string" && !subagentAgentId) {
      subagentAgentId = line.agentId;
    }

    const tsIso = noteTs(line.timestamp);
    // A skill is stamped on EVERY line it is active for (each assistant line of
    // its span; the user/tool lines between them carry no attribution). One
    // activation is one contiguous span, not one per line — otherwise the count
    // just measures how much the model wrote while the skill was open. Emit only
    // on the rising edge: when the attributed skill changes to a new value.
    // Unattributed lines don't reset it, so a span survives its own user turns;
    // switching to a different skill (or back after one) starts a new activation.
    if (typeof line.attributionSkill === "string") {
      if (line.attributionSkill !== attributedSkill) {
        events.push({ type: EVENT_TYPES.skillActivated, seq: seq++, ...(tsIso ? { ts: tsIso } : {}), data: { skill: line.attributionSkill } });
        attributedSkill = line.attributionSkill;
      }
    }
    if (line.isSidechain === true && typeof line.agentId === "string" && !seenSubagents.has(line.agentId)) {
      seenSubagents.add(line.agentId);
      events.push({ type: EVENT_TYPES.subagent, seq: seq++, ...(tsIso ? { ts: tsIso } : {}), data: { agentId: line.agentId } });
    }

    switch (line.type) {
      case "assistant": {
        // A provider failure reaches the transcript as a stub ASSISTANT line
        // flagged `isApiErrorMessage`, carrying the error text as its content —
        // Claude Code writes no `system/api_error` line (the shape the
        // `api_error` branch below handles, kept for other writers). Without
        // this the provider-error count is structurally always zero.
        if (line.isApiErrorMessage === true) {
          const code = apiErrorCode(line.message?.content);
          events.push({
            type: EVENT_TYPES.apiError,
            seq: seq++,
            ...(tsIso ? { ts: tsIso } : {}),
            ...(code ? { data: { code } } : {}),
          });
        }
        // Group by message.id (the multiple lines of one logical turn share it).
        // Without it, fall back to a PER-LINE-unique key (uuid, else line index)
        // so distinct id-less messages never merge.
        const msgId = typeof line.message?.id === "string" ? line.message.id : line.uuid ?? `line-${i}`;
        if (open && open.messageId !== msgId) flushOpen();
        if (!open) {
          open = {
            messageId: msgId,
            ts: tsIso,
            texts: [],
            thinkings: [],
            toolCalls: new Map(),
            toolOrder: [],
          };
        }
        mergeAssistantLine(open, line, tsIso);
        break;
      }
      case "user": {
        // a user line closes any open assistant turn (order preserved)
        flushOpen();
        if (line.isCompactSummary === true) {
          // Compact-continuation text, not a real prompt: count the compaction
          // (unless the adjacent compact_boundary already did) and don't
          // fabricate a user turn out of harness-injected summary text.
          if (events[events.length - 1]?.type !== EVENT_TYPES.compaction) {
            events.push({ type: EVENT_TYPES.compaction, seq: seq++, ...(tsIso ? { ts: tsIso } : {}) });
          }
          break;
        }
        const turn = buildUserTurn(line, turnIndex, tsIso, toolCallsById, blobs, shas);
        if (turn) {
          turns.push(turn);
          turnIndex += 1;
        }
        break;
      }
      case "summary":
        // Session-title/continuation marker lines — NOT compactions (a forked
        // session can carry many). Vendored silently.
        countUnmapped(unmappedTypes, "summary");
        stats.unmapped += 1;
        break;
      case "ai-title":
        if (typeof (line as { aiTitle?: string }).aiTitle === "string") {
          title = (line as { aiTitle?: string }).aiTitle;
        }
        break;
      case "queue-operation":
        events.push({ type: EVENT_TYPES.queueOperation, seq: seq++, ...(tsIso ? { ts: tsIso } : {}), ...(line.operation ? { data: { operation: line.operation } } : {}) });
        break;
      case "mode":
      case "permission-mode":
        events.push({ type: EVENT_TYPES.permissionModeChanged, seq: seq++, ...(tsIso ? { ts: tsIso } : {}), data: { mode: line.permissionMode ?? line.mode ?? "unknown" } });
        break;
      case "pr-link":
        events.push({ type: EVENT_TYPES.prLinked, seq: seq++, ...(tsIso ? { ts: tsIso } : {}), ...(typeof line.prNumber === "number" ? { data: { prNumber: line.prNumber } } : {}) });
        break;
      case "system":
        handleSystem(line, tsIso, events, () => seq++, (ms) => { wallClockMs += ms; });
        if (line.isCompactSummary === true && events[events.length - 1]?.type !== EVENT_TYPES.compaction) {
          events.push({ type: EVENT_TYPES.compaction, seq: seq++, ...(tsIso ? { ts: tsIso } : {}) });
        }
        break;
      case "attachment":
        // The only attachment type mapped to an event today: a hook that
        // blocked continuation (exit 2). Every other attachment kind
        // (deferred-tools deltas, skill listings, structured output, …) is
        // harness bookkeeping and stays silently vendored, per KNOWN_UNMAPPED.
        if (line.attachment?.type === "hook_blocking_error") {
          events.push({
            type: EVENT_TYPES.hookBlocked,
            seq: seq++,
            ...(tsIso ? { ts: tsIso } : {}),
            data: {
              ...(line.attachment.hookEvent ? { hookEvent: line.attachment.hookEvent } : {}),
              ...(line.attachment.hookName ? { hookName: line.attachment.hookName } : {}),
              ...(line.attachment.toolUseID ? { toolUseId: line.attachment.toolUseID } : {}),
            },
          });
        } else {
          countUnmapped(unmappedTypes, "attachment");
          stats.unmapped += 1;
        }
        break;
      case undefined:
        // typeless lines (e.g. bare {started}/{result}) — record shape, keep count
        countUnmapped(unmappedTypes, "(typeless)");
        stats.unmapped += 1;
        break;
      default:
        if (line.isCompactSummary === true) {
          if (events[events.length - 1]?.type !== EVENT_TYPES.compaction) {
            events.push({ type: EVENT_TYPES.compaction, seq: seq++, ...(tsIso ? { ts: tsIso } : {}) });
          }
        } else {
          countUnmapped(unmappedTypes, line.type);
          stats.unmapped += 1;
          // known-but-unmapped → vendor silently; only truly novel types warn
          if (!KNOWN_UNMAPPED.has(line.type)) {
            warnings.add(WARNING_CODES.unknownLineType, line.type);
          }
        }
    }

    // outcome from pr-link (also mapped as event above)
    if (line.type === "pr-link" && typeof line.prNumber === "number" && Number.isInteger(line.prNumber) && line.prNumber > 0) {
      outcome.prNumber = line.prNumber;
      if (typeof line.prUrl === "string") outcome.prUrl = line.prUrl;
      let entry = prLinksByNumber.get(line.prNumber);
      if (!entry) {
        entry = { prNumber: line.prNumber };
        prLinksByNumber.set(line.prNumber, entry);
        prLinks.push(entry);
      }
      if (typeof line.prUrl === "string") entry.prUrl = line.prUrl;
      if (shas.pending.length > 0) {
        entry.commitShas = [...(entry.commitShas ?? []), ...shas.pending];
        shas.pending = [];
      }
    }
  }
  flushOpen(); // finalize the last assistant turn

  if (stats.parsed === 0 || (turns.length === 0 && events.length === 0)) {
    return { session: null, warnings: warnings.histogram(), stats, versions: [...versions].sort(), blobs: [...blobs.values()] };
  }

  for (const model of unknownModels) warnings.add(WARNING_CODES.unknownModelCost, model);

  const vendor: Record<string, unknown> = {};
  if (unmappedTypes.size > 0) {
    vendor.unmappedLineTypes = Object.fromEntries([...unmappedTypes.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  // A subagent's own id is its agentId/filename (opts.ownId) — NEVER the
  // inherited JSONL sessionId (that's the parent's; keying by it clobbers the
  // parent row). The parent link is the path-derived parentSessionId, falling
  // back to the inherited sessionId.
  const ownId = opts.isSubagent
    ? opts.ownId || subagentAgentId || opts.fallbackId || sessionId || "unknown-subagent"
    : sessionId || opts.fallbackId || "unknown-session";
  const parentLink = opts.isSubagent ? parentSessionId || sessionId || undefined : undefined;

  // Every session gets a human title: Claude Code's ai-title if present, else
  // the first real user prompt's opening line (matches the codex adapter and
  // the local viewer — a session is identified by what was asked, never by a
  // bare repo path). Harness-noise user turns (slash-command echoes, injected
  // reminders) are skipped so the title is the actual ask.
  if (!title) {
    const firstAsk = turns.find(
      (t) => isHumanUserTurn(t) && typeof t.text === "string" && t.text.trim() && !/^<(command-name|command-message|command-args|local-command|system-reminder)/.test(t.text.trim()),
    );
    if (firstAsk?.text) title = firstAsk.text.trim().split("\n")[0]!.slice(0, 80);
  }

  // A session is an `agent` run when it's a path-detected subagent transcript,
  // any line carried `promptSource: "sdk"`, or the entrypoint is an SDK one
  // (`sdk-py`, `sdk-cli`, …). Headless `claude -p` (sdk-cli) counts as agent —
  // this gives `claude --resume` parity, which lists only interactive sessions.
  const origin: string =
    opts.isSubagent || sawSdkPromptSource || entrypoint?.startsWith("sdk") ? "agent" : "interactive";

  const startedAt = Number.isFinite(startMs) ? new Date(startMs).toISOString() : new Date(endMs).toISOString();
  const session: AgentSession = {
    schemaVersion: SCHEMA_VERSION,
    id: ownId,
    agent: { type: opts.agentType ?? "claude-code", ...(version ? { version } : {}), ...(entrypoint ? { entrypoint } : {}), origin },
    env: { ...(cwd ? { cwd } : {}), ...(gitRepo ? { gitRepo } : {}), ...(gitBranch ? { gitBranch } : {}) },
    ...(opts.isSubagent
      ? { subagent: { ...(subagentAgentId ? { agentId: subagentAgentId } : {}), ...(parentLink ? { parentSessionId: parentLink } : {}) } }
      : {}),
    startedAt,
    ...(endMs > 0 ? { endedAt: new Date(endMs).toISOString() } : {}),
    models: [...models].sort(),
    turns,
    events,
    totals: {
      inputTokens: totals.in,
      outputTokens: totals.out,
      cacheReadTokens: totals.cacheRead,
      cacheCreationTokens: totals.cacheCreate,
      costUsd: anyCostKnown ? round(totalCost) : null,
      ...(wallClockMs > 0 ? { wallClockMs } : {}),
    },
    ...(outcome.prNumber || shas.all.length > 0
      ? {
          outcome: {
            ...outcome,
            ...(shas.all.length > 0 ? { commitShas: shas.all } : {}),
            ...(prLinks.length > 0 ? { prs: prLinks } : {}),
          },
        }
      : {}),
    ...(title ? { title } : {}),
    ...(Object.keys(vendor).length > 0 ? { vendor } : {}),
    captureTier: opts.captureTier ?? "full",
    warnings: warnings.toArray(),
  };

  // validate our own output (cheap insurance the mapper honors the contract)
  const validated = parseAgentSession(session);
  return { session: validated, warnings: warnings.histogram(), stats, versions: [...versions].sort(), blobs: [...blobs.values()] };
}

/** Image content block: `{ type:"image", source:{ type:"base64", media_type, data } }`.
 * Hash the bytes, add to the blob map (deduped), return a lean ref. */
function extractImage(
  block: Record<string, unknown>,
  blobs: Map<string, CapturedBlob>,
): { mediaType: string; sha256: string; bytes: number } | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (!source || source.type !== "base64" || typeof source.data !== "string") return null;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
  const data = source.data;
  // Content addressing hashes the DECODED bytes, never the base64 text — two
  // encodings of the same image must share one key, and the sync endpoint
  // recomputes this server-side to verify the address matches the content.
  const decoded = Buffer.from(data, "base64");
  const sha256 = createHash("sha256").update(decoded).digest("hex");
  const bytes = decoded.byteLength;
  if (!blobs.has(sha256)) blobs.set(sha256, { sha256, mediaType, data, bytes });
  return { mediaType, sha256, bytes };
}

/** Deep-walk a tool-result value: extract every base64 image block into the
 * blob map and replace its bytes with a lean sha256 ref, pushing each ref into
 * `images`. Returns the sanitized value — structurally shared with the input
 * where nothing changed, so an image-free output (the common case) is returned
 * as-is without a wasteful deep clone. */
function extractInlineImages(
  value: unknown,
  blobs: Map<string, CapturedBlob>,
  images: { mediaType: string; sha256: string; bytes: number }[],
): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = extractInlineImages(v, blobs, images);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === "image" && obj.source && typeof obj.source === "object") {
    const ref = extractImage(obj, blobs);
    // Non-base64 sources (already a ref, or a URL) are left untouched.
    if (!ref) return obj;
    images.push(ref);
    return { type: "image", mediaType: ref.mediaType, sha256: ref.sha256, bytes: ref.bytes };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const r = extractInlineImages(obj[k], blobs, images);
    if (r !== obj[k]) changed = true;
    out[k] = r;
  }
  return changed ? out : obj;
}

/** Accumulator for one logical assistant turn (all JSONL lines sharing a
 * message.id). */
interface OpenAssistant {
  messageId: string;
  ts: string | undefined;
  model?: string;
  usage?: Usage;
  texts: string[];
  thinkings: string[];
  toolCalls: Map<string, ToolCall>; // by tool_use id (dedup across duplicate lines)
  toolOrder: string[]; // insertion order of ids
  anonCalls?: ToolCall[]; // tool_use blocks without an id (rare)
}

/** Merge one assistant JSONL line's content + usage into the open group.
 * Usage takes the MAX per field (duplicated/streamed lines otherwise multiply
 * the cost); content blocks are de-duplicated. */
function mergeAssistantLine(open: OpenAssistant, line: Line, tsIso: string | undefined): void {
  if (!open.ts && tsIso) open.ts = tsIso;
  const message = line.message;
  // An API-error stub carries no real model — skip it here so it never enters
  // `open.model` (and from there `models`/`costOfUsage`), rather than filtering
  // it out later; a later real line in the same message-id group can still set
  // the model, and `!open.model` already protects a real model from being
  // overwritten either way.
  const isSyntheticStub = line.isApiErrorMessage === true || message?.model === "<synthetic>";
  if (!isSyntheticStub && typeof message?.model === "string" && !open.model) open.model = message.model;

  const usage = readUsage(message?.usage);
  if (usage) {
    open.usage = open.usage
      ? {
          in: Math.max(open.usage.in, usage.in),
          out: Math.max(open.usage.out, usage.out),
          cacheRead: Math.max(open.usage.cacheRead, usage.cacheRead),
          cacheCreate: Math.max(open.usage.cacheCreate, usage.cacheCreate),
        }
      : usage;
  }

  const content = message?.content;
  if (typeof content === "string") {
    if (content && !open.texts.includes(content)) open.texts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text && !open.texts.includes(b.text)) open.texts.push(b.text);
        break;
      case "thinking":
        if (typeof b.thinking === "string" && b.thinking && !open.thinkings.includes(b.thinking)) {
          open.thinkings.push(b.thinking);
        }
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const name = typeof b.name === "string" ? b.name : "unknown";
        const call: ToolCall = {
          name,
          status: "ok",
          isEdit: EDIT_TOOLS.has(name),
          ...(tsIso ? { startTs: tsIso } : {}),
          ...(b.input !== undefined ? { input: b.input } : {}),
          ...(typeof b.id === "string" ? { toolUseId: b.id } : {}),
        };
        const file = extractFile(b.input);
        if (file) call.file = file;
        if (typeof b.id === "string") {
          if (!open.toolCalls.has(b.id)) {
            open.toolCalls.set(b.id, call);
            open.toolOrder.push(b.id);
          }
        } else {
          (open.anonCalls ??= []).push(call);
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Finalize an assistant group into a Turn, registering its tool calls so
 * later user tool_results can resolve them. */
function finalizeAssistant(
  open: OpenAssistant,
  index: number,
  toolCallsById: Map<string, { call: ToolCall; startMs?: number }>,
  models: Set<string>,
  unknownModels: Set<string>,
): Turn {
  const toolCalls: ToolCall[] = [];
  for (const id of open.toolOrder) {
    const call = open.toolCalls.get(id)!;
    toolCalls.push(call);
    toolCallsById.set(id, { call, startMs: open.ts ? Date.parse(open.ts) : undefined });
  }
  if (open.anonCalls) toolCalls.push(...open.anonCalls);

  const turn: Turn = {
    index,
    role: "assistant",
    toolCalls,
    messageId: open.messageId,
    ...(open.ts ? { ts: open.ts } : {}),
  };
  if (open.model) {
    turn.model = open.model;
    models.add(open.model);
  }
  if (open.usage) {
    turn.usage = open.usage;
    if (open.model) {
      const cost = costOfUsage(open.model, open.usage);
      turn.costUsd = cost;
      if (cost === null) unknownModels.add(open.model);
    } else {
      turn.costUsd = null;
    }
  }
  const text = open.texts.join("\n").trim();
  if (text) turn.text = text.slice(0, TEXT_CAP);
  const thinking = open.thinkings.join("\n").trim();
  if (thinking) turn.thinking = thinking.slice(0, TEXT_CAP);
  return turn;
}

/** One PR linked in the session (`pr-link` line + attributed commits).
 * A type alias (not an interface) so it satisfies the schema's loose-object
 * index signature. */
type PrLink = {
  prNumber: number;
  prUrl?: string;
  commitShas?: string[];
};

/** Commit SHAs observed so far: `pending` = since the last pr-link (attach to
 * the next one), `all` = session-wide union, `seen` = dedup guard. */
interface ShaCollector {
  pending: string[];
  all: string[];
  seen: Set<string>;
}

/** Build a user turn, or null for a pure tool-result carrier (its results
 * mutate the prior assistant turn's tool calls instead). */
function buildUserTurn(
  line: Line,
  index: number,
  tsIso: string | undefined,
  toolCallsById: Map<string, { call: ToolCall; startMs?: number }>,
  blobs: Map<string, CapturedBlob>,
  shas: ShaCollector,
): Turn | null {
  const content = line.message?.content;
  let text: string | null = null;
  const images: { mediaType: string; sha256: string; bytes: number }[] = [];
  if (typeof content === "string") {
    text = content.slice(0, TEXT_CAP);
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
      else if (b.type === "image") {
        const ref = extractImage(b, blobs);
        if (ref) images.push(ref);
      } else if (b.type === "tool_result") resolveToolResult(b, line.toolUseResult, tsIso, toolCallsById, blobs, images, shas);
    }
    if (textParts.length > 0) text = textParts.join("\n").slice(0, TEXT_CAP);
  }
  const turn: Turn = { index, role: "user", toolCalls: [], ...(tsIso ? { ts: tsIso } : {}) };
  if (text !== null && text.trim().length > 0) turn.text = text;
  if (images.length > 0) {
    // Dedup by content address: the same screenshot can appear in both the
    // tool_result body and its mirrored `toolUseResult`, and pasted images can
    // repeat across blocks.
    const seen = new Set<string>();
    turn.images = images.filter((i) => (seen.has(i.sha256) ? false : (seen.add(i.sha256), true)));
  }
  // a turn with an image (even no text) is real content, not a pure tool-result
  if (turn.text === undefined && turn.images === undefined) return null;
  turn.source = classifyUserSource(line, text ?? "");
  return turn;
}

function resolveToolResult(
  block: Record<string, unknown>,
  toolUseResult: unknown,
  tsIso: string | undefined,
  toolCallsById: Map<string, { call: ToolCall; startMs?: number }>,
  blobs: Map<string, CapturedBlob>,
  images: { mediaType: string; sha256: string; bytes: number }[],
  shas: ShaCollector,
): void {
  const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
  if (!id) return;
  const entry = toolCallsById.get(id);
  if (!entry) return;
  const { call, startMs } = entry;

  const bodyText = stringifyResultBody(block.content);
  const isError = block.is_error === true;
  const rejected = REJECTION_MARKERS.some((m) => bodyText.includes(m));
  call.status = rejected ? "rejected" : isError ? "error" : "ok";
  if (call.status === "error" && bodyText) {
    call.errorSignature = normalizeErrorSignature(bodyText);
  }
  // Commit SHAs from successful `git commit` runs. Gated on the COMMAND (not
  // just the output shape) so `[branch sha]`-looking text in unrelated output
  // (a cat'd changelog, a pasted log) never fabricates a commit.
  if (call.status === "ok" && call.name === "Bash") {
    const cmd = (call.input as { command?: unknown } | undefined)?.command;
    if (typeof cmd === "string" && cmd.includes("git commit")) {
      for (const sha of extractCommitShas(bodyText)) {
        if (shas.seen.has(sha)) continue;
        shas.seen.add(sha);
        shas.all.push(sha);
        shas.pending.push(sha);
      }
    }
  }
  // A tool result can carry images (browser/computer-use screenshots) — the
  // DOMINANT image source in agent sessions. Extract them to content-addressed
  // blobs and strip the base64 out of the stored output, so the bytes ship
  // once (deduped, fetched by hash) instead of bloating every full-tier turn.
  const output = extractInlineImages(toolUseResult ?? block.content, blobs, images);
  if (output !== undefined) call.output = output;
  if (tsIso && startMs !== undefined) {
    const dur = Date.parse(tsIso) - startMs;
    if (dur >= 0) call.durationMs = dur;
  }
}

function handleSystem(
  line: Line,
  tsIso: string | undefined,
  events: SessionEvent[],
  nextSeq: () => number,
  addWallClock: (ms: number) => void,
): void {
  switch (line.subtype) {
    case "compact_boundary":
      // The authoritative compaction marker (the isCompactSummary user line
      // that follows carries the summary text; the boundary counts the event).
      events.push({ type: EVENT_TYPES.compaction, seq: nextSeq(), ...(tsIso ? { ts: tsIso } : {}) });
      break;
    case "turn_duration":
      if (typeof line.durationMs === "number") addWallClock(line.durationMs);
      break;
    case "stop_hook_summary": {
      const data: Record<string, unknown> = {};
      if (typeof line.hookCount === "number") data.hookCount = line.hookCount;
      if (Array.isArray(line.hookInfos) && line.hookInfos.length > 0) {
        // A hook entry with no `durationMs` (a self-backgrounding hook process,
        // ~40% of executions in the wild) omits the key entirely — never a
        // fabricated 0 — so downstream can distinguish "not reported" from
        // "instant" instead of silently understating a sum.
        data.hooks = line.hookInfos.slice(0, HOOK_INFOS_CAP).map((h) => ({
          ...(typeof h.command === "string" ? { command: h.command.slice(0, HOOK_COMMAND_CAP) } : {}),
          ...(isValidHookDurationMs(h.durationMs) ? { durationMs: h.durationMs } : {}),
        }));
      }
      // errorCount (how many, not what) is content-free and stays in `data`.
      // The raw text is stderr — process OUTPUT, not an identifier — so it
      // rides the event's own `errorText` field, tiered separately at `full`.
      let errorText: string[] | undefined;
      if (Array.isArray(line.hookErrors) && line.hookErrors.length > 0) {
        data.errorCount = line.hookErrors.length;
        errorText = line.hookErrors
          .slice(0, HOOK_ERRORS_CAP)
          .map((e) => (typeof e === "string" ? e : JSON.stringify(e)).slice(0, HOOK_ERROR_TEXT_CAP));
      }
      if (typeof line.toolUseID === "string") data.toolUseId = line.toolUseID;
      events.push({
        type: EVENT_TYPES.hookExecuted,
        seq: nextSeq(),
        ...(tsIso ? { ts: tsIso } : {}),
        ...(Object.keys(data).length > 0 ? { data } : {}),
        ...(errorText ? { errorText } : {}),
      });
      break;
    }
    case "api_error": {
      const code = typeof line.error === "object" && line.error ? line.error.code : undefined;
      events.push({ type: EVENT_TYPES.apiError, seq: nextSeq(), ...(tsIso ? { ts: tsIso } : {}), ...(code ? { data: { code } } : {}) });
      break;
    }
    case "local_command":
      events.push({ type: EVENT_TYPES.localCommand, seq: nextSeq(), ...(tsIso ? { ts: tsIso } : {}) });
      break;
    default:
      break;
  }
}

/**
 * Classify an API-error stub's text into a stable machine code. The stub's
 * content is a human-facing sentence that varies by provider and release, and
 * `data` may only carry identifiers — so this maps to a closed vocabulary
 * instead of forwarding the sentence. Unrecognized wording is `unknown`, never
 * the raw text.
 */
const API_ERROR_CODES: [RegExp, string][] = [
  [/\b429\b|rate.?limit/i, "rate_limit"],
  [/\b529\b|overloaded/i, "overloaded"],
  [/timed?.?out|timeout/i, "timeout"],
  [/connection (?:closed|error|reset)|network error/i, "connection_closed"],
  [/unavailable/i, "model_unavailable"],
  [/\b5\d\d\b|internal server error/i, "server_error"],
];

function apiErrorCode(content: unknown): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown> | null;
      if (b && typeof b === "object" && typeof b.text === "string") text += ` ${b.text}`;
    }
  }
  for (const [pattern, code] of API_ERROR_CODES) if (pattern.test(text)) return code;
  return "unknown";
}

function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const usage: Usage = {
    in: num(r.input_tokens),
    out: num(r.output_tokens),
    cacheRead: num(r.cache_read_input_tokens),
    cacheCreate: num(r.cache_creation_input_tokens),
  };
  if (usage.in === 0 && usage.out === 0 && usage.cacheRead === 0 && usage.cacheCreate === 0) {
    return undefined;
  }
  return usage;
}

function extractFile(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
    if (typeof r[key] === "string") return r[key] as string;
  }
  return undefined;
}

function stringifyResultBody(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join(" ");
  }
  return "";
}

/** Strip paths, line/col numbers, hex ids, and uuids so recurring errors
 * cluster (feeds the error-cluster detector). Bounded length. */
export function normalizeErrorSignature(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"':]+/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/:\d+:\d+|\bline \d+|\b\d{3,}\b/gi, (m) => (m.startsWith("line") ? "line <n>" : m.includes(":") ? ":<n>:<n>" : "<n>"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * SHAs from `git commit` porcelain output — the `[branch abc1234] subject`
 * summary line (also `[detached HEAD …]`, `[branch (root-commit) …]`).
 * Git prints ABBREVIATED lowercase hashes (7+ chars, length per core.abbrev);
 * consumers must treat them as prefixes. Anchored to line start so diffstat
 * or quoted text never matches. Exported for direct testing.
 */
export function extractCommitShas(text: string): string[] {
  const out: string[] = [];
  const re = /^\[[^\n\]]+ ([0-9a-f]{7,40})\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]!);
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function countUnmapped(map: Map<string, number>, type: string): void {
  map.set(type, (map.get(type) ?? 0) + 1);
}
