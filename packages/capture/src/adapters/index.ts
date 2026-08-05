// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/** The source-adapter registry — one module per agent under adapters/.
 * Registry order = scan order (claude first: largest corpora, richest data). */
import type { SourceAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";

export const SOURCE_ADAPTERS: SourceAdapter[] = [claudeCodeAdapter, codexAdapter, cursorAdapter];

export { claudeCodeAdapter } from "./claude-code/index.js";
export { codexAdapter, defaultCodexSessionsDir, findCodexRollouts, codexSessionIdFromPath, parseCodexRollout } from "./codex.js";
export { cursorAdapter, parseCursorChat, findCursorChats, cursorChatIdFromPath, workspacesByHash, defaultCursorChatsDir, defaultCursorProjectsDir, rootChildIds } from "./cursor.js";
export type { SourceAdapter } from "./types.js";
