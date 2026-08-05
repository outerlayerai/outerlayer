// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default Claude Code transcript root. */
export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** Default OuterLayer raw-mirror root (the copy-out daemon's target). */
export function defaultRawDir(): string {
  return join(homedir(), ".outerlayer", "raw");
}

export interface TranscriptEntry {
  file: string;
  mtimeMs: number;
  bytes: number;
  /** A Task-tool subagent transcript (lives under `<parent>/subagents/`). */
  isSubagent: boolean;
  /** For a subagent: the PARENT session id (the directory above `subagents/`).
   * The subagent's own JSONL `sessionId` is inherited from the parent, so this
   * path-derived value is the authoritative parent link. */
  parentSessionId?: string;
  /** For a subagent: its own stable id (the filename stem), used as the
   * session id so it never collides with the parent. */
  ownId?: string;
  /** Entry exists only in the OuterLayer raw mirror (live copy deleted). */
  fromRawOnly?: boolean;
}

/**
 * Find transcript files under `root`, recursively. Layout:
 *   <root>/<encoded-project>/<session-uuid>.jsonl              (main)
 *   <root>/<encoded-project>/<uuid>/subagents/*.jsonl          (Task subagent)
 *   <root>/<encoded-project>/<uuid>/subagents/workflows/wf_<run>/agent-<hash>.jsonl (Workflow agent)
 * Returned newest-first by mtime so `--limit` keeps the most recent.
 * Missing root ⇒ [] (empty-state is a friendly path, not an error).
 */
export function findTranscripts(root = defaultProjectsDir()): TranscriptEntry[] {
  const found: TranscriptEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.endsWith(".jsonl") && st.size > 0) {
        // A subagent transcript lives under a `subagents/` dir inside its
        // parent session's dir — at ANY depth. Task-tool agents sit directly
        // (`<parent-session>/subagents/agent-*.jsonl`); Workflow-tool agents
        // nest deeper (`<parent-session>/subagents/workflows/wf_*/agent-*.jsonl`).
        // Detect by ancestry, not the immediate dir: a subagent's JSONL
        // `sessionId` is INHERITED from the parent, so treating one as a main
        // session collides hundreds of agents onto one id and ReplacingMergeTree
        // collapses them server-side. The parent session id is the path
        // segment just above `subagents`.
        const segments = p.split(/[/\\]/);
        const subagentsIdx = segments.lastIndexOf("subagents");
        const isSubagent = subagentsIdx > 0;
        found.push({
          file: p,
          mtimeMs: st.mtimeMs,
          bytes: st.size,
          isSubagent,
          ...(isSubagent
            ? { parentSessionId: segments[subagentsIdx - 1] || undefined, ownId: sessionIdFromPath(name) }
            : {}),
        });
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/** Session id from a transcript path (the file stem is the session uuid). */
export function sessionIdFromPath(file: string): string {
  const base = file.split(/[/\\]/).pop() ?? file;
  return base.replace(/\.jsonl$/, "");
}
