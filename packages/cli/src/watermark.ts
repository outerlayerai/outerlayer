// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Per-destination sync checkpoint, stored as JSON.
 *
 * The watermark is a single number per `host:appId` — the mtime of the newest
 * transcript already shipped. It used to live in the local SQLite mirror
 * (`db.sqlite`), which meant the background sync — the code that runs on every
 * SessionEnd — loaded better-sqlite3 (a native module) and opened a
 * multi-hundred-MB database just to read one integer. That native dependency
 * is the main thing standing between this CLI and a copy-anywhere install.
 *
 * This file holds ONLY that checkpoint, in a few-hundred-byte JSON file, using
 * node builtins alone. The SQLite mirror still backs `scan`/`ui`/`handoff`;
 * this just takes the sync hot path off it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/** `{ "<host>:<appId>": <mtimeMs> }`. */
type WatermarkFile = Record<string, number>;

export function watermarkPath(home = homedir()): string {
  return join(home, ".outerlayer", "watermarks.json");
}

/** `host:appId` — the destination a checkpoint belongs to. A key must never
 * cross destinations: the same corpus synced to two apps has two watermarks. */
export function watermarkKeyFor(url: string, appId: string): string {
  return `${new URL(url).host}:${appId}`;
}

function readFile(home: string): WatermarkFile {
  try {
    const parsed = JSON.parse(readFileSync(watermarkPath(home), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: WatermarkFile = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Reads the checkpoint for a destination, in mtime-milliseconds.
 *
 * Returns 0 when there is no checkpoint — a fresh machine re-syncs from the
 * start, which is safe because ingestion is idempotent (deterministic ids +
 * a ReplacingMergeTree server-side). When no checkpoint exists for this
 * destination, a best-effort migration seeds it from the SQLite watermark so a
 * has one does NOT re-ship its whole history; see migrateFn.
 */
export function readWatermark(
  url: string,
  appId: string,
  home = homedir(),
  migrateFn: SqliteWatermarkReader = readSqliteWatermark,
): number {
  const key = watermarkKeyFor(url, appId);
  const file = readFile(home);
  if (key in file) return file[key];

  // No JSON checkpoint yet. Migrate the SQLite value ONCE, then persist it so
  // this branch never runs again for this destination (and the native module
  // is never loaded again on a healthy machine).
  const migrated = migrateFn(url, appId, home);
  // Write even a 0: it records "we looked", so a machine with no prior sqlite
  // watermark does not re-attempt the (native-module-loading) migration every
  // run. `sub-ms precision preserved`: JSON numbers are IEEE-754 doubles.
  writeWatermark(url, appId, migrated ?? 0, home);
  return migrated ?? 0;
}

/** Persists the checkpoint for a destination. Atomic (write-then-rename) so a
 * concurrent reader never sees a half-written file. Never throws: a failed
 * checkpoint write must not fail an otherwise-successful sync (the next sync
 * simply re-ships from the last durable checkpoint — idempotent). */
export function writeWatermark(url: string, appId: string, mtimeMs: number, home = homedir()): void {
  try {
    const key = watermarkKeyFor(url, appId);
    const file = readFile(home);
    file[key] = mtimeMs;
    const path = watermarkPath(home);
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, path);
  } catch {
    // best effort — the checkpoint is an optimization, not a correctness gate
  }
}

export type SqliteWatermarkReader = (url: string, appId: string, home: string) => number | null;

/** Minimal structural type for the `node:sqlite` surface used here. Declared
 * locally so the read needs no @types/node bump (the repo pins v20). */
interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => { prepare(sql: string): { get(...params: unknown[]): unknown }; close(): void };
}

/**
 * Reads the watermark the legacy SQLite store holds under
 * `sync_watermark_ms:<host>:<appId>`, so a machine that synced through that
 * store keeps its position.
 *
 * Uses the node:sqlite BUILTIN, loaded lazily inside a try/catch: this is the
 * one place the sync path touches SQLite, and it must degrade to "no prior
 * checkpoint" (return null → start from 0) wherever the builtin (Node < 22.5)
 * or the database is absent. No native dependency — a fresh install needs
 * nothing on disk. node:sqlite reads a better-sqlite3-written db (same
 * on-disk format).
 */
export function readSqliteWatermark(url: string, appId: string, home: string): number | null {
  try {
    const dbPath = join(home, ".outerlayer", "db.sqlite");
    if (!existsSync(dbPath)) return null;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as NodeSqliteModule;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(`sync_watermark_ms:${new URL(url).host}:${appId}`) as { value: string } | undefined;
      if (!row) return null;
      const ms = parseFloat(row.value);
      return Number.isFinite(ms) ? ms : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
