import { describe, expect, it } from 'vitest';
import { basename, dirname, isAncestorScope, joinPath, normalizePath } from './path-utils';

describe('normalizePath', () => {
  it('converts backslash separators to forward slashes', () => {
    expect(normalizePath('apps\\api\\.outerlayer\\AGENTS.md')).toBe('apps/api/.outerlayer/AGENTS.md');
  });

  it('strips a leading ./ segment and collapses redundant separators', () => {
    expect(normalizePath('./apps//api/./AGENTS.md')).toBe('apps/api/AGENTS.md');
  });

  it('leaves an already-normalized path unchanged', () => {
    expect(normalizePath('apps/api/AGENTS.md')).toBe('apps/api/AGENTS.md');
  });
});

describe('joinPath / dirname / basename', () => {
  it('joins and normalizes parts', () => {
    expect(joinPath('apps', 'api', '.outerlayer', 'AGENTS.md')).toBe('apps/api/.outerlayer/AGENTS.md');
  });

  it('computes dirname and basename for a nested path', () => {
    expect(dirname('apps/api/.outerlayer/AGENTS.md')).toBe('apps/api/.outerlayer');
    expect(basename('apps/api/.outerlayer/AGENTS.md')).toBe('AGENTS.md');
  });

  it('computes dirname as empty string for a root-level path', () => {
    expect(dirname('AGENTS.md')).toBe('');
    expect(basename('AGENTS.md')).toBe('AGENTS.md');
  });
});

describe('isAncestorScope', () => {
  it('treats root ("") as an ancestor of everything', () => {
    expect(isAncestorScope('', 'apps/api')).toBe(true);
    expect(isAncestorScope('', '')).toBe(true);
  });

  it('treats a scope as its own ancestor', () => {
    expect(isAncestorScope('apps/api', 'apps/api')).toBe(true);
  });

  it('is true for a genuine nested descendant', () => {
    expect(isAncestorScope('apps', 'apps/api/workers')).toBe(true);
  });

  it('is false for unrelated sibling scopes', () => {
    expect(isAncestorScope('apps/api', 'apps/web')).toBe(false);
  });

  it('is false when a scope name is merely a string prefix, not a path ancestor', () => {
    // 'apps/api' must not be treated as an ancestor of 'apps/api-gateway'.
    expect(isAncestorScope('apps/api', 'apps/api-gateway')).toBe(false);
  });
});
