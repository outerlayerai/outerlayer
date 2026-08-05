// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalStringify } from "@outerlayer/session-schema";
import { parseTranscript } from "../adapters/claude-code/parse.js";
import { tailTranscript, completePrefix, type Checkpoint } from "../tailer.js";

const BASE = { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/w", gitBranch: "main", version: "2.1.193" };

function line(i: number): string {
  return JSON.stringify({
    ...BASE,
    type: "assistant",
    timestamp: `2026-07-01T10:${String(i).padStart(2, "0")}:00.000Z`,
    message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: `turn ${i}` }], usage: { input_tokens: i, output_tokens: i, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

describe("completePrefix", () => {
  it("drops a partial final line (no trailing newline)", () => {
    expect(completePrefix("a\nb\nhalf")).toBe("a\nb\n");
    expect(completePrefix("a\nb\n")).toBe("a\nb\n");
    expect(completePrefix("nonewline")).toBe("");
  });
});

describe("tailTranscript — incremental == full (the core correctness property)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ol-tail-"));
    file = join(dir, `${BASE.sessionId}.jsonl`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("re-parsing from every checkpoint yields a session identical to a full re-parse", () => {
    const allLines = Array.from({ length: 12 }, (_, i) => line(i));
    const full = parseTranscript(allLines.join("\n") + "\n").session!;
    const fullBytes = canonicalStringify(full);

    // grow the file one line at a time, tailing from the prior checkpoint
    let checkpoint: Checkpoint | undefined;
    let content = "";
    for (let i = 0; i < allLines.length; i++) {
      content += allLines[i] + "\n";
      writeFileSync(file, content);
      const result = tailTranscript(file, checkpoint);
      checkpoint = result.checkpoint;
      if (i === allLines.length - 1) {
        // final incremental parse must equal the from-scratch full parse
        expect(canonicalStringify(result.session!)).toBe(fullBytes);
      }
    }
  });

  it("a partial final line is invisible until its newline arrives (no duplicate/partial turns)", () => {
    // 3 complete lines + a half-written 4th
    const content = line(0) + "\n" + line(1) + "\n" + line(2) + "\n" + '{"type":"assist';
    writeFileSync(file, content);
    const partial = tailTranscript(file, undefined);
    expect(partial.session!.turns).toHaveLength(3);
    expect(partial.checkpoint.lineNo).toBe(3);

    // the newline + rest arrives
    writeFileSync(file, line(0) + "\n" + line(1) + "\n" + line(2) + "\n" + line(3) + "\n");
    const complete = tailTranscript(file, partial.checkpoint);
    expect(complete.session!.turns).toHaveLength(4);
    expect(complete.advanced).toBe(true);
  });

  it("re-tailing an unchanged file reports advanced:false (idempotent, no duplicate emit)", () => {
    writeFileSync(file, line(0) + "\n" + line(1) + "\n");
    const first = tailTranscript(file, undefined);
    const second = tailTranscript(file, first.checkpoint);
    expect(second.advanced).toBe(false);
    expect(canonicalStringify(second.session!)).toBe(canonicalStringify(first.session!));
  });

  it("random split points all reconstruct the same session", () => {
    const allLines = Array.from({ length: 20 }, (_, i) => line(i));
    const whole = allLines.join("\n") + "\n";
    const full = canonicalStringify(parseTranscript(whole).session!);
    // deterministic pseudo-random splits
    for (const split of [1, 4, 7, 11, 13, 17, 19]) {
      const prefix = allLines.slice(0, split).join("\n") + "\n";
      writeFileSync(file, prefix);
      const cp = tailTranscript(file, undefined).checkpoint;
      writeFileSync(file, whole);
      const resumed = tailTranscript(file, cp).session!;
      expect(canonicalStringify(resumed)).toBe(full);
    }
  });
});
