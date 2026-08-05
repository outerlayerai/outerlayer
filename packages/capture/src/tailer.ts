// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readFileSync } from "node:fs";
import type { AgentSession } from "@outerlayer/session-schema";
import { parseTranscript, type ParseOptions } from "./adapters/claude-code/parse.js";
import { sessionIdFromPath } from "./adapters/claude-code/discover.js";

/**
 * A tailer checkpoint. The incremental correctness property:
 * re-parsing from ANY checkpoint yields a session byte-identical to a full
 * re-parse. We achieve that by always re-parsing whole *lines* — the
 * checkpoint records the last COMPLETE-line byte offset, and a partial final
 * line (live write) is never consumed until it's terminated by a newline.
 */
export interface Checkpoint {
  filePath: string;
  /** Byte offset just past the last newline consumed. */
  byteOffset: number;
  /** Count of complete lines consumed so far. */
  lineNo: number;
}

export interface TailResult {
  session: AgentSession | null;
  checkpoint: Checkpoint;
  /** True when new complete lines were consumed since the prior checkpoint. */
  advanced: boolean;
}

/**
 * Parse a transcript from scratch. Because Claude Code rewrites usage/summary
 * state across the file, we always parse the whole file for a correct session;
 * the checkpoint exists to answer "did anything new land?" cheaply and to make
 * the daemon idempotent (no duplicate emits when nothing changed).
 */
export function tailTranscript(
  filePath: string,
  prior: Checkpoint | undefined,
  opts: ParseOptions = {},
): TailResult {
  const content = readFileSync(filePath, "utf8");
  const complete = completePrefix(content);

  const checkpoint: Checkpoint = {
    filePath,
    byteOffset: Buffer.byteLength(complete, "utf8"),
    lineNo: countLines(complete),
  };
  const advanced = !prior || checkpoint.byteOffset > prior.byteOffset || checkpoint.lineNo !== prior.lineNo;

  const parseOpts: ParseOptions = { fallbackId: sessionIdFromPath(filePath), ...opts };
  // Parse the COMPLETE prefix only — a half-written trailing line is invisible
  // until its newline arrives, so incremental == full at every boundary.
  const { session } = parseTranscript(complete, parseOpts);
  return { session, checkpoint, advanced };
}

/** The prefix of `content` up to and including the last newline. A file with
 * no trailing newline (live write in progress) drops its final partial line. */
export function completePrefix(content: string): string {
  const lastNewline = content.lastIndexOf("\n");
  if (lastNewline === -1) return ""; // nothing complete yet
  return content.slice(0, lastNewline + 1);
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}
