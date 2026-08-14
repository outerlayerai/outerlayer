// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Detects the recorded Claude Code session an `emit artifact` is running
 * inside, from the hook spool alone: the CLAUDECODE env var says "some
 * session is running", and the newest live `events.jsonl` record whose cwd
 * matches this process's repo root (or its exact cwd) says WHICH. Reading
 * the spool tail instead of asking Claude Code keeps this dependency-free
 * and works from any child process the session spawns.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** Tail window over the spool. Event lines run ~200 bytes, so 64 KiB spans
 * hundreds of recent hook firings — far past any live session's newest
 * event — while keeping the read O(1) in spool size. */
export const SESSION_DETECT_TAIL_BYTES = 64 * 1024;

/** A record older than this cannot vouch for a live session even without a
 * SessionEnd line — crashes and SIGKILLs write none. */
export const SESSION_DETECT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SpoolTail {
  data: Buffer;
  /** True when the read started mid-file — the first line is then a
   * fragment and must not be parsed. */
  truncated: boolean;
}

/** Injectable so tests need no real spool file. */
type SpoolTailReader = (path: string, maxBytes: number) => SpoolTail | undefined;

const readTail: SpoolTailReader = (path, maxBytes) => {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const data = Buffer.alloc(length);
      readSync(fd, data, 0, length, size - length);
      return { data, truncated: size > length };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

export interface DetectActiveSessionOptions {
  env: Record<string, string | undefined>;
  home: string;
  /** Directories a live session's recorded `cwd` may equal: the emitting
   * process's cwd and the repo root it belongs to (an emit from a subdir
   * still belongs to the session recorded at the repo root). */
  cwds: ReadonlyArray<string>;
  nowMs: number;
  readTailImpl?: SpoolTailReader;
}

interface SpoolEventRecord {
  t?: unknown;
  event?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
}

/**
 * The active session's id, or undefined when there is none: CLAUDECODE must
 * be set AND the spool tail must hold a matching-cwd record younger than
 * SESSION_DETECT_MAX_AGE_MS from a session with no SessionEnd line — an
 * ended session's EARLIER records cannot anchor either, even when they are
 * the newest cwd match. The newest (last-appended) surviving match wins —
 * the spool is append-only, so file order is time order.
 */
export function detectActiveSession(opts: DetectActiveSessionOptions): string | undefined {
  if (!opts.env.CLAUDECODE) return undefined;
  const read = opts.readTailImpl ?? readTail;
  const tail = read(join(opts.home, ".outerlayer", "spool", "events.jsonl"), SESSION_DETECT_TAIL_BYTES);
  if (!tail || tail.data.length === 0) return undefined;

  let lines = tail.data.toString("utf8").split("\n");
  if (tail.truncated) lines = lines.slice(1);

  const records: SpoolEventRecord[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      records.push(JSON.parse(text) as SpoolEventRecord);
    } catch {
      continue;
    }
  }

  const ended = new Set<string>();
  for (const record of records) {
    if (record.event === "SessionEnd" && typeof record.sessionId === "string" && record.sessionId !== "") {
      ended.add(record.sessionId);
    }
  }

  let newest: string | undefined;
  for (const record of records) {
    if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
    if (record.event === "SessionEnd" || ended.has(record.sessionId)) continue;
    if (typeof record.cwd !== "string" || !opts.cwds.includes(record.cwd)) continue;
    if (typeof record.t !== "string") continue;
    const tMs = Date.parse(record.t);
    if (!Number.isFinite(tMs) || opts.nowMs - tMs > SESSION_DETECT_MAX_AGE_MS) continue;
    newest = record.sessionId;
  }
  return newest;
}
