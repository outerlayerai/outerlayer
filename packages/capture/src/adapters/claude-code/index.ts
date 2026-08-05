// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { readFileSync } from "node:fs";
import type { SourceAdapter } from "../types.js";
import { defaultProjectsDir, defaultRawDir, findTranscripts, sessionIdFromPath } from "./discover.js";
import { parseTranscript } from "./parse.js";

/**
 * claude-code: union of the live store and the OuterLayer raw mirror, keyed
 * by session id — the raw copy fills gaps where Claude Code already deleted
 * the transcript (the deletion-race property).
 */
export const claudeCodeAdapter: SourceAdapter = {
  id: "claude-code",
  discover(roots) {
    const live = findTranscripts(roots.root ?? defaultProjectsDir());
    const raw = findTranscripts(roots.rawRoot ?? defaultRawDir());
    const byId = new Map(live.map((e) => [sessionIdFromPath(e.file), e]));
    for (const entry of raw) {
      const id = sessionIdFromPath(entry.file);
      if (!byId.has(id)) byId.set(id, { ...entry, fromRawOnly: true });
    }
    return [...byId.values()];
  },
  parse(entry, opts) {
    return parseTranscript(readFileSync(entry.file, "utf8"), {
      fallbackId: sessionIdFromPath(entry.file),
      isSubagent: entry.isSubagent,
      ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
      ...(entry.ownId ? { ownId: entry.ownId } : {}),
      ...(opts.captureTier ? { captureTier: opts.captureTier } : {}),
    });
  },
};
