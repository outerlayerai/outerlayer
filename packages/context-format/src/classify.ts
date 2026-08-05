/**
 * Path-based classifier for `.outerlayer/` trees. Classification
 * is location-based, never content-sniffing. By design, no
 * incremental single-path classification is exported — `classifyTree` always
 * runs over the full path list because shadowing and skill grouping need the
 * global view. The single-path primitive below is an internal implementation
 * detail, not part of the public API.
 */
import { isAncestorScope, normalizePath } from './path-utils';
import type { ClassifiedEntry, ClassifyIssue, ClassifyResult } from './kinds';

const OUTERLAYER_DIR = '.outerlayer';

/** Lowercase alphanumeric, single hyphens — the same slug shape a skill name uses; applied per namespace segment. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type InternalClassification =
  | { type: 'entry'; entry: ClassifiedEntry; issue?: ClassifyIssue }
  | { type: 'excluded'; scopePath: string; skillName?: string }
  | { type: 'ignored' };

function scopeDirFor(scopePath: string): string {
  return scopePath === '' ? OUTERLAYER_DIR : `${scopePath}/${OUTERLAYER_DIR}`;
}

function classifyOnePath(rawPath: string): InternalClassification {
  const path = normalizePath(rawPath);
  if (path === '') return { type: 'ignored' };
  const segs = path.split('/');

  const outerlayerIndex = segs.indexOf(OUTERLAYER_DIR);

  if (outerlayerIndex === -1) {
    const base = segs[segs.length - 1];
    if (base === 'AGENTS.md' || base === 'CLAUDE.md') {
      const scopePath = segs.slice(0, -1).join('/');
      return { type: 'entry', entry: { path, kind: 'external-instructions', scopePath } };
    }
    return { type: 'ignored' };
  }

  const scopePath = segs.slice(0, outerlayerIndex).join('/');
  const relSegs = segs.slice(outerlayerIndex + 1);

  // `.outerlayer` is a FILE at this path, not a directory — nothing to classify.
  if (relSegs.length === 0) return { type: 'ignored' };

  // A `.gitkeep` anywhere under `.outerlayer` is a folder-keeper: it exists so
  // an otherwise-empty UI-created directory survives in the mirror. Its content
  // is never read — the `folder` entry only anchors the directory in the tree.
  // Matched before the skills/commands rules so a keeper inside those dirs is a
  // folder, not an excluded skill asset.
  if (relSegs[relSegs.length - 1] === '.gitkeep') {
    return { type: 'entry', entry: { path, kind: 'folder', scopePath } };
  }

  if (relSegs.length === 1 && relSegs[0] === 'AGENTS.md') {
    return { type: 'entry', entry: { path, kind: 'instructions', scopePath } };
  }
  if (relSegs.length === 1 && relSegs[0] === 'mcp.json') {
    return { type: 'entry', entry: { path, kind: 'mcp', scopePath } };
  }

  if (relSegs[0] === 'skills' && relSegs.length >= 2) {
    const skillName = relSegs[1]!;
    if (relSegs.length === 3 && relSegs[2] === 'SKILL.md') {
      return { type: 'entry', entry: { path, kind: 'skill', scopePath, skillName } };
    }
    const last = relSegs[relSegs.length - 1]!;
    if (relSegs.length >= 4 && relSegs[2] === 'references' && last.endsWith('.md')) {
      return { type: 'entry', entry: { path, kind: 'skill-reference', scopePath, skillName } };
    }
    // Assets/scripts/misplaced files anywhere else under skills/<name>/**.
    return { type: 'excluded', scopePath, skillName };
  }

  if (relSegs[0] === 'commands' && relSegs.length >= 2 && relSegs[relSegs.length - 1]!.endsWith('.md')) {
    const namespace = relSegs.slice(1, -1);
    const invalidSegment = namespace.find((seg) => !SLUG_PATTERN.test(seg));
    if (invalidSegment !== undefined) {
      // An unnameable namespace segment can't map to a real command path — keep
      // the file browsable as reference, but flag WHY it isn't a command.
      return {
        type: 'entry',
        entry: { path, kind: 'reference', scopePath },
        issue: {
          type: 'misplaced',
          path,
          scopePath,
          detail: `command namespace segment "${invalidSegment}" is not a valid name (lowercase alphanumeric with single hyphens)`,
        },
      };
    }
    return {
      type: 'entry',
      entry:
        namespace.length > 0
          ? { path, kind: 'command', scopePath, namespace }
          : { path, kind: 'command', scopePath },
    };
  }

  if (relSegs[0] === 'agents' && relSegs.length >= 2 && relSegs[relSegs.length - 1]!.endsWith('.md')) {
    if (relSegs.length === 2) {
      return { type: 'entry', entry: { path, kind: 'subagent', scopePath } };
    }
    // Subagents are flat: identity is the frontmatter `name`, so a folder adds
    // nothing. Keep the file as reference, but flag the misplacement.
    return {
      type: 'entry',
      entry: { path, kind: 'reference', scopePath },
      issue: {
        type: 'misplaced',
        path,
        scopePath,
        detail: 'subagents live directly in agents/; the frontmatter "name" is the identity, so folders add nothing',
      },
    };
  }

  const last = relSegs[relSegs.length - 1]!;
  if (last.endsWith('.md')) {
    return { type: 'entry', entry: { path, kind: 'reference', scopePath } };
  }

  return { type: 'excluded', scopePath };
}

/** Classifies every path in a tree listing, then layers cross-entry derived analysis on top. */
export function classifyTree(paths: string[]): ClassifyResult {
  const entries: ClassifiedEntry[] = [];
  const excluded: Array<{ scopePath: string; skillName?: string }> = [];
  const misplacedIssues: ClassifyIssue[] = [];

  for (const rawPath of paths) {
    const result = classifyOnePath(rawPath);
    if (result.type === 'entry') {
      entries.push(result.entry);
      if (result.issue) misplacedIssues.push(result.issue);
    } else if (result.type === 'excluded') {
      excluded.push({ scopePath: result.scopePath, skillName: result.skillName });
    }
  }

  const excludedCounts = computeExcludedCounts(excluded);
  const { issues: invalidSkillIssues, patchedEntries } = detectInvalidSkills(entries, excluded);
  const shadowIssues = [
    ...computeShadowIssues(patchedEntries, 'skill'),
    ...computeShadowIssues(patchedEntries, 'command'),
  ];

  return {
    entries: patchedEntries,
    excludedCounts,
    issues: [...invalidSkillIssues, ...misplacedIssues, ...shadowIssues],
  };
}

function skillKey(scopePath: string, skillName: string): string {
  return `${scopePath}::${skillName}`;
}

function splitSkillKey(key: string): [scopePath: string, skillName: string] {
  const idx = key.indexOf('::');
  return [key.slice(0, idx), key.slice(idx + 2)];
}

function computeExcludedCounts(
  excluded: Array<{ scopePath: string; skillName?: string }>,
): Array<{ scopePath: string; skillName: string; count: number }> {
  const map = new Map<string, { scopePath: string; skillName: string; count: number }>();
  for (const file of excluded) {
    if (!file.skillName) continue;
    const key = skillKey(file.scopePath, file.skillName);
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { scopePath: file.scopePath, skillName: file.skillName, count: 1 });
  }
  return [...map.values()];
}

/**
 * Missing-SKILL.md detection: demotes orphaned `skill-reference` entries to
 * plain `reference` — its markdown files remain browsable as
 * reference. Also catches assets-only orphan skill dirs (excluded files
 * with a skillName but no SKILL.md and no references at all).
 */
function detectInvalidSkills(
  entries: ClassifiedEntry[],
  excluded: Array<{ scopePath: string; skillName?: string }>,
): { issues: ClassifyIssue[]; patchedEntries: ClassifiedEntry[] } {
  const validSkillKeys = new Set(
    entries.filter((e) => e.kind === 'skill').map((e) => skillKey(e.scopePath, e.skillName!)),
  );

  const candidateKeys = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'skill-reference') candidateKeys.add(skillKey(e.scopePath, e.skillName!));
  }
  for (const f of excluded) {
    if (f.skillName) candidateKeys.add(skillKey(f.scopePath, f.skillName));
  }

  const invalidKeys = [...candidateKeys].filter((key) => !validSkillKeys.has(key)).sort();
  const invalidKeySet = new Set(invalidKeys);

  const issues: ClassifyIssue[] = invalidKeys.map((key) => {
    const [scopePath, skillName] = splitSkillKey(key);
    return {
      type: 'missing-skill-md' as const,
      path: `${scopeDirFor(scopePath)}/skills/${skillName}/SKILL.md`,
      scopePath,
      detail: `skill "${skillName}" has no SKILL.md`,
    };
  });

  const patchedEntries = entries.map((e) => {
    if (e.kind !== 'skill-reference') return e;
    if (!invalidKeySet.has(skillKey(e.scopePath, e.skillName!))) return e;
    const { skillName: _drop, ...rest } = e;
    return { ...rest, kind: 'reference' as const };
  });

  return { issues, patchedEntries };
}

/**
 * A command's shadow key is its FULL namespaced name — the path after
 * `commands/`, minus `.md` (`commands/deploy/ship.md` → `deploy/ship`). Keying
 * by the namespaced name (not the basename) means `commands/deploy/ship.md`
 * does not shadow a sibling-scope `commands/ship.md`.
 */
function commandName(entry: ClassifiedEntry): string {
  const segs = normalizePath(entry.path).split('/');
  const afterCommands = segs.slice(segs.indexOf(OUTERLAYER_DIR) + 2);
  return afterCommands.join('/').slice(0, -'.md'.length);
}

/** Nearest-scope-wins shadow detection for skills/commands — one issue per shadowed (losing) entry. */
function computeShadowIssues(entries: ClassifiedEntry[], kind: 'skill' | 'command'): ClassifyIssue[] {
  const group = entries.filter((e) => e.kind === kind);
  const nameOf = (e: ClassifiedEntry): string => (kind === 'skill' ? e.skillName! : commandName(e));

  const byName = new Map<string, ClassifiedEntry[]>();
  for (const e of group) {
    const name = nameOf(e);
    const list = byName.get(name);
    if (list) list.push(e);
    else byName.set(name, [e]);
  }

  const shadowedBy = new Map<string, { entry: ClassifiedEntry; name: string; winners: Set<string> }>();

  for (const [name, sameName] of byName) {
    if (sameName.length < 2) continue;
    const isShadowed = (x: ClassifiedEntry) =>
      sameName.some((y) => y !== x && y.scopePath !== x.scopePath && isAncestorScope(x.scopePath, y.scopePath));
    const winners = sameName.filter((e) => !isShadowed(e));
    for (const winner of winners) {
      for (const candidate of sameName) {
        if (candidate === winner) continue;
        if (candidate.scopePath === winner.scopePath) continue;
        if (!isAncestorScope(candidate.scopePath, winner.scopePath)) continue;
        const existing = shadowedBy.get(candidate.path);
        if (existing) existing.winners.add(winner.scopePath);
        else shadowedBy.set(candidate.path, { entry: candidate, name, winners: new Set([winner.scopePath]) });
      }
    }
  }

  return [...shadowedBy.values()]
    .sort((a, b) => a.entry.path.localeCompare(b.entry.path))
    .map(({ entry, name, winners }) => ({
      type: 'shadowed' as const,
      path: entry.path,
      scopePath: entry.scopePath,
      detail: `${kind} "${name}" is shadowed by a nearer definition at "${[...winners].sort().join('", "')}"`,
    }));
}
