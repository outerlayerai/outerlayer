// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The artifact spool. `emit artifact` inside a recorded session appends an
 * ArtifactSpoolRecord line to `~/.outerlayer/spool/artifacts.jsonl` and
 * parks the bytes content-addressed under `artifact-blobs/<sha256>`; sync
 * consumes both and uploads each record bound to the session (and turn)
 * that produced it. Mirrors hook-exec-merge.ts's spool contract: append-only
 * JSONL, a byte-offset watermark the CALLER commits only after a successful
 * non-dry-run sync, malformed lines skipped but consumed, and a held-back
 * offset for any record that must be retried.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ArtifactSpoolRecordSchema, type ArtifactSpoolRecord, type Turn } from "@outerlayer/session-schema";

export function artifactsSpoolPath(home = homedir()): string {
  return join(home, ".outerlayer", "spool", "artifacts.jsonl");
}

export function artifactBlobsDir(home = homedir()): string {
  return join(home, ".outerlayer", "spool", "artifact-blobs");
}

export function artifactsWatermarkPath(home = homedir()): string {
  return join(home, ".outerlayer", "spool", "artifacts.watermark");
}

/** A record still failing past this age is dropped instead of retried
 * forever — the session (or server-side validation refusing it) is not
 * coming back, and one dead record must not warn on every sync for good. */
export const ARTIFACT_RETRY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Appends one spool record. Throws on failure: unlike hook telemetry, the
 * spool record IS the deliverable here — a swallowed append would let the
 * emitting command print success while the artifact never uploads. */
export function appendArtifactRecord(record: ArtifactSpoolRecord, home = homedir()): void {
  const path = artifactsSpoolPath(home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

export function readArtifactsWatermark(home = homedir()): number {
  try {
    const raw = readFileSync(artifactsWatermarkPath(home), "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Atomic (write-then-rename), matching the hook-exec watermark. Never
 * throws: a failed checkpoint write must not fail an otherwise-successful
 * sync — the next run re-reads the same records and re-uploads them
 * idempotently (the clientArtifactId is stable per record). */
export function writeArtifactsWatermark(offset: number, home = homedir()): void {
  try {
    const path = artifactsWatermarkPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, String(offset));
    renameSync(tmp, path);
  } catch {
    // best effort — the checkpoint is an optimization, not a correctness gate
  }
}

export function artifactsUploadedIdsPath(home = homedir()): string {
  return join(home, ".outerlayer", "spool", "artifacts.uploaded.json");
}

/** Client artifact ids that already uploaded but whose spool records still
 * sit at or above the watermark (an earlier record's failure held it back).
 * The next sync must skip them — without this set it would re-read those
 * records, find their blobs already cleaned up, and report an artifact that
 * uploaded fine as lost. */
export function readUploadedArtifactIds(home = homedir()): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(artifactsUploadedIdsPath(home), "utf8")) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** Atomic and best-effort, like the watermark: losing this file costs only
 * an idempotent re-POST (clientArtifactId is stable per record). */
export function writeUploadedArtifactIds(ids: ReadonlySet<string>, home = homedir()): void {
  try {
    const path = artifactsUploadedIdsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...ids]));
    renameSync(tmp, path);
  } catch {
    // best effort — the set is an optimization, not a correctness gate
  }
}

export interface PendingArtifact {
  record: ArtifactSpoolRecord;
  /** Byte offset of this record's line — where the watermark must hold if
   * the upload fails, so the next sync sees the record again. */
  offset: number;
}

/** Reads spool records strictly after `sinceOffset`, in BYTES (captions may
 * carry non-ASCII text). A line that is not JSON — or not a valid
 * ArtifactSpoolRecord — is skipped but still consumed: one corrupt line
 * must not wedge every record behind it forever. */
export function readArtifactRecordsSince(
  home: string,
  sinceOffset: number,
): { records: PendingArtifact[]; fileLength: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(artifactsSpoolPath(home));
  } catch {
    return { records: [], fileLength: sinceOffset };
  }
  const records: PendingArtifact[] = [];
  let pos = Math.min(Math.max(sinceOffset, 0), buf.length);
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const textEnd = nl === -1 ? buf.length : nl;
    const lineEnd = nl === -1 ? buf.length : nl + 1;
    const text = buf.subarray(pos, textEnd).toString("utf8").trim();
    if (text) {
      try {
        const parsed = ArtifactSpoolRecordSchema.safeParse(JSON.parse(text));
        if (parsed.success) records.push({ record: parsed.data, offset: pos });
      } catch {
        // skip malformed line; still consumes past it below
      }
    }
    pos = lineEnd;
    if (nl === -1) break;
  }
  return { records, fileLength: buf.length };
}

export interface ArtifactUploadPlan {
  records: PendingArtifact[];
  /** The offset safe to persist IF every record uploads — the caller lowers
   * it to the earliest failed record's offset otherwise (min-offset rule,
   * identical to hook-exec's). */
  fullyConsumedOffset: number;
}

/** Reads the records pending upload since the last watermark. No writes
 * here — the watermark commit is the caller's job, done only after a
 * successful non-dry-run sync, exactly like planHookExecMerge. */
export function planArtifactUpload(opts: { home?: string } = {}): ArtifactUploadPlan {
  const home = opts.home ?? homedir();
  const { records, fileLength } = readArtifactRecordsSince(home, readArtifactsWatermark(home));
  return { records, fullyConsumedOffset: fileLength };
}

/**
 * The turn an artifact was emitted from, located by text: the tool call
 * that ran `emit artifact <filename>` mentions both. The LAST matching turn
 * wins — a re-emit of the same filename binds to the run that produced this
 * record, and an earlier turn that merely discussed the command cannot
 * capture the binding. Lower capture tiers strip tool input/output, so
 * absence is expected — the artifact then binds to the session root rather
 * than guessing a wrong turn.
 */
export function resolveArtifactTurnIndex(turns: ReadonlyArray<Turn>, filename: string): number | undefined {
  let found: number | undefined;
  for (const turn of turns) {
    for (const call of turn.toolCalls ?? []) {
      const haystack = [
        call.name,
        typeof call.input === "string" ? call.input : call.input === undefined ? "" : JSON.stringify(call.input),
        typeof call.output === "string" ? call.output : call.output === undefined ? "" : JSON.stringify(call.output),
        call.file ?? "",
      ].join("\n");
      if (haystack.includes("emit artifact") && haystack.includes(filename)) found = turn.index;
    }
  }
  return found;
}
