/**
 * Claude Code stream-json parsing. Fixtures are real lines captured from
 * `claude -p ... --output-format stream-json --verbose` (see the session
 * probe) — the parser must map them onto normalized events and tolerate the
 * shapes it doesn't care about.
 */

import { claudeCodeAdapter } from '../claude-code.js';

const SYSTEM_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'claude-fable-5',
  cwd: '/tmp/x',
});
const ASSISTANT_TEXT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: "I'll append that line to README.md." }] },
});
const ASSISTANT_BASH = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi >> README.md', description: 'Append line to README.md' } },
    ],
  },
});
const ASSISTANT_WRITE = JSON.stringify({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/version.ts', content: 'export const v = 1;' } }],
  },
});
const ASSISTANT_THINKING = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'thinking', thinking: 'secret reasoning', signature: 'abc' }] },
});
const TOOL_RESULT = JSON.stringify({
  type: 'user',
  message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: '(no output)' }] },
});
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  total_cost_usd: 0.2725,
  num_turns: 2,
  duration_ms: 9794,
});

describe('claudeCodeAdapter.command', () => {
  it('builds a headless stream-json invocation with bypassed permissions', () => {
    const { argv } = claudeCodeAdapter.command('implement X', { workspace: '/w', wallClockCapS: 1800 });
    expect(argv).toEqual([
      'claude',
      '-p',
      'implement X',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('adds --model before the base flags when a model is given, and omits it otherwise', () => {
    const withModel = claudeCodeAdapter.command('implement X', {
      workspace: '/w',
      wallClockCapS: 1800,
      model: 'sonnet',
    }).argv;
    expect(withModel).toEqual([
      'claude', '-p', 'implement X', '--model', 'sonnet',
      '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    ]);
    // No model → no --model token at all (falls back to the CLI default).
    expect(claudeCodeAdapter.command('x', { workspace: '/w', wallClockCapS: 1800 }).argv).not.toContain('--model');
  });

  it('passes --model through on a resume turn', () => {
    const argv = claudeCodeAdapter.resumeCommand!('sess-1', 'continue', {
      workspace: '/w',
      wallClockCapS: 1800,
      model: 'haiku',
    }).argv;
    expect(argv.slice(0, 6)).toEqual(['claude', '-p', 'continue', '--resume', 'sess-1', '--model']);
    expect(argv[6]).toBe('haiku');
  });

  it('marks the process sandboxed so bypassPermissions is allowed under root', () => {
    // The runner is root inside a Fly microVM; without IS_SANDBOX the CLI exits
    // 1 ("cannot be used with root/sudo privileges").
    expect(claudeCodeAdapter.command('implement X', { workspace: '/w', wallClockCapS: 1800 }).env).toEqual({
      IS_SANDBOX: '1',
    });
    expect(
      claudeCodeAdapter.resumeCommand!('sess-1', 'continue', { workspace: '/w', wallClockCapS: 1800 }).env,
    ).toEqual({ IS_SANDBOX: '1' });
  });

  it('declares the BYOK credential keys — API key only, never a subscription token', () => {
    expect(claudeCodeAdapter.credentialKeys.anyOf).toEqual(['ANTHROPIC_API_KEY']);
  });
});

describe('claudeCodeAdapter.parseLine', () => {
  it('maps a system/init line to an agent-launched status carrying model + session', () => {
    expect(claudeCodeAdapter.parseLine(SYSTEM_INIT)).toEqual([
      { event_type: 'status', payload: { phase: 'agent-launched', model: 'claude-fable-5', session_id: 'sess-1' } },
    ]);
  });

  it('maps assistant text to an agent-message', () => {
    expect(claudeCodeAdapter.parseLine(ASSISTANT_TEXT)).toEqual([
      { event_type: 'agent-message', payload: { text: "I'll append that line to README.md." } },
    ]);
  });

  it('maps a Bash tool_use to a single tool-use event using the description as summary', () => {
    expect(claudeCodeAdapter.parseLine(ASSISTANT_BASH)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'Bash', summary: 'Append line to README.md' } },
    ]);
  });

  it('emits BOTH tool-use and file-change for a file-editing tool', () => {
    expect(claudeCodeAdapter.parseLine(ASSISTANT_WRITE)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'Write', summary: 'Write src/version.ts' } },
      { event_type: 'file-change', payload: { path: 'src/version.ts', tool: 'Write' } },
    ]);
  });

  it('drops thinking blocks entirely (never leaks reasoning into the transcript)', () => {
    expect(claudeCodeAdapter.parseLine(ASSISTANT_THINKING)).toEqual([]);
    expect(claudeCodeAdapter.parseLine(ASSISTANT_THINKING)).not.toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ text: 'secret reasoning' }) }),
    );
  });

  it('drops user tool_result echoes', () => {
    expect(claudeCodeAdapter.parseLine(TOOL_RESULT)).toEqual([]);
  });

  it('maps the terminal result line to a result event with cost/turns/duration', () => {
    expect(claudeCodeAdapter.parseLine(RESULT)).toEqual([
      {
        event_type: 'result',
        payload: { result: 'Done.', is_error: false, cost_usd: 0.2725, num_turns: 2, duration_ms: 9794 },
      },
    ]);
  });

  it('tolerates malformed JSON, blank lines, and unknown event types without throwing', () => {
    expect(claudeCodeAdapter.parseLine('not json {')).toEqual([]);
    expect(claudeCodeAdapter.parseLine('   ')).toEqual([]);
    expect(claudeCodeAdapter.parseLine(JSON.stringify({ type: 'future_event_kind', foo: 1 }))).toEqual([]);
  });
});

describe('claudeCodeAdapter.extractResult', () => {
  it('pulls metrics from the last result event', () => {
    const events = [
      ...claudeCodeAdapter.parseLine(ASSISTANT_TEXT),
      ...claudeCodeAdapter.parseLine(RESULT),
    ];
    expect(claudeCodeAdapter.extractResult(events)).toEqual({ costUsd: 0.2725, numTurns: 2, isError: false });
  });

  it('flags an errored result', () => {
    const events = claudeCodeAdapter.parseLine(
      JSON.stringify({ type: 'result', is_error: true, result: 'boom', num_turns: 1 }),
    );
    expect(claudeCodeAdapter.extractResult(events)?.isError).toBe(true);
  });

  it('returns null when no result event is present', () => {
    expect(claudeCodeAdapter.extractResult(claudeCodeAdapter.parseLine(ASSISTANT_TEXT))).toBeNull();
  });
});
