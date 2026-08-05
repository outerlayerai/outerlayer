/**
 * Adapter registry. Adding an agent = add its adapter here and
 * to the dashboard-side descriptor list (src/services/workers/agents.ts).
 *
 * Claude Code is the live-validated reference (one-shot + resume). Codex,
 * Cursor, and opencode are implemented from each CLI's documented interface and
 * flagged `experimental` until validated against the real binary.
 */

import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { opencodeAdapter } from './opencode.js';
import type { WorkerAgentAdapter } from './types.js';

const ADAPTERS: Record<string, WorkerAgentAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
  [codexAdapter.id]: codexAdapter,
  [cursorAdapter.id]: cursorAdapter,
  [opencodeAdapter.id]: opencodeAdapter,
};

export function getAgentAdapter(id: string): WorkerAgentAdapter | null {
  return ADAPTERS[id] ?? null;
}

export function listAgentAdapters(): WorkerAgentAdapter[] {
  return Object.values(ADAPTERS);
}
