/**
 * Small helpers shared across per-target builders. Kept here rather than in
 * `classify.ts` — the scope guard forbids incidental changes to that module
 * beyond the `config` kind addition, and these operate on raw asset paths
 * that `classifyTree` deliberately never classifies.
 */
import type { ClassifiedEntry, FieldIssue } from '../kinds';
import { normalizePath } from '../path-utils';

const OUTERLAYER_DIR = '.outerlayer';

/** Looks up an entry's source content, recording a warning (never throwing) if the caller omitted it. */
export function contentForEntry(
  contents: ReadonlyMap<string, string>,
  entry: ClassifiedEntry,
  warnings: FieldIssue[],
): string | undefined {
  const content = contents.get(entry.path);
  if (content === undefined) {
    warnings.push({ path: entry.path, code: 'missing_content', message: `no source content provided for "${entry.path}"` });
    return undefined;
  }
  return content;
}

/**
 * For a `skill-reference` entry, the path portion after its `references/`
 * segment — e.g. `.outerlayer/skills/onboarding/references/sub/setup.md` →
 * `sub/setup.md`. Mirrors `classify.ts`'s own `skills/<name>/references/**`
 * segment logic without importing it (that logic is internal, not exported).
 */
export function skillReferenceRelPath(entry: ClassifiedEntry): string {
  const segs = normalizePath(entry.path).split('/');
  const idx = segs.indexOf(OUTERLAYER_DIR);
  // rel = ['skills', <name>, 'references', ...rest]
  const rel = segs.slice(idx + 1);
  return rel.slice(3).join('/');
}

/**
 * For a `command` entry, the path portion after its `commands/` segment —
 * e.g. `.outerlayer/commands/deploy/ship.md` → `deploy/ship.md`, and a flat
 * `.outerlayer/commands/ship.md` → `ship.md`. Preserves the namespace subpath
 * so a nested command survives into each target's commands dir (Claude Code
 * reads it as `/ns:name`). Never flattened to the basename: two same-named
 * commands in different namespaces would collide on the same output file.
 */
export function commandRelPath(entry: ClassifiedEntry): string {
  const segs = normalizePath(entry.path).split('/');
  const rel = segs.slice(segs.indexOf(OUTERLAYER_DIR) + 1);
  // rel = ['commands', ...ns, '<name>.md']
  return rel.slice(1).join('/');
}

export interface SkillAssetPath {
  scopePath: string;
  skillName: string;
  /** Path relative to the skill's own directory, e.g. `scripts/run.sh`. */
  relPath: string;
}

/**
 * Parses one of `EmitInput.assetPaths` (excluded skill assets/scripts)
 * into its scope, skill name, and skill-relative path, so a target builder
 * can place the `EmitCopy` destination alongside that skill's emitted files.
 */
export function parseSkillAssetPath(rawPath: string): SkillAssetPath | null {
  const path = normalizePath(rawPath);
  const segs = path.split('/');
  const idx = segs.indexOf(OUTERLAYER_DIR);
  if (idx === -1) return null;
  const scopePath = segs.slice(0, idx).join('/');
  const rel = segs.slice(idx + 1);
  if (rel.length < 3 || rel[0] !== 'skills') return null;
  const skillName = rel[1]!;
  const relPath = rel.slice(2).join('/');
  if (relPath.length === 0) return null;
  return { scopePath, skillName, relPath };
}
