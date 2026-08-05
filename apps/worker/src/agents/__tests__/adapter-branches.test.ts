/**
 * Branch coverage for the JSONL agent adapters + their shared helpers: the
 * parser paths the happy-path fixtures in claude-code.test.ts / multi-agent.test.ts
 * don't reach — file-edit detection, flat-text fallbacks, terminal-result cost
 * extraction, error flagging, and the "no session ref" return. Every adapter's
 * contract is "unknown/malformed lines never throw"; these pin the shapes it
 * DOES act on.
 */

import { claudeCodeAdapter } from '../claude-code.js';
import { codexAdapter } from '../codex.js';
import { cursorAdapter } from '../cursor.js';
import { opencodeAdapter } from '../opencode.js';
import { agentMessage, looksLikeFileEdit, parseJsonLine, pickString, toolUse } from '../generic-jsonl.js';

describe('generic-jsonl helpers', () => {
  it('parseJsonLine returns the object for JSON objects/arrays and null for everything else', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('  {"b":2}  ')).toEqual({ b: 2 });
    expect(parseJsonLine('[1,2]')).toEqual([1, 2]);
    expect(parseJsonLine('')).toBeNull();
    expect(parseJsonLine('plain text')).toBeNull();
    expect(parseJsonLine('42')).toBeNull(); // does not start with { or [
    expect(parseJsonLine('{ not valid json')).toBeNull(); // JSON.parse throws -> caught
    expect(parseJsonLine('null')).toBeNull();
  });

  it('pickString finds a shallow key, then falls back to a one-level-deep nested key', () => {
    expect(pickString({ name: 'top' }, ['name'])).toBe('top');
    expect(pickString({ meta: { session_id: 'deep' } }, ['session_id'])).toBe('deep');
    // Shallow wins over nested when both present.
    expect(pickString({ id: 'shallow', meta: { id: 'nested' } }, ['id'])).toBe('shallow');
    expect(pickString({ n: 5, obj: { other: 'x' } }, ['missing'])).toBeUndefined();
  });

  it('looksLikeFileEdit matches known edit verbs case-insensitively and rejects others', () => {
    expect(looksLikeFileEdit('Write')).toBe(true);
    expect(looksLikeFileEdit('apply_patch')).toBe(true);
    expect(looksLikeFileEdit('str_replace_editor')).toBe(true);
    expect(looksLikeFileEdit('Bash')).toBe(false);
    expect(looksLikeFileEdit('read_file')).toBe(false);
  });

  it('agentMessage and toolUse build the normalized event shapes', () => {
    expect(agentMessage('hello')).toEqual({ event_type: 'agent-message', payload: { text: 'hello' } });
    expect(toolUse('Bash', 'ls -la')).toEqual({ event_type: 'tool-use', payload: { tool: 'Bash', summary: 'ls -la' } });
  });
});

describe('cursorAdapter branch coverage', () => {
  it('emits a file-change alongside tool-use for a file-editing tool block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts', description: 'edit a' } }] },
    });
    expect(cursorAdapter.parseLine(line)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'Edit', summary: 'edit a' } },
      { event_type: 'file-change', payload: { path: 'src/a.ts', tool: 'Edit' } },
    ]);
  });

  it('falls back to flat assistant text when message.content is not an array', () => {
    const line = JSON.stringify({ type: 'assistant', text: 'flat reply' });
    expect(cursorAdapter.parseLine(line)).toEqual([{ event_type: 'agent-message', payload: { text: 'flat reply' } }]);
  });

  it('maps a result line to a result event carrying cost + error flag, and extractResult reads them', () => {
    const events = cursorAdapter.parseLine(
      JSON.stringify({ type: 'result', result: 'finished', is_error: true, total_cost_usd: 0.5 }),
    );
    expect(events).toEqual([
      { event_type: 'result', payload: { result: 'finished', is_error: true, cost_usd: 0.5 } },
    ]);
    expect(cursorAdapter.extractResult(events)).toEqual({ costUsd: 0.5, isError: true });
  });

  it('captureSessionRef returns null when no agent-launched status was seen', () => {
    const events = cursorAdapter.parseLine(JSON.stringify({ type: 'assistant', text: 'hi' }));
    expect(cursorAdapter.captureSessionRef(events)).toBeNull();
  });
});

describe('opencodeAdapter branch coverage', () => {
  it('emits tool-use + file-change for a file-editing tool line', () => {
    const line = JSON.stringify({ type: 'tool.execute', tool: 'write_file', path: 'out.txt', input: 'data' });
    expect(opencodeAdapter.parseLine(line)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'write_file', summary: 'data' } },
      { event_type: 'file-change', payload: { path: 'out.txt', tool: 'write_file' } },
    ]);
  });

  it('emits tool-use WITHOUT file-change for a non-editing tool', () => {
    const line = JSON.stringify({ type: 'tool.execute', tool: 'bash', command: 'ls' });
    expect(opencodeAdapter.parseLine(line)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'bash', summary: 'ls' } },
    ]);
  });

  it('flags an error result via the top-level error field', () => {
    const events = opencodeAdapter.parseLine(JSON.stringify({ type: 'result', error: 'exploded' }));
    expect(events).toEqual([{ event_type: 'result', payload: { result: '', is_error: true } }]);
    expect(opencodeAdapter.extractResult(events)).toEqual({ isError: true });
  });

  it('captureSessionRef returns null with no session status', () => {
    expect(opencodeAdapter.captureSessionRef(opencodeAdapter.parseLine(JSON.stringify({ type: 'assistant', text: 'x' })))).toBeNull();
  });
});

describe('codexAdapter branch coverage', () => {
  it('extracts cost_usd from a turn.completed usage block', () => {
    const events = codexAdapter.parseLine(
      JSON.stringify({ type: 'turn.completed', usage: { cost_usd: 0.12 }, text: 'ok' }),
    );
    expect(events).toEqual([{ event_type: 'result', payload: { result: 'ok', is_error: false, cost_usd: 0.12 } }]);
    expect(codexAdapter.extractResult(events)).toEqual({ costUsd: 0.12, isError: false });
  });

  it('reads cost from the alternate `info` block and flags status:error results', () => {
    const events = codexAdapter.parseLine(
      JSON.stringify({ type: 'task_complete', info: { cost_usd: 0.3 }, status: 'error' }),
    );
    expect(events).toEqual([{ event_type: 'result', payload: { result: '', is_error: true, cost_usd: 0.3 } }]);
  });

  it('captureSessionRef reads a thread_id from a status event and returns null otherwise', () => {
    const init = codexAdapter.parseLine(JSON.stringify({ type: 'thread.started', thread_id: 'th-9' }));
    expect(codexAdapter.captureSessionRef(init)).toBe('th-9');
    expect(codexAdapter.captureSessionRef(codexAdapter.parseLine(JSON.stringify({ type: 'agent_message', text: 'hi' })))).toBeNull();
  });
});

describe('claudeCodeAdapter branch coverage', () => {
  it('summarizes a Bash tool by its command when no description is given', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });
    expect(claudeCodeAdapter.parseLine(line)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'Bash', summary: 'npm test' } },
    ]);
  });

  it('summarizes a read tool by "<name> <path>" and does NOT emit a file-change for it', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'src/x.ts' } }] },
    });
    expect(claudeCodeAdapter.parseLine(line)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'Read', summary: 'Read src/x.ts' } },
    ]);
  });

  it('emits a file-change from notebook_path for a NotebookEdit tool', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: 'analysis.ipynb' } }] },
    });
    expect(claudeCodeAdapter.parseLine(line)).toEqual([
      { event_type: 'tool-use', payload: { tool: 'NotebookEdit', summary: 'NotebookEdit' } },
      { event_type: 'file-change', payload: { path: 'analysis.ipynb', tool: 'NotebookEdit' } },
    ]);
  });

  it('captureSessionRef returns null when only non-status events are present', () => {
    const events = claudeCodeAdapter.parseLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    );
    expect(claudeCodeAdapter.captureSessionRef(events)).toBeNull();
  });
});
