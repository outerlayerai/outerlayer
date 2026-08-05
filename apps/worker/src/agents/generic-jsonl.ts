/**
 * Shared helpers for JSON-lines agent adapters.
 *
 * Several coding-agent CLIs emit newline-delimited JSON events whose exact
 * schemas differ but rhyme (an init/session event, assistant text, tool/command
 * executions, a terminal result). These helpers let each adapter map its own
 * shape while sharing the defensive parsing: a malformed or unrecognized line
 * yields no events and never throws, so an unexpected schema degrades to "raw
 * log only" rather than crashing the run.
 */

import type { NormalizedEvent } from './types.js';

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** First string-valued property among `keys`, searched shallowly then one level deep. */
export function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof obj[k] === 'string') return obj[k] as string;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      for (const k of keys) {
        const nested = (v as Record<string, unknown>)[k];
        if (typeof nested === 'string') return nested;
      }
    }
  }
  return undefined;
}

const FILE_EDIT_TOOL_HINTS = ['edit', 'write', 'apply_patch', 'create_file', 'str_replace'];

/** Best-effort: does a tool name look like it edits files? */
export function looksLikeFileEdit(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return FILE_EDIT_TOOL_HINTS.some((h) => n.includes(h));
}

export function agentMessage(text: string): NormalizedEvent {
  return { event_type: 'agent-message', payload: { text } };
}

export function toolUse(tool: string, summary: string): NormalizedEvent {
  return { event_type: 'tool-use', payload: { tool, summary } };
}
