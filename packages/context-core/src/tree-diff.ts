/**
 * Clone-then-patch tree-diff primitive for incremental sync.
 * Operates on plain path lists only, per the binding "no incremental
 * classification" principle: shadowing and skill grouping need the global
 * view, so callers always re-run `classifyTree` on the full resulting path
 * list rather than patching classified entries directly. Renames are
 * delete-of-old + add-of-new (git history carries the rename story; the
 * mirror doesn't need to).
 */
import { normalizePath } from '@outerlayer/context-format';

export type ChangeStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface TreeChange {
  path: string;
  status: ChangeStatus;
  /** Present when status is `renamed`: the path this entry used to live at. */
  previousPath?: string;
}

const OUTERLAYER_DIR = '.outerlayer';

/**
 * Cheap structural check — no classification — for the "advance head only"
 * fast path. Deliberately coarse: a false positive (a path that later
 * classifies as ignored, e.g. a file literally named `.outerlayer`) just
 * costs an unnecessary-but-safe full resync; a false negative would silently
 * drop a real context change, which is the direction that must never happen.
 */
function isPotentiallyContextPath(rawPath: string): boolean {
  const path = normalizePath(rawPath);
  if (path === '') return false;
  const segs = path.split('/');
  if (segs.includes(OUTERLAYER_DIR)) return true;
  const base = segs[segs.length - 1];
  return base === 'AGENTS.md' || base === 'CLAUDE.md';
}

/** True when at least one change touches a context-relevant path. */
export function hasContextChanges(changes: TreeChange[]): boolean {
  return changes.some(
    (change) =>
      isPotentiallyContextPath(change.path) ||
      (change.previousPath !== undefined && isPotentiallyContextPath(change.previousPath)),
  );
}

/** Applies a change list to a parent snapshot's path list, producing the next snapshot's path list. */
export function applySnapshotChanges(parentPaths: string[], changes: TreeChange[]): string[] {
  const paths = new Set(parentPaths.map(normalizePath));

  for (const change of changes) {
    const path = normalizePath(change.path);
    switch (change.status) {
      case 'added':
      case 'modified':
        paths.add(path);
        break;
      case 'removed':
        paths.delete(path);
        break;
      case 'renamed':
        if (change.previousPath === undefined) {
          throw new Error(`tree-diff: "renamed" change for "${change.path}" is missing previousPath`);
        }
        paths.delete(normalizePath(change.previousPath));
        paths.add(path);
        break;
      default:
        throw new Error(`tree-diff: unknown change status "${String(change.status)}"`);
    }
  }

  return [...paths];
}
