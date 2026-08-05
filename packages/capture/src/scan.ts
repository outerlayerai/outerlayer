// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { AgentSession } from "@outerlayer/session-schema";
import type { ParseResult, CapturedBlob } from "./adapters/claude-code/parse.js";
import type { TranscriptEntry } from "./adapters/claude-code/discover.js";
import { SOURCE_ADAPTERS, type SourceAdapter } from "./adapters/index.js";

export interface ScanOptions {
  /** Claude Code transcript root (default ~/.claude/projects). */
  root?: string;
  /** Raw-mirror root to union in (default ~/.outerlayer/raw). Sessions that
   * Claude Code already deleted survive here (the deletion-race property). */
  rawRoot?: string;
  /** Codex CLI sessions root (default ~/.codex/sessions). */
  codexRoot?: string;
  /** Cursor chats root (default ~/.cursor/chats). */
  cursorRoot?: string;
  /** Cursor projects dir for workspace-path resolution (default ~/.cursor/projects). */
  cursorProjectsRoot?: string;
  /** Cap to the N most recent transcripts (across all sources). */
  limit?: number;
  captureTier?: AgentSession["captureTier"];
  /** Restrict to specific adapters (default: all registered). */
  adapters?: SourceAdapter[];
  /** Per-session callback (streaming, so 10k sessions don't buffer). `blobs`
   * are the session's image bytes (deduped), for the caller to persist. */
  onSession?: (session: AgentSession, entry: TranscriptEntry, blobs: CapturedBlob[]) => void;
}

export interface ScanReport {
  scanned: number;
  parsed: number;
  skippedEmpty: number;
  /** Union stats: how many sessions came only from the raw mirror. */
  fromRawOnly: number;
  warnings: Record<string, number>;
  versions: string[];
  /** Distinct session ids parsed. */
  sessionIds: number;
  /** Parsed sessions per source adapter ("claude-code", "codex", …). */
  byAgent: Record<string, number>;
}

/**
 * Backfill sweep across ALL registered source adapters (claude-code, codex,
 * …). Each adapter discovers its own on-disk store and parses to the
 * canonical AgentSession; the sweep merges candidates newest-first so
 * `--limit` keeps the most recent work regardless of which agent did it.
 */
export function scanAll(opts: ScanOptions = {}): { report: ScanReport; sessions: AgentSession[] } {
  const adapters = opts.adapters ?? SOURCE_ADAPTERS;
  const roots = { root: opts.root, rawRoot: opts.rawRoot, codexRoot: opts.codexRoot, cursorRoot: opts.cursorRoot, cursorProjectsRoot: opts.cursorProjectsRoot };

  let rawOnly = 0;
  let candidates: { entry: TranscriptEntry; adapter: SourceAdapter }[] = [];
  for (const adapter of adapters) {
    for (const entry of adapter.discover(roots)) {
      if (entry.fromRawOnly) rawOnly += 1;
      candidates.push({ entry, adapter });
    }
  }
  candidates.sort((a, b) => b.entry.mtimeMs - a.entry.mtimeMs);
  if (opts.limit && opts.limit > 0) candidates = candidates.slice(0, opts.limit);

  const warnings: Record<string, number> = {};
  const versions = new Set<string>();
  const sessions: AgentSession[] = [];
  const byAgent: Record<string, number> = {};
  let parsed = 0;
  let skippedEmpty = 0;

  for (const { entry, adapter } of candidates) {
    let result: ParseResult;
    try {
      result = adapter.parse(entry, { roots, ...(opts.captureTier ? { captureTier: opts.captureTier } : {}) });
    } catch {
      skippedEmpty += 1;
      continue;
    }
    for (const [code, count] of Object.entries(result.warnings)) {
      warnings[code] = (warnings[code] ?? 0) + count;
    }
    for (const v of result.versions) versions.add(v);
    if (!result.session) {
      skippedEmpty += 1;
      continue;
    }
    parsed += 1;
    byAgent[adapter.id] = (byAgent[adapter.id] ?? 0) + 1;
    if (opts.onSession) opts.onSession(result.session, entry, result.blobs);
    else sessions.push(result.session);
  }

  const report: ScanReport = {
    scanned: candidates.length,
    parsed,
    skippedEmpty,
    fromRawOnly: rawOnly,
    warnings,
    versions: [...versions].sort(),
    sessionIds: parsed,
    byAgent,
  };
  return { report, sessions };
}
