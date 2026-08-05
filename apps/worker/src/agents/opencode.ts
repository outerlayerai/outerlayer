/**
 * opencode adapter.
 *
 * EXPERIMENTAL: implemented from opencode's documented non-interactive `run`
 * interface, NOT yet live-validated against the binary here. opencode is
 * provider-agnostic (it drives whatever model provider you configure), so it
 * accepts either an Anthropic or OpenAI key. Validate against a real opencode
 * before enabling in prod.
 *
 * One-shot: `opencode run --print-logs "<task>"`.
 * Resume:   `opencode run --session <id> --print-logs "<task>"`  (also `--continue`).
 * Output parsing is defensive over opencode's JSON log lines.
 */

import type { AgentCommand, AgentResult, NormalizedEvent, WorkerAgentAdapter } from './types.js';
import { agentMessage, looksLikeFileEdit, parseJsonLine, pickString, toolUse } from './generic-jsonl.js';

export const opencodeAdapter: WorkerAgentAdapter = {
  id: 'opencode',
  displayName: 'opencode',
  // opencode dropped Claude support upstream — Anthropic keys are not usable.
  credentialKeys: { anyOf: ['OPENAI_API_KEY', 'OPENCODE_API_KEY'] },
  supportsResume: true,
  experimental: true,

  command(task): AgentCommand {
    return { argv: ['opencode', 'run', '--print-logs', task], env: {} };
  },

  resumeCommand(sessionRef, task): AgentCommand {
    return { argv: ['opencode', 'run', '--session', sessionRef, '--print-logs', task], env: {} };
  },

  parseLine(line): NormalizedEvent[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];
    const type = (typeof msg.type === 'string' ? msg.type : '').toLowerCase();

    if (type.includes('session') || type.includes('start')) {
      const ref = pickString(msg, ['sessionID', 'session_id', 'session', 'id']);
      return [{ event_type: 'status', payload: { phase: 'agent-launched', session_id: ref } }];
    }

    if (type.includes('assistant') || type.includes('message') || type.includes('text')) {
      const text = pickString(msg, ['text', 'content', 'message']);
      return text ? [agentMessage(text)] : [];
    }

    if (type.includes('tool') || type.includes('command') || type.includes('bash')) {
      const tool = pickString(msg, ['tool', 'name', 'command']) ?? 'tool';
      const events: NormalizedEvent[] = [toolUse(tool, pickString(msg, ['input', 'command', 'summary']) ?? tool)];
      const path = pickString(msg, ['path', 'file', 'file_path']);
      if (path && looksLikeFileEdit(tool)) {
        events.push({ event_type: 'file-change', payload: { path, tool } });
      }
      return events;
    }

    if (type.includes('result') || type.includes('done') || type.includes('complete')) {
      return [
        {
          event_type: 'result',
          payload: {
            result: pickString(msg, ['result', 'text', 'summary']) ?? '',
            is_error: msg.error != null,
          },
        },
      ];
    }

    return [];
  },

  extractResult(events): AgentResult | null {
    const r = [...events].reverse().find((e) => e.event_type === 'result');
    if (!r) return null;
    return { isError: r.payload.is_error === true };
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
