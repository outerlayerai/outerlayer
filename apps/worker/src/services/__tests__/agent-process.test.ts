/**
 * runAgentProcess drives the agent CLI as a real child process: it must stream
 * stdout line-by-line through the adapter's parser (emitting each batch), fold
 * stderr into the raw-log tail, bound that tail, honour a `buildCommand`
 * override + the adapter's env, and terminate correctly on clean exit, non-zero
 * exit, spawn failure, and the wall-clock cap. We spawn a real `node` (via
 * process.execPath, so PATH is irrelevant) as the fake agent — no child_process
 * mocking — so the readline/kill wiring is exercised for real.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import { runAgentProcess } from '../agent-process.js';
import type { NormalizedEvent, WorkerAgentAdapter } from '../../agents/types.js';

/** A minimal adapter whose parseLine maps each non-`#` line to an agent-message. */
function lineAdapter(parseLine?: WorkerAgentAdapter['parseLine']): WorkerAgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    credentialKeys: { anyOf: ['X'] },
    supportsResume: false,
    command: () => ({ argv: [process.execPath, '-e', 'process.exit(0)'], env: {} }),
    parseLine:
      parseLine ??
      ((line: string): NormalizedEvent[] =>
        line.startsWith('#') ? [] : [{ event_type: 'agent-message', payload: { text: line } }]),
    extractResult: () => null,
    captureSessionRef: () => null,
  };
}

/** Build argv that runs an inline node script as the agent. */
function nodeScript(src: string): { argv: string[]; env: Record<string, string> } {
  return { argv: [process.execPath, '-e', src], env: {} };
}

const BIG_CAP = 60; // seconds; the timer never fires for the fast scripts

describe('runAgentProcess stdout parsing + termination', () => {
  it('streams each stdout line through the adapter, emits per-batch, and returns the exit code', async () => {
    const onEvents = vi.fn();
    const adapter = lineAdapter();
    adapter.command = () =>
      nodeScript("process.stdout.write('alpha\\n# ignored\\nbeta\\n')");

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents,
    });

    expect(result.termination).toBe('exited');
    expect(result.exitCode).toBe(0);
    // The '# ignored' line is parsed to [] so it yields no event but is still logged.
    expect(result.events).toEqual([
      { event_type: 'agent-message', payload: { text: 'alpha' } },
      { event_type: 'agent-message', payload: { text: 'beta' } },
    ]);
    expect(onEvents).toHaveBeenCalledTimes(2);
    expect(onEvents).toHaveBeenNthCalledWith(1, [{ event_type: 'agent-message', payload: { text: 'alpha' } }]);
    expect(onEvents).toHaveBeenNthCalledWith(2, [{ event_type: 'agent-message', payload: { text: 'beta' } }]);
    expect(result.rawLogTail).toBe('alpha\n# ignored\nbeta\n');
  });

  it('reports a non-zero exit code with termination "exited" (the runner maps that to a failure)', async () => {
    const adapter = lineAdapter();
    adapter.command = () => nodeScript("process.stdout.write('did work\\n'); process.exit(7)");

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents: () => undefined,
    });

    expect(result).toMatchObject({ termination: 'exited', exitCode: 7 });
    expect(result.rawLogTail).toContain('did work');
  });

  it('captures stderr into the raw-log tail alongside stdout', async () => {
    const adapter = lineAdapter();
    adapter.command = () =>
      nodeScript("process.stderr.write('boom-on-stderr'); process.stdout.write('ok-on-stdout\\n')");

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents: () => undefined,
    });

    expect(result.termination).toBe('exited');
    expect(result.rawLogTail).toContain('boom-on-stderr');
    expect(result.rawLogTail).toContain('ok-on-stdout');
  });

  it('bounds the raw-log tail to maxRawLogChars, keeping the most recent output', async () => {
    const adapter = lineAdapter();
    // Five 11-char lines ('0123456789\n'); with a 10-char cap only the tail survives.
    adapter.command = () =>
      nodeScript("for (let i = 0; i < 5; i++) process.stdout.write('0123456789\\n')");

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10,
      onEvents: () => undefined,
    });

    const full = '0123456789\n'.repeat(5);
    expect(result.rawLogTail).toBe(full.slice(-10));
    expect(result.rawLogTail.length).toBe(10);
  });

  it('spawns the child in the workspace directory', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cwd-'));
    const adapter = lineAdapter();
    adapter.command = () => nodeScript('process.stdout.write(process.cwd() + "\\n")');

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace,
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents: () => undefined,
    });

    const reportedCwd = result.events[0]!.payload.text as string;
    expect(fss.realpathSync(reportedCwd)).toBe(fss.realpathSync(workspace));
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('merges the adapter-supplied env into the child process env', async () => {
    const adapter = lineAdapter();
    adapter.command = () => ({
      argv: [process.execPath, '-e', 'process.stdout.write((process.env.MARKER || "none") + "\\n")'],
      env: { MARKER: 'from-adapter' },
    });

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents: () => undefined,
    });

    expect(result.events).toEqual([{ event_type: 'agent-message', payload: { text: 'from-adapter' } }]);
  });

  it('uses the buildCommand override instead of adapter.command when provided', async () => {
    const adapter = lineAdapter();
    adapter.command = vi.fn(() => nodeScript("process.stdout.write('should-not-run\\n')"));

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents: () => undefined,
      buildCommand: (a) => {
        expect(a).toBe(adapter);
        return nodeScript("process.stdout.write('override-ran\\n')");
      },
    });

    expect(adapter.command).not.toHaveBeenCalled();
    expect(result.events).toEqual([{ event_type: 'agent-message', payload: { text: 'override-ran' } }]);
  });

  it('returns termination "error" with a null exit code when the binary cannot be spawned', async () => {
    const adapter = lineAdapter();
    adapter.command = () => ({ argv: ['definitely-not-a-real-binary-zzz-9182'], env: {} });

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: BIG_CAP,
      maxRawLogChars: 10_000,
      onEvents: () => undefined,
    });

    expect(result.termination).toBe('error');
    expect(result.exitCode).toBeNull();
    expect(result.rawLogTail).toContain('spawn error');
  });

  it('kills the child and returns termination "timeout" once the wall-clock cap fires', async () => {
    const onEvents = vi.fn();
    const adapter = lineAdapter();
    // Emit a line, then hang forever so only the cap can end the run.
    adapter.command = () =>
      nodeScript("process.stdout.write('started\\n'); setInterval(() => {}, 1000)");

    const result = await runAgentProcess({
      adapter,
      task: 't',
      workspace: os.tmpdir(),
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
      wallClockCapS: 1, // 1s real cap keeps the suite fast
      maxRawLogChars: 10_000,
      onEvents,
    });

    expect(result.termination).toBe('timeout');
    expect(result.exitCode).toBeNull();
    // Output produced before the kill is still captured.
    expect(result.rawLogTail).toContain('started');
    expect(onEvents).toHaveBeenCalledWith([{ event_type: 'agent-message', payload: { text: 'started' } }]);
  });
});
