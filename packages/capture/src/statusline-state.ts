// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Maintains ~/.outerlayer/statusline.json — the state file the statusline
 * fast path renders from. All transcript parsing happens HERE, in the watch
 * daemon's process, because the fast path re-runs every ~300ms and must
 * never parse anything. Zero network, like everything else in capture.
 *
 * The recompute is bounded by a calendar-day mtime pre-filter: only files
 * touched today are parsed. A day of heavy multi-agent use stays cheap; a
 * years-deep transcript tree costs one directory walk.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOURCE_ADAPTERS, type SourceAdapter } from "./adapters/index.js";
import type { SourceRoots } from "./adapters/types.js";

export function statuslineStatePath(home = homedir()): string {
  return join(home, ".outerlayer", "statusline.json");
}

/** The state file contract. The CLI's fast path duplicates this shape
 * structurally (importing capture there would defeat its import budget); a
 * type-parity test on the CLI side pins the two together. */
export interface StatuslineState {
  v: 1;
  /** ISO timestamp of this recompute — the fast path's freshness gate. */
  generatedAt: string;
  /** Totals for one local calendar day; `date` names it so a stale file
   * can never pass yesterday's spend off as today's. */
  today: { date: string; byAgent: Record<string, number> };
  /** Per-session running cost, keyed by source session id. */
  sessions: Record<string, { costUsd: number }>;
  /** Transcripts newer than the sync watermark. Absent when cloud sync was
   * never configured — the line omits the segment rather than showing 0. */
  unsynced?: number;
}

/** Never-throw read; corrupt === absent. */
export function readStatuslineState(home = homedir()): StatuslineState | null {
  try {
    const parsed = JSON.parse(readFileSync(statuslineStatePath(home), "utf8")) as StatuslineState;
    if (!parsed || parsed.v !== 1 || typeof parsed.generatedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomic write-then-rename: the fast path may read mid-write and must
 * never see a half-written file. Never throws — state is an optimization,
 * not a correctness gate. */
export function writeStatuslineState(state: StatuslineState, home = homedir()): void {
  try {
    const path = statuslineStatePath(home);
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best effort
  }
}

function localDateString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMidnightMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The sync watermark for the configured destination, read directly from
 * ~/.outerlayer/watermarks.json (`"<host>:<appId>": <mtimeMs>`). Deliberately
 * NOT the CLI's readWatermark: that path migrates from SQLite and writes the
 * file — a daemon polling every few minutes must be a pure reader. Returns
 * null when sync is unconfigured (segment omitted), 0 when configured but
 * never synced (everything counts as unsynced).
 */
export function readSyncWatermarkMs(home = homedir()): number | null {
  try {
    const config = JSON.parse(readFileSync(join(home, ".outerlayer", "config.json"), "utf8")) as {
      url?: string;
      appId?: string;
    };
    if (!config.url || !config.appId) return null;
    const key = `${new URL(config.url).host}:${config.appId}`;
    try {
      const marks = JSON.parse(readFileSync(join(home, ".outerlayer", "watermarks.json"), "utf8")) as Record<string, unknown>;
      const value = marks[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  } catch {
    return null;
  }
}

export interface ComputeStatuslineOptions {
  home?: string;
  roots?: SourceRoots;
  now?: () => number;
  /** Injected for tests (fakes avoid building per-agent on-disk fixtures). */
  adapters?: SourceAdapter[];
}

/** The slice of a parsed session the recompute reads. Matches AgentSession
 * structurally; declared locally so the math below is testable with plain
 * fixtures. */
interface CostedSession {
  id: string;
  startedAt?: string;
  totals: { costUsd?: number | null };
  turns?: Array<{ ts?: string; costUsd?: number | null }>;
}

/**
 * A session's spend since `midnightMs`, attributed by when each turn's
 * tokens were actually spent. A session that started yesterday and ran
 * past midnight must contribute only its post-midnight turns to "today" —
 * whole-session totals would hand yesterday's spend to today's number,
 * which for an overnight session can be most of it. Turns without a
 * timestamp inherit the session's start. Sessions whose turns carry no
 * per-turn cost at all (an adapter that only prices totals) fall back to
 * the session total — exact when the session started today, the
 * whole-session approximation otherwise.
 */
export function costSince(session: CostedSession, midnightMs: number): number {
  const turns = session.turns ?? [];
  let sum = 0;
  let anyPriced = false;
  for (const turn of turns) {
    if (typeof turn.costUsd !== "number") continue;
    anyPriced = true;
    const ts = Date.parse(turn.ts ?? session.startedAt ?? "");
    if (Number.isFinite(ts) && ts < midnightMs) continue;
    sum += turn.costUsd;
  }
  if (anyPriced) return sum;
  return session.totals.costUsd ?? 0;
}

/**
 * Full recompute: discover across all source adapters, parse ONLY files
 * with today's mtime, sum per-turn cost spent today per agent (see
 * `costSince`). The adapters already price offline against the bundled
 * table; unknown-model turns carry null and sum as 0.
 */
export function computeStatuslineState(opts: ComputeStatuslineOptions = {}): StatuslineState {
  const home = opts.home ?? homedir();
  const now = (opts.now ?? Date.now)();
  const adapters = opts.adapters ?? SOURCE_ADAPTERS;
  const roots = opts.roots ?? {};
  const midnight = localMidnightMs(now);

  const byAgent: Record<string, number> = {};
  const sessions: Record<string, { costUsd: number }> = {};
  let unsyncedCount = 0;
  const watermark = readSyncWatermarkMs(home);

  for (const adapter of adapters) {
    let entries;
    try {
      entries = adapter.discover(roots);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.mtimeMs < midnight) continue;
      if (watermark !== null && entry.mtimeMs > watermark) unsyncedCount += 1;
      let session;
      try {
        session = adapter.parse(entry, { roots }).session;
      } catch {
        continue;
      }
      if (!session) continue;
      byAgent[adapter.id] = (byAgent[adapter.id] ?? 0) + costSince(session, midnight);
      // The per-session entry stays the session's WHOLE cost — it is a
      // running total for that session, not a today-slice.
      sessions[session.id] = { costUsd: session.totals.costUsd ?? 0 };
    }
  }
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    today: { date: localDateString(now), byAgent },
    sessions,
    ...(watermark !== null ? { unsynced: unsyncedCount } : {}),
  };
}

export interface StatuslineAggregatorOptions extends ComputeStatuslineOptions {
  /** Collapse a burst of mirror events into one recompute. */
  debounceMs?: number;
}

/**
 * Owns the state file's lifecycle inside `outerlayer watch`: refresh on
 * start and on the daemon's rescan cadence, debounced refresh on mirror
 * events. Every refresh is a full today-only recompute — the mtime
 * pre-filter keeps it proportional to one day's work, which removes the
 * cache-invalidation bugs a per-file incremental update would invite.
 */
export class StatuslineAggregator {
  private readonly opts: StatuslineAggregatorOptions;
  private readonly debounceMs: number;
  private pending?: ReturnType<typeof setTimeout>;

  constructor(opts: StatuslineAggregatorOptions = {}) {
    this.opts = opts;
    this.debounceMs = opts.debounceMs ?? 5000;
  }

  /** Synchronous full recompute + write. */
  refresh(): StatuslineState {
    const state = computeStatuslineState(this.opts);
    writeStatuslineState(state, this.opts.home);
    return state;
  }

  /** Debounced refresh, for mirror/change events. */
  notifyChange(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.refresh();
    }, this.debounceMs);
  }

  /** Cancels any pending debounce; final write so shutdown state is current. */
  stop(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
      this.refresh();
    }
  }
}
