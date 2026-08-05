/**
 * Claude Code adapter. LIVE-VALIDATED — both one-shot runs and
 * `--resume` session continuity are exercised end-to-end in the e2e.
 *
 * Runs `claude -p "<task>" --output-format stream-json --verbose
 * --permission-mode bypassPermissions`; follow-up turns add `--resume <id>`.
 * The session id is emitted on the `system` init line.
 *
 * The runner executes as root inside an ephemeral Fly microVM, and the CLI
 * refuses bypassed permissions under root unless it's told it's sandboxed.
 * The microVM *is* the isolation boundary, so we set IS_SANDBOX=1 to satisfy
 * that guard.
 */

import type { AgentCommand, AgentResult, NormalizedEvent, WorkerAgentAdapter } from './types.js';

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  if (typeof input.description === 'string' && input.description) return input.description;
  if (typeof input.command === 'string') return input.command.slice(0, 200);
  if (typeof input.file_path === 'string') return `${name} ${input.file_path}`;
  if (typeof input.path === 'string') return `${name} ${input.path}`;
  return name;
}

function filePathFromToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.notebook_path === 'string') return input.notebook_path;
  return undefined;
}

const BASE_FLAGS = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'bypassPermissions',
];

// Tells the CLI its root process is sandboxed so bypassPermissions is allowed
// (the runner is root inside an ephemeral Fly microVM). Without it the agent
// exits 1: "cannot be used with root/sudo privileges".
const SANDBOX_ENV = { IS_SANDBOX: '1' } as const;

// `claude --model` accepts an alias (opus|sonnet|haiku) or a full id; the CLI
// resolves aliases to the current model. Absent → the CLI's own default.
function modelFlag(model: string | undefined): string[] {
  return model ? ['--model', model] : [];
}

export const claudeCodeAdapter: WorkerAgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  // API key only — subscription OAuth tokens must not ride third-party infra
  // (Anthropic credential policy; see the dashboard agent registry).
  credentialKeys: { anyOf: ['ANTHROPIC_API_KEY'] },
  supportsResume: true,

  command(task, opts): AgentCommand {
    return { argv: ['claude', '-p', task, ...modelFlag(opts?.model), ...BASE_FLAGS], env: { ...SANDBOX_ENV } };
  },

  resumeCommand(sessionRef, task, opts): AgentCommand {
    return {
      argv: ['claude', '-p', task, '--resume', sessionRef, ...modelFlag(opts?.model), ...BASE_FLAGS],
      env: { ...SANDBOX_ENV },
    };
  },

  parseLine(line): NormalizedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [];
    }

    switch (msg.type) {
      case 'system':
        return [
          {
            event_type: 'status',
            payload: {
              phase: 'agent-launched',
              model: (msg as { model?: unknown }).model,
              session_id: (msg as { session_id?: unknown }).session_id,
            },
          },
        ];

      case 'assistant': {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) return [];
        const events: NormalizedEvent[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            events.push({ event_type: 'agent-message', payload: { text: block.text } });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            const input = block.input as Record<string, unknown> | undefined;
            events.push({
              event_type: 'tool-use',
              payload: { tool: block.name, summary: summarizeToolInput(block.name, input) },
            });
            if (FILE_EDIT_TOOLS.has(block.name)) {
              const filePath = filePathFromToolInput(input);
              if (filePath) {
                events.push({ event_type: 'file-change', payload: { path: filePath, tool: block.name } });
              }
            }
          }
        }
        return events;
      }

      case 'result':
        return [
          {
            event_type: 'result',
            payload: {
              result: (msg as { result?: unknown }).result,
              is_error: (msg as { is_error?: unknown }).is_error === true,
              cost_usd: (msg as { total_cost_usd?: unknown }).total_cost_usd,
              num_turns: (msg as { num_turns?: unknown }).num_turns,
              duration_ms: (msg as { duration_ms?: unknown }).duration_ms,
            },
          },
        ];

      default:
        return [];
    }
  },

  extractResult(events): AgentResult | null {
    const resultEvent = [...events].reverse().find((e) => e.event_type === 'result');
    if (!resultEvent) return null;
    const p = resultEvent.payload;
    return {
      costUsd: typeof p.cost_usd === 'number' ? p.cost_usd : undefined,
      numTurns: typeof p.num_turns === 'number' ? p.num_turns : undefined,
      isError: p.is_error === true,
    };
  },

  captureSessionRef(events): string | null {
    // The session id rides on the first `status` (agent-launched) event.
    for (const e of events) {
      if (e.event_type === 'status' && typeof e.payload.session_id === 'string') {
        return e.payload.session_id;
      }
    }
    return null;
  },
};
