import { describe, expect, it } from 'vitest';
import { applySnapshotChanges, hasContextChanges } from './tree-diff';

const SKILL_PATH = '.outerlayer/skills/deploy/SKILL.md';
const COMMAND_PATH = '.outerlayer/commands/ship.md';

describe('applySnapshotChanges', () => {
  it('adds a new path on added', () => {
    const next = applySnapshotChanges([SKILL_PATH], [{ path: COMMAND_PATH, status: 'added' }]);
    expect(next).toEqual([SKILL_PATH, COMMAND_PATH]);
  });

  it('is a no-op on modified — the path was already present and stays present', () => {
    const otherPath = '.outerlayer/skills/other/SKILL.md';
    const next = applySnapshotChanges([SKILL_PATH, otherPath], [{ path: SKILL_PATH, status: 'modified' }]);
    expect(next).toEqual([SKILL_PATH, otherPath]);
  });

  it('removes a path on removed', () => {
    const next = applySnapshotChanges([SKILL_PATH, COMMAND_PATH], [{ path: COMMAND_PATH, status: 'removed' }]);
    expect(next).toEqual([SKILL_PATH]);
  });

  it('treats a rename as delete-of-previousPath plus add-of-path', () => {
    const renamed = '.outerlayer/skills/release/SKILL.md';
    const next = applySnapshotChanges(
      [SKILL_PATH],
      [{ path: renamed, status: 'renamed', previousPath: SKILL_PATH }],
    );
    expect(next).toEqual([renamed]);
  });

  it('throws when a renamed change is missing previousPath', () => {
    expect(() =>
      applySnapshotChanges([SKILL_PATH], [{ path: '.outerlayer/skills/release/SKILL.md', status: 'renamed' }]),
    ).toThrow(/missing previousPath/);
  });

  it('is idempotent: applying the same add twice yields one path, not a duplicate', () => {
    const once = applySnapshotChanges([], [{ path: COMMAND_PATH, status: 'added' }]);
    const twice = applySnapshotChanges(once, [{ path: COMMAND_PATH, status: 'added' }]);
    expect(twice).toEqual([COMMAND_PATH]);
  });

  it('normalizes backslash separators consistently between parent paths and change paths', () => {
    const next = applySnapshotChanges(
      ['apps\\api\\.outerlayer\\AGENTS.md'],
      [{ path: 'apps/api/.outerlayer/AGENTS.md', status: 'removed' }],
    );
    expect(next).toEqual([]);
  });

  it('does not classify — a removed-then-readded asset path stays in the list even though it would classify as excluded', () => {
    // No incremental classification: applySnapshotChanges is a pure path-list transform.
    // The caller re-runs classifyTree on the result to get excludedCounts/issues.
    const next = applySnapshotChanges([], [{ path: '.outerlayer/skills/deploy/assets/logo.png', status: 'added' }]);
    expect(next).toEqual(['.outerlayer/skills/deploy/assets/logo.png']);
  });
});

describe('hasContextChanges', () => {
  it('is false when every change touches only non-context files', () => {
    expect(
      hasContextChanges([
        { path: 'src/index.ts', status: 'modified' },
        { path: 'README.md', status: 'modified' },
      ]),
    ).toBe(false);
  });

  it('is true when at least one change touches a path inside .outerlayer/', () => {
    expect(
      hasContextChanges([
        { path: 'src/index.ts', status: 'modified' },
        { path: COMMAND_PATH, status: 'added' },
      ]),
    ).toBe(true);
  });

  it('is true for a rename whose previousPath is context-relevant even if path is not (defensive check both sides)', () => {
    expect(
      hasContextChanges([{ path: 'scratch.txt', status: 'renamed', previousPath: '.outerlayer/notes.md' }]),
    ).toBe(true);
  });

  it('is true for a root AGENTS.md change even though it is outside any .outerlayer/ dir', () => {
    expect(hasContextChanges([{ path: 'AGENTS.md', status: 'modified' }])).toBe(true);
  });
});
