/**
 * Runs the agent CLI as a child process: spawns the adapter's
 * argv in the workspace with the agent env, streams stdout line-by-line
 * through the adapter's parser, and enforces the wall-clock cap by killing the
 * process tree when it fires. Returns the accumulated normalized events + a
 * bounded raw-log tail + how it terminated.
 */

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { NormalizedEvent, WorkerAgentAdapter } from '../agents/types.js';

type AgentTermination = 'exited' | 'error' | 'timeout';

export interface RunAgentResult {
  termination: AgentTermination;
  exitCode: number | null;
  events: NormalizedEvent[];
  rawLogTail: string;
}

export interface RunAgentOptions {
  adapter: WorkerAgentAdapter;
  task: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  wallClockCapS: number;
  /** Adapter-specific model id/alias; absent = the agent CLI's default. */
  model?: string;
  maxRawLogChars: number;
  /** Called for every batch of parsed events (the reporter enqueues them). */
  onEvents: (events: NormalizedEvent[]) => void;
  /** Called with every raw stdout line BEFORE parsing — the transcript tee.
   * Raw stdout only (the agent's stream-json); stderr stays out. */
  onRawLine?: (line: string) => void;
  /**
   * Override how the CLI invocation is built (e.g. a resume command for a
   * persistent follow-up turn). Defaults to `adapter.command(task, …)`.
   */
  buildCommand?: (adapter: WorkerAgentAdapter) => { argv: string[]; env: Record<string, string> };
  /** Injected in tests to avoid a real spawn. */
  spawnImpl?: typeof spawn;
}

export function runAgentProcess(options: RunAgentOptions): Promise<RunAgentResult> {
  const spawnFn = options.spawnImpl ?? spawn;
  const { adapter } = options;
  const { argv, env: adapterEnv } = options.buildCommand
    ? options.buildCommand(adapter)
    : adapter.command(options.task, {
        workspace: options.workspace,
        wallClockCapS: options.wallClockCapS,
        model: options.model,
      });
  const [command, ...args] = argv;

  return new Promise<RunAgentResult>((resolve) => {
    const events: NormalizedEvent[] = [];
    let rawLog = '';
    let settled = false;

    const child = spawnFn(command!, args, {
      cwd: options.workspace,
      env: { ...options.env, ...adapterEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const appendRaw = (chunk: string) => {
      rawLog += chunk;
      if (rawLog.length > options.maxRawLogChars) {
        rawLog = rawLog.slice(-options.maxRawLogChars);
      }
    };

    const finish = (termination: AgentTermination, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ termination, exitCode, events, rawLogTail: rawLog });
    };

    const timer = setTimeout(() => {
      // Kill the whole process tree; the agent may have spawned children.
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish('timeout', null);
    }, options.wallClockCapS * 1000);

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        appendRaw(line + '\n');
        options.onRawLine?.(line);
        const parsed = adapter.parseLine(line);
        if (parsed.length > 0) {
          events.push(...parsed);
          options.onEvents(parsed);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => appendRaw(data.toString('utf8')));
    }

    child.on('error', (err) => {
      appendRaw(`spawn error: ${err.message}\n`);
      finish('error', null);
    });
    child.on('close', (code) => finish('exited', code));
  });
}
