/**
 * Codex CLI adapter (OpenAI).
 *
 * EXPERIMENTAL: implemented from Codex's documented non-interactive interface
 * (`codex exec --json`), NOT yet live-validated against the binary in this
 * repo's e2e. Validate against a real Codex CLI before enabling in prod.
 *
 * One-shot: `codex exec --json --full-auto "<task>"`.
 * Resume:   `codex exec resume <session> --json --full-auto "<task>"`.
 * Codex emits JSONL events; the session/thread id appears on its init event.
 * Parsing is defensive — unknown event shapes are skipped, never thrown.
 */

import type { AgentCommand, AgentResult, NormalizedEvent, WorkerAgentAdapter } from './types.js';
import { agentMessage, looksLikeFileEdit, parseJsonLine, pickString, toolUse } from './generic-jsonl.js';

const BASE = ['exec', '--json', '--full-auto'];

export const codexAdapter: WorkerAgentAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  credentialKeys: { anyOf: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
  supportsResume: true,
  experimental: true,

  command(task): AgentCommand {
    return { argv: ['codex', ...BASE, task], env: {} };
  },

  resumeCommand(sessionRef, task): AgentCommand {
    return { argv: ['codex', 'exec', 'resume', sessionRef, '--json', '--full-auto', task], env: {} };
  },

  parseLine(line): NormalizedEvent[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];
    const type = typeof msg.type === 'string' ? msg.type : '';

    // Session init — surface the resume handle on a status event.
    if (type.includes('session') || type.includes('thread.started') || type === 'configured') {
      const ref = pickString(msg, ['session_id', 'thread_id', 'id', 'session']);
      return [{ event_type: 'status', payload: { phase: 'agent-launched', session_id: ref } }];
    }

    // Terminal result: Codex signals task completion.
    if (type.includes('turn.completed') || type.includes('task_complete') || type === 'result') {
      const usage = (msg.usage ?? (msg as { info?: unknown }).info) as Record<string, unknown> | undefined;
      return [
        {
          event_type: 'result',
          payload: {
            result: pickString(msg, ['text', 'message', 'summary']) ?? '',
            is_error: msg.error != null || msg.status === 'error',
            cost_usd: typeof usage?.cost_usd === 'number' ? usage.cost_usd : undefined,
          },
        },
      ];
    }

    // Assistant/agent message.
    if (type.includes('message') || type.includes('agent') || type.includes('item')) {
      const text = pickString(msg, ['text', 'content', 'message']);
      const events: NormalizedEvent[] = [];
      if (text) events.push(agentMessage(text));
      return events;
    }

    // Command / tool execution.
    if (type.includes('command') || type.includes('exec') || type.includes('tool')) {
      const cmd = pickString(msg, ['command', 'cmd', 'name']) ?? 'command';
      const events: NormalizedEvent[] = [toolUse(cmd, cmd.slice(0, 200))];
      const path = pickString(msg, ['path', 'file', 'file_path']);
      if (path && looksLikeFileEdit(cmd)) {
        events.push({ event_type: 'file-change', payload: { path, tool: cmd } });
      }
      return events;
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
      const ref = e.payload.session_id ?? e.payload.thread_id ?? e.payload.session_ref;
      if (typeof ref === 'string') return ref;
    }
    return null;
  },
};
