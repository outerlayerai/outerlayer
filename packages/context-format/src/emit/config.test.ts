import { describe, expect, it } from 'vitest';
import { parseOuterlayerConfig } from './config';

describe('parseOuterlayerConfig — .outerlayer/config.json', () => {
  it('accepts a valid multi-target config', () => {
    const result = parseOuterlayerConfig(JSON.stringify({ targets: ['claude-code', 'cursor', 'codex'] }));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual({ targets: ['claude-code', 'cursor', 'codex'] });
  });

  it('rejects an empty targets array with no_targets, listing the valid ids', () => {
    const result = parseOuterlayerConfig(JSON.stringify({ targets: [] }));

    expect(result.ok).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.errors).toEqual([
      {
        path: 'targets',
        code: 'no_targets',
        message: '"targets" must be a non-empty array of target ids; valid ids: claude-code, cursor, codex, copilot, factory',
      },
    ]);
  });

  it('rejects a missing targets field with no_targets', () => {
    const result = parseOuterlayerConfig(JSON.stringify({}));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'targets',
        code: 'no_targets',
        message: '"targets" must be a non-empty array of target ids; valid ids: claude-code, cursor, codex, copilot, factory',
      },
    ]);
  });

  it('rejects an unknown target id, positionally, without dropping valid siblings from the error list', () => {
    const result = parseOuterlayerConfig(JSON.stringify({ targets: ['claude-code', 'jetbrains-ai', 'cursor'] }));

    expect(result.ok).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.errors).toEqual([
      {
        path: 'targets[1]',
        code: 'unknown_target',
        message: 'unknown target id "jetbrains-ai"; valid ids: claude-code, cursor, codex, copilot, factory',
      },
    ]);
  });

  it('rejects malformed JSON without throwing', () => {
    const result = parseOuterlayerConfig('{ targets: [');

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: '(root)', code: 'invalid_json', message: expect.any(String) },
    ]);
  });

  it('rejects a non-object JSON value', () => {
    const result = parseOuterlayerConfig(JSON.stringify(['claude-code']));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: '(root)', code: 'invalid_type', message: 'config.json must be a JSON object' },
    ]);
  });
});
