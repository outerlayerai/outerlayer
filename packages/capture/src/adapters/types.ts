// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { AgentSession } from "@outerlayer/session-schema";
import type { ParseResult } from "./claude-code/parse.js";
import type { TranscriptEntry } from "./claude-code/discover.js";

/** Per-adapter root overrides (tests point these at fixtures). */
export interface SourceRoots {
  /** Claude Code transcript root (default ~/.claude/projects). */
  root?: string;
  /** OuterLayer raw-mirror root unioned into claude-code (default ~/.outerlayer/raw). */
  rawRoot?: string;
  /** Codex CLI sessions root (default ~/.codex/sessions). */
  codexRoot?: string;
  /** Cursor chats root (default ~/.cursor/chats). */
  cursorRoot?: string;
  /** Cursor projects dir for workspace-hash → path resolution (default ~/.cursor/projects). */
  cursorProjectsRoot?: string;
}

export interface SourceParseOptions {
  captureTier?: AgentSession["captureTier"];
  /** The roots this scan ran with — adapters that need sibling stores
   * (e.g. cursor's projects dir) read them from here. */
  roots: SourceRoots;
}

/**
 * A source of agent sessions: one coding agent's on-disk store. `discover`
 * finds candidate files; `parse` maps ONE file onto the canonical
 * AgentSession — each adapter reads its own file (claude/codex read JSONL
 * text; cursor reads a SQLite db), so binary stores are first-class.
 * Everything downstream (store, viewer, cloud sync) consumes AgentSession
 * only — adding an agent is exactly one new adapter, nothing else.
 */
export interface SourceAdapter {
  /** Stable id, doubles as AgentSession.agent.type ("claude-code", "codex", "cursor"). */
  id: string;
  discover(roots: SourceRoots): TranscriptEntry[];
  parse(entry: TranscriptEntry, opts: SourceParseOptions): ParseResult;
}
