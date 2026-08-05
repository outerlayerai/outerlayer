// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Turns `hook-wrap`'s spool (`~/.outerlayer/spool/hook-exec.jsonl`) into
 * `hook_executed` session events at sync time, per one execution (`execId`)
 * at a time:
 *
 *   started + finished  → completed; exitCode is truth (0 ok, else error).
 *   started + aborted   → killed by a signal (timeout or session cancel).
 *   started only,
 *     still plausibly running → DEFER — the next sync pass gets another look
 *       rather than mislabel a hook that simply hasn't finished yet.
 *   started only,
 *     past the max hook timeout (+ slack) → INCOMPLETE. This is the row the
 *     whole feature exists for: Pre/PostToolUse hooks get no transcript
 *     evidence at all when SIGKILLed on timeout, so without this branch a
 *     600-second hang leaves nothing anywhere.
 *
 * The spool is a flat, ever-growing JSONL file; a byte-offset watermark
 * (mirroring watermark.ts's per-destination one, but global — this tracks
 * LOCAL spool consumption, not a sync destination) prevents re-merging the
 * same record on every run. The watermark only advances past a `started`
 * line once its execution is fully resolved AND its session actually got
 * merged this run — an execution still deferred, or one whose session
 * wasn't part of this sync pass, holds the watermark behind it so it gets
 * another chance next time.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EVENT_TYPES, type SessionEvent } from "@outerlayer/session-schema";
import { hookExecSpoolPath } from "./hook-wrap-fast.js";

// ---------------------------------------------------------------------------
// spool record shapes — written by hook-wrap-fast.ts
// ---------------------------------------------------------------------------

export interface HookExecStartedRecord {
  rec: "started";
  execId: string;
  t: string;
  sessionId: string | null;
  hookEvent: string | null;
  toolUseId: string | null;
  toolName: string | null;
  cmdSha: string;
  cmd: string;
  pid: number;
}
export interface HookExecFinishedRecord {
  rec: "finished";
  execId: string;
  durationMs: number;
  exitCode: number | null;
  signal?: string;
  stdoutTail?: string;
  stderrTail?: string;
}
export interface HookExecAbortedRecord {
  rec: "aborted";
  execId: string;
  durationMs: number;
  signal: string;
}
type HookExecRecord = HookExecStartedRecord | HookExecFinishedRecord | HookExecAbortedRecord;

/** Claude Code's own hook timeout ceiling; beyond this, a `started`-only
 * record can no longer be "still running" in any legitimate sense. */
export const HOOK_TIMEOUT_MS = 600_000;
/** Slack above the timeout before calling it: SIGKILL delivery, clock skew,
 * and a sync that simply runs a little late are not the same as a hang. */
export const HOOK_INCOMPLETE_SLACK_MS = 60_000;
export const HOOK_INCOMPLETE_AFTER_MS = HOOK_TIMEOUT_MS + HOOK_INCOMPLETE_SLACK_MS;

type HookExecStatus = "ok" | "error" | "aborted" | "incomplete";

export interface HookOutcome {
  sessionId: string;
  hookEvent: string;
  toolUseId?: string;
  command: string;
  ts: string;
  durationMs: number;
  exitCode?: number;
  status: HookExecStatus;
  statusMessage?: string;
}

export interface HookExecGroup {
  started?: HookExecStartedRecord;
  finished?: HookExecFinishedRecord;
  aborted?: HookExecAbortedRecord;
}

/** `ms` rounded to whole seconds/minutes for a human-readable lower bound —
 * exact millisecond precision would imply a false precision this evidence
 * doesn't have (we know only that it ran AT LEAST this long). */
export function formatDurationApprox(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/**
 * The four-state reader machine, exactly one execution (`execId`) at a time.
 * Returns:
 *  - a resolved `HookOutcome` (completed / aborted / incomplete),
 *  - `"defer"` when the execution might still be running and isn't old
 *    enough to call — the caller must NOT consume this record yet,
 *  - `undefined` when there's nothing usable to build an event from (no
 *    `started` record, or one missing the session/event it belongs to).
 */
export function deriveHookOutcome(
  group: HookExecGroup,
  opts: { sessionEnded: boolean; nowMs: number },
): HookOutcome | "defer" | undefined {
  const started = group.started;
  if (!started || !started.sessionId || !started.hookEvent) return undefined;

  const base = {
    sessionId: started.sessionId,
    hookEvent: started.hookEvent,
    toolUseId: started.toolUseId ?? undefined,
    command: started.cmd,
    ts: started.t,
  };

  // started + finished: exitCode is truth, whether or not an `aborted` record
  // also exists (a signal that arrived just as the child exited on its own).
  if (group.finished) {
    const exitCode = group.finished.exitCode;
    return {
      ...base,
      durationMs: group.finished.durationMs,
      ...(exitCode !== null ? { exitCode } : {}),
      status: exitCode === 0 ? "ok" : "error",
    };
  }

  // started + aborted (no finished): killed by a signal — timeout or session
  // cancel. Duration is the time-to-kill, not a guess at total runtime.
  if (group.aborted) {
    return {
      ...base,
      durationMs: group.aborted.durationMs,
      status: "aborted",
    };
  }

  // started only. Still plausibly running: defer rather than mislabel.
  const startedAtMs = Date.parse(started.t);
  const ageMs = opts.nowMs - startedAtMs;
  if (!opts.sessionEnded && ageMs < HOOK_INCOMPLETE_AFTER_MS) return "defer";

  // started only, session ended or long past the timeout ceiling: this is
  // the row the feature exists for — a SIGKILLed hang or a hard crash that
  // otherwise leaves no evidence anywhere.
  return {
    ...base,
    durationMs: ageMs,
    status: "incomplete",
    statusMessage: `did not complete (killed or crashed) — ran ≥ ${formatDurationApprox(ageMs)}`,
  };
}

/** One resolved outcome → one `hook_executed` session event (seq-less; the
 * caller assigns `seq` when appending into a specific session's event list). */
export function hookOutcomeToEvent(outcome: HookOutcome): Omit<SessionEvent, "seq"> {
  return {
    type: EVENT_TYPES.hookExecuted,
    ts: outcome.ts,
    data: {
      hookEvent: outcome.hookEvent,
      hooks: [
        {
          command: outcome.command,
          durationMs: outcome.durationMs,
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          status: outcome.status,
          ...(outcome.toolUseId ? { toolUseId: outcome.toolUseId } : {}),
          ...(outcome.statusMessage ? { statusMessage: outcome.statusMessage } : {}),
        },
      ],
    },
  };
}

/** Appends `events` to `session.events`, assigning `seq` continuing from the
 * session's current highest — never collides with turns/other events. */
export function appendHookExecEvents(
  session: { events: SessionEvent[] },
  events: Array<Omit<SessionEvent, "seq">>,
): void {
  let nextSeq = session.events.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
  for (const event of events) session.events.push({ ...event, seq: nextSeq++ } as SessionEvent);
}

// ---------------------------------------------------------------------------
// spool file I/O + watermark
// ---------------------------------------------------------------------------

export function hookExecWatermarkPath(home = homedir()): string {
  return join(spoolWatermarkDir(home), "hook-exec.watermark");
}

function spoolWatermarkDir(home: string): string {
  return join(home, ".outerlayer", "spool");
}

export function readHookExecWatermark(home = homedir()): number {
  try {
    const raw = readFileSync(hookExecWatermarkPath(home), "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Atomic (write-then-rename), matching watermark.ts's pattern. Never
 * throws: a failed checkpoint write must not fail an otherwise-successful
 * sync — the next run simply re-derives the same (idempotent) events. */
export function writeHookExecWatermark(offset: number, home = homedir()): void {
  try {
    const path = hookExecWatermarkPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, String(offset));
    renameSync(tmp, path);
  } catch {
    // best effort — the checkpoint is an optimization, not a correctness gate
  }
}

interface SpoolLine {
  record: HookExecRecord;
  startOffset: number;
}

/** Reads spool lines strictly after `sinceOffset`, in BYTES (not string
 * chars — the spool may carry non-ASCII command text). A malformed line is
 * skipped but still advances past — one corrupt line must not wedge every
 * record after it behind the watermark forever. */
function readSpoolLinesSince(home: string, sinceOffset: number): { lines: SpoolLine[]; fileLength: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(hookExecSpoolPath(home));
  } catch {
    return { lines: [], fileLength: sinceOffset };
  }
  const lines: SpoolLine[] = [];
  let pos = Math.min(Math.max(sinceOffset, 0), buf.length);
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const textEnd = nl === -1 ? buf.length : nl;
    const lineEnd = nl === -1 ? buf.length : nl + 1;
    const text = buf.subarray(pos, textEnd).toString("utf8").trim();
    if (text) {
      try {
        lines.push({ record: JSON.parse(text) as HookExecRecord, startOffset: pos });
      } catch {
        // skip malformed line; still consumes past it below
      }
    }
    pos = lineEnd;
    if (nl === -1) break;
  }
  return { lines, fileLength: buf.length };
}

function groupByExecId(lines: SpoolLine[]): Map<string, HookExecGroup & { startOffset: number }> {
  const groups = new Map<string, HookExecGroup & { startOffset: number }>();
  for (const { record, startOffset } of lines) {
    const g = groups.get(record.execId) ?? { startOffset };
    if (record.rec === "started") {
      g.started = record;
      g.startOffset = startOffset; // the group's line span begins at `started`
    } else if (record.rec === "finished") {
      g.finished = record;
    } else if (record.rec === "aborted") {
      g.aborted = record;
    }
    groups.set(record.execId, g);
  }
  return groups;
}

export interface HookExecPlan {
  /** sessionId → the hook_executed events to append this run. */
  eventsBySession: Map<string, Array<Omit<SessionEvent, "seq">>>;
  /** sessionId → earliest byte offset among that session's RESOLVED groups —
   * used to hold the watermark back if the session doesn't actually get
   * merged this run (its transcript sits behind the separate, mtime-based
   * sync watermark and isn't scanned this pass). */
  sessionGroupOffsets: Map<string, number>;
  /** The offset safe to persist IF every resolved group's session gets
   * merged this run — the caller (sync-cmd) lowers this per
   * `sessionGroupOffsets` for any session it didn't actually touch. */
  fullyConsumedOffset: number;
  recordsRead: number;
}

export interface PlanHookExecMergeOptions {
  home?: string;
  nowMs?: number;
  /** Best-effort liveness check; sync has no reliable way to know whether
   * the originating Claude Code process is still running, so the safe
   * default (`() => false`) leans on the age-based fallback in
   * `deriveHookOutcome` — the mechanism that actually catches a hang. */
  sessionEnded?: (sessionId: string) => boolean;
}

/**
 * Reads new spool lines since the last watermark, resolves every execution's
 * outcome, and returns a plan the caller applies (no writes here — the
 * watermark commit is the caller's job, done only after a successful,
 * non-dry-run sync, exactly like the transcript watermark in watermark.ts).
 */
export function planHookExecMerge(opts: PlanHookExecMergeOptions = {}): HookExecPlan {
  const home = opts.home ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const sessionEnded = opts.sessionEnded ?? (() => false);
  const sinceOffset = readHookExecWatermark(home);
  const { lines, fileLength } = readSpoolLinesSince(home, sinceOffset);
  const groups = groupByExecId(lines);

  const eventsBySession = new Map<string, Array<Omit<SessionEvent, "seq">>>();
  const sessionGroupOffsets = new Map<string, number>();
  let fullyConsumedOffset = fileLength;

  for (const group of groups.values()) {
    const outcome = deriveHookOutcome(group, {
      sessionEnded: group.started?.sessionId ? sessionEnded(group.started.sessionId) : false,
      nowMs,
    });
    if (outcome === "defer") {
      // Unresolved: pin the watermark just behind this group's `started`
      // line so the NEXT sync still sees it and can resolve it later.
      fullyConsumedOffset = Math.min(fullyConsumedOffset, group.startOffset);
      continue;
    }
    if (!outcome) continue; // unattributable — nothing to hold back for
    const list = eventsBySession.get(outcome.sessionId) ?? [];
    list.push(hookOutcomeToEvent(outcome));
    eventsBySession.set(outcome.sessionId, list);
    const prior = sessionGroupOffsets.get(outcome.sessionId);
    sessionGroupOffsets.set(outcome.sessionId, prior === undefined ? group.startOffset : Math.min(prior, group.startOffset));
  }

  return { eventsBySession, sessionGroupOffsets, fullyConsumedOffset, recordsRead: lines.length };
}
