/**
 * Multi-agent adapter contract. Every agent must: build a
 * one-shot command, build a resume command (if supportsResume), parse its
 * output into normalized events without throwing on unknown shapes, and
 * surface a session handle. Claude Code is live-validated; the others are
 * parser-tested against representative fixtures and flagged experimental.
 */

import { getAgentAdapter, listAgentAdapters } from '../registry.js';

describe('adapter registry', () => {
  it('registers claude-code (validated) plus codex, cursor, opencode (experimental)', () => {
    const ids = listAgentAdapters().map((a) => a.id).sort();
    expect(ids).toEqual(['claude-code', 'codex', 'cursor', 'opencode']);
    expect(getAgentAdapter('claude-code')?.experimental).toBeUndefined();
    for (const id of ['codex', 'cursor', 'opencode']) {
      expect(getAgentAdapter(id)?.experimental).toBe(true);
    }
  });

  it('every adapter declares credential keys, resume support, and a resume command when supported', () => {
    for (const a of listAgentAdapters()) {
      expect(a.credentialKeys.anyOf.length).toBeGreaterThan(0);
      expect(typeof a.supportsResume).toBe('boolean');
      if (a.supportsResume) expect(typeof a.resumeCommand).toBe('function');
    }
  });

  it('no adapter throws on malformed / unknown lines', () => {
    for (const a of listAgentAdapters()) {
      expect(a.parseLine('not json {')).toEqual([]);
      expect(a.parseLine('')).toEqual([]);
      expect(a.parseLine(JSON.stringify({ type: 'totally_unknown_future_event' }))).toEqual([]);
    }
  });
});

describe('claude-code resume', () => {
  const a = getAgentAdapter('claude-code')!;
  it('builds a --resume command carrying the session id', () => {
    expect(a.resumeCommand!('sess-123', 'do more', { workspace: '/w', wallClockCapS: 900 }).argv).toEqual([
      'claude', '-p', 'do more', '--resume', 'sess-123',
      '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    ]);
  });
  it('captures the session id from the system init event', () => {
    const events = a.parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-xyz', model: 'claude' }));
    expect(a.captureSessionRef(events)).toBe('sess-xyz');
  });
});

describe('codex adapter', () => {
  const a = getAgentAdapter('codex')!;
  it('builds exec + resume commands', () => {
    expect(a.command('t', { workspace: '/w', wallClockCapS: 900 }).argv).toEqual(['codex', 'exec', '--json', '--full-auto', 't']);
    expect(a.resumeCommand!('S1', 't2', { workspace: '/w', wallClockCapS: 900 }).argv).toEqual([
      'codex', 'exec', 'resume', 'S1', '--json', '--full-auto', 't2',
    ]);
  });
  it('captures a session/thread id and parses a message + command', () => {
    const init = a.parseLine(JSON.stringify({ type: 'session.created', session_id: 'cx-1' }));
    expect(a.captureSessionRef(init)).toBe('cx-1');
    expect(a.parseLine(JSON.stringify({ type: 'agent_message', text: 'working on it' }))).toContainEqual(
      { event_type: 'agent-message', payload: { text: 'working on it' } },
    );
    const cmd = a.parseLine(JSON.stringify({ type: 'command.exec', command: 'apply_patch foo.ts', path: 'foo.ts' }));
    expect(cmd.some((e) => e.event_type === 'tool-use')).toBe(true);
    expect(cmd.some((e) => e.event_type === 'file-change')).toBe(true);
  });
});

describe('cursor adapter', () => {
  const a = getAgentAdapter('cursor')!;
  it('builds -p + --resume commands and parses claude-shaped assistant blocks', () => {
    expect(a.command('t', { workspace: '/w', wallClockCapS: 900 }).argv).toEqual([
      'cursor-agent', '-p', 't', '--output-format', 'stream-json', '--force',
    ]);
    expect(a.resumeCommand!('chat-9', 't2', { workspace: '/w', wallClockCapS: 900 }).argv).toContain('--resume');
    const ev = a.parseLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    expect(ev).toContainEqual({ event_type: 'agent-message', payload: { text: 'hi' } });
    const init = a.parseLine(JSON.stringify({ type: 'system', chatId: 'chat-9' }));
    expect(a.captureSessionRef(init)).toBe('chat-9');
  });
});

describe('opencode adapter', () => {
  const a = getAgentAdapter('opencode')!;
  it('is OpenAI-keyed (upstream dropped Claude support) and builds run + resume commands', () => {
    expect(a.credentialKeys.anyOf).toEqual(['OPENAI_API_KEY', 'OPENCODE_API_KEY']);
    expect(a.command('t', { workspace: '/w', wallClockCapS: 900 }).argv).toEqual(['opencode', 'run', '--print-logs', 't']);
    expect(a.resumeCommand!('S', 't2', { workspace: '/w', wallClockCapS: 900 }).argv).toEqual([
      'opencode', 'run', '--session', 'S', '--print-logs', 't2',
    ]);
  });
  it('captures a session id and parses text', () => {
    const init = a.parseLine(JSON.stringify({ type: 'session.start', sessionID: 'oc-1' }));
    expect(a.captureSessionRef(init)).toBe('oc-1');
    expect(a.parseLine(JSON.stringify({ type: 'assistant', text: 'done' }))).toContainEqual(
      { event_type: 'agent-message', payload: { text: 'done' } },
    );
  });
});
