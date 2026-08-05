/**
 * Cursor CLI adapter (`cursor-agent`).
 *
 * EXPERIMENTAL: implemented from Cursor's documented headless interface, NOT
 * yet live-validated against the binary here. Cursor's CLI closely mirrors
 * Claude Code's (`-p`, `--output-format stream-json`, `--resume <chatId>`), so
 * the parser reuses the same event shapes with defensive fallbacks. Validate
 * against a real `cursor-agent` before enabling in prod.
 *
 * One-shot: `cursor-agent -p "<task>" --output-format stream-json --force`.
 * Resume:   `cursor-agent -p "<task>" --resume <chatId> --output-format stream-json --force`.
 */

import type { AgentCommand, AgentResult, NormalizedEvent, WorkerAgentAdapter } from './types.js';
import { agentMessage, looksLikeFileEdit, parseJsonLine, pickString, toolUse } from './generic-jsonl.js';

const BASE = ['--output-format', 'stream-json', '--force'];

export const cursorAdapter: WorkerAgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor CLI',
  credentialKeys: { anyOf: ['CURSOR_API_KEY'] },
  supportsResume: true,
  experimental: true,

  command(task): AgentCommand {
    return { argv: ['cursor-agent', '-p', task, ...BASE], env: {} };
  },

  resumeCommand(sessionRef, task): AgentCommand {
    return { argv: ['cursor-agent', '-p', task, '--resume', sessionRef, ...BASE], env: {} };
  },

  parseLine(line): NormalizedEvent[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];
    const type = typeof msg.type === 'string' ? msg.type : '';

    if (type === 'system' || type.includes('session') || type.includes('init')) {
      const ref = pickString(msg, ['chatId', 'chat_id', 'session_id', 'id']);
      return [{ event_type: 'status', payload: { phase: 'agent-launched', session_id: ref } }];
    }

    // Claude-shaped assistant blocks.
    if (type === 'assistant') {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        const events: NormalizedEvent[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            events.push(agentMessage(block.text));
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const input = block.input as Record<string, unknown> | undefined;
            const summary = pickString(input ?? {}, ['description', 'command', 'file_path']) ?? block.name;
            events.push(toolUse(block.name, summary));
            const path = input && typeof input.file_path === 'string' ? input.file_path : undefined;
            if (path && looksLikeFileEdit(block.name)) {
              events.push({ event_type: 'file-change', payload: { path, tool: block.name } });
            }
          }
        }
        return events;
      }
      // Flat text fallback.
      const text = pickString(msg, ['text', 'message']);
      return text ? [agentMessage(text)] : [];
    }

    if (type === 'result') {
      return [
        {
          event_type: 'result',
          payload: {
            result: pickString(msg, ['result', 'text']) ?? '',
            is_error: (msg as { is_error?: unknown }).is_error === true,
            cost_usd: typeof (msg as { total_cost_usd?: unknown }).total_cost_usd === 'number'
              ? (msg as { total_cost_usd: number }).total_cost_usd
              : undefined,
          },
        },
      ];
    }

    return [];
  },

  extractResult(events): AgentResult | null {
    const r = [...events].reverse().find((e) => e.event_type === 'result');
    if (!r) return null;
    return {
      costUsd: typeof r.payload.cost_usd === 'number' ? r.payload.cost_usd : undefined,
      isError: r.payload.is_error === true,
    };
  },

  captureSessionRef(events): string | null {
    for (const e of events) {
      if (e.event_type === 'status' && typeof e.payload.session_id === 'string') {
        return e.payload.session_id;
      }
    }
    return null;
  },
};
