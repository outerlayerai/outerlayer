// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactSpoolRecord, Turn } from "@outerlayer/session-schema";
import {
  appendArtifactRecord,
  artifactBlobsDir,
  artifactsSpoolPath,
  artifactsWatermarkPath,
  planArtifactUpload,
  readArtifactRecordsSince,
  readArtifactsWatermark,
  resolveArtifactTurnIndex,
  writeArtifactsWatermark,
  ARTIFACT_RETRY_MAX_AGE_MS,
} from "../artifact-spool.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-artspool-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function record(over: Partial<ArtifactSpoolRecord> = {}): ArtifactSpoolRecord {
  return {
    rec: "artifact",
    artifactId: "art-1",
    t: "2026-08-14T10:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/work/app",
    filename: "shot.png",
    mediaType: "image/png",
    bytes: 3,
    sha256: "ab".repeat(32),
    caption: "the checkout page renders",
    ...over,
  };
}

describe("spool paths", () => {
  it("namespaces every spool file under the given home", () => {
    expect(artifactsSpoolPath(home)).toBe(join(home, ".outerlayer", "spool", "artifacts.jsonl"));
    expect(artifactBlobsDir(home)).toBe(join(home, ".outerlayer", "spool", "artifact-blobs"));
    expect(artifactsWatermarkPath(home)).toBe(join(home, ".outerlayer", "spool", "artifacts.watermark"));
  });
});

describe("artifact watermark", () => {
  it("reads 0 when no watermark file exists yet", () => {
    expect(readArtifactsWatermark(home)).toBe(0);
  });

  it("round-trips an exact byte offset", () => {
    writeArtifactsWatermark(4321, home);
    expect(readArtifactsWatermark(home)).toBe(4321);
  });

  it("clamps a negative watermark value to 0 — a corrupt file must never rewind the offset", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(artifactsWatermarkPath(home), "-9");
    expect(readArtifactsWatermark(home)).toBe(0);
  });

  it("clamps non-numeric watermark content to 0", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(artifactsWatermarkPath(home), "garbage");
    expect(readArtifactsWatermark(home)).toBe(0);
  });
});

describe("appendArtifactRecord + readArtifactRecordsSince", () => {
  it("round-trips records with the byte offset each line starts at", () => {
    const first = record();
    const second = record({ artifactId: "art-2", filename: "demo.webm", mediaType: "video/webm" });
    appendArtifactRecord(first, home);
    appendArtifactRecord(second, home);

    const firstLineBytes = Buffer.byteLength(JSON.stringify(first) + "\n");
    const { records, fileLength } = readArtifactRecordsSince(home, 0);
    expect(records).toEqual([
      { record: first, offset: 0 },
      { record: second, offset: firstLineBytes },
    ]);
    expect(fileLength).toBe(readFileSync(artifactsSpoolPath(home)).length);
  });

  it("reads only records strictly after the given offset", () => {
    const first = record();
    const second = record({ artifactId: "art-2" });
    appendArtifactRecord(first, home);
    const offset = readFileSync(artifactsSpoolPath(home)).length;
    appendArtifactRecord(second, home);

    const { records } = readArtifactRecordsSince(home, offset);
    expect(records).toEqual([{ record: second, offset }]);
  });

  it("skips a malformed line but still consumes past it", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(artifactsSpoolPath(home), "{ not json\n");
    const good = record();
    const goodOffset = readFileSync(artifactsSpoolPath(home)).length;
    appendFileSync(artifactsSpoolPath(home), JSON.stringify(good) + "\n");

    const { records, fileLength } = readArtifactRecordsSince(home, 0);
    expect(records).toEqual([{ record: good, offset: goodOffset }]);
    expect(fileLength).toBe(readFileSync(artifactsSpoolPath(home)).length);
  });

  it("skips a JSON line that is not a valid spool record (schema gate, not just JSON.parse)", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(artifactsSpoolPath(home), JSON.stringify({ rec: "artifact", filename: "x" }) + "\n");
    appendArtifactRecord(record(), home);

    const { records } = readArtifactRecordsSince(home, 0);
    expect(records.map((r) => r.record.artifactId)).toEqual(["art-1"]);
  });

  it("reads the last line correctly even without a trailing newline (a write that got cut off)", () => {
    mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
    writeFileSync(artifactsSpoolPath(home), JSON.stringify(record()));
    const { records, fileLength } = readArtifactRecordsSince(home, 0);
    expect(records).toEqual([{ record: record(), offset: 0 }]);
    expect(fileLength).toBe(Buffer.byteLength(JSON.stringify(record())));
  });

  it("computes offsets in bytes, not string characters — captions may carry non-ASCII text", () => {
    const first = record({ caption: "vérifié ✓" });
    const second = record({ artifactId: "art-2" });
    appendArtifactRecord(first, home);
    appendArtifactRecord(second, home);
    const { records } = readArtifactRecordsSince(home, 0);
    expect(records[1]!.offset).toBe(Buffer.byteLength(JSON.stringify(first) + "\n"));
    expect(records[1]!.record.artifactId).toBe("art-2");
  });

  it("returns nothing (and the sinceOffset as length) when the spool file is missing", () => {
    expect(readArtifactRecordsSince(home, 77)).toEqual({ records: [], fileLength: 77 });
  });

  it("swallows append errors — spool bookkeeping must never crash the emitting command", () => {
    // A FILE where the home directory should be makes every mkdir fail.
    const notADir = join(home, "not-a-dir");
    writeFileSync(notADir, "x");
    expect(() => appendArtifactRecord(record(), notADir)).not.toThrow();
    expect(readArtifactRecordsSince(notADir, 0)).toEqual({ records: [], fileLength: 0 });
  });
});

describe("planArtifactUpload", () => {
  it("returns every record after the stored watermark, with fullyConsumedOffset at the file length", () => {
    const first = record();
    const second = record({ artifactId: "art-2" });
    appendArtifactRecord(first, home);
    const mid = readFileSync(artifactsSpoolPath(home)).length;
    appendArtifactRecord(second, home);
    writeArtifactsWatermark(mid, home);

    const plan = planArtifactUpload({ home });
    expect(plan.records).toEqual([{ record: second, offset: mid }]);
    expect(plan.fullyConsumedOffset).toBe(readFileSync(artifactsSpoolPath(home)).length);
  });

  it("an empty window plans nothing but still reports the current file length", () => {
    appendArtifactRecord(record(), home);
    const length = readFileSync(artifactsSpoolPath(home)).length;
    writeArtifactsWatermark(length, home);
    expect(planArtifactUpload({ home })).toEqual({ records: [], fullyConsumedOffset: length });
  });
});

describe("ARTIFACT_RETRY_MAX_AGE_MS", () => {
  it("is 14 days — the drop deadline for records that keep failing to upload", () => {
    expect(ARTIFACT_RETRY_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("resolveArtifactTurnIndex", () => {
  function turn(index: number, toolCalls: Turn["toolCalls"]): Turn {
    return { index, role: "assistant", toolCalls } as Turn;
  }

  it("finds the turn whose tool-call input mentions `emit artifact` plus the filename", () => {
    const turns: Turn[] = [
      turn(0, []),
      turn(1, [{ name: "Bash", status: "ok", isEdit: false, input: { command: 'outerlayer emit artifact shot.png --caption "proof"' } }]),
    ];
    expect(resolveArtifactTurnIndex(turns, "shot.png")).toBe(1);
  });

  it("matches string output as well as structured input", () => {
    const turns: Turn[] = [
      turn(3, [{ name: "Bash", status: "ok", isEdit: false, output: "✓ ran: emit artifact demo.webm (spooled)" }]),
    ];
    expect(resolveArtifactTurnIndex(turns, "demo.webm")).toBe(3);
  });

  it("returns the turn's own index field, not its array position", () => {
    const turns: Turn[] = [
      turn(7, [{ name: "Bash", status: "ok", isEdit: false, input: "outerlayer emit artifact shot.png" }]),
    ];
    expect(resolveArtifactTurnIndex(turns, "shot.png")).toBe(7);
  });

  it("requires BOTH the phrase and the filename — either alone is not the emitting call", () => {
    const phraseOnly: Turn[] = [
      turn(0, [{ name: "Bash", status: "ok", isEdit: false, input: "outerlayer emit artifact other.png" }]),
    ];
    expect(resolveArtifactTurnIndex(phraseOnly, "shot.png")).toBeUndefined();
    const filenameOnly: Turn[] = [
      turn(0, [{ name: "Read", status: "ok", isEdit: false, input: { file_path: "/work/shot.png" } }]),
    ];
    expect(resolveArtifactTurnIndex(filenameOnly, "shot.png")).toBeUndefined();
  });

  it("returns undefined when tool text was stripped (redacted tiers carry no input/output)", () => {
    const turns: Turn[] = [turn(1, [{ name: "Bash", status: "ok", isEdit: false }])];
    expect(resolveArtifactTurnIndex(turns, "shot.png")).toBeUndefined();
  });
});
