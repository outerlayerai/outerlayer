/**
 * `emitTree` — the emitter core. Compiles a
 * classified `.outerlayer/` source tree into one merged output tree across
 * every configured target: targets overlap (root/nested `AGENTS.md` serves
 * Cursor, Codex, Copilot, Factory at once), so emitting per-target and
 * merging after avoids conflicts a per-target-tree design would invite.
 *
 * Deterministic and pure: no fs, no dates, no environment reads;
 * output is sorted lexicographically by path so two calls over the same
 * input are byte-identical once serialized. `external-instructions` entries
 * (root `CLAUDE.md`/`AGENTS.md` outside `.outerlayer/`) are never sources for
 * emit — a target module only ever sees them via `entries`, and none of the
 * per-target builders match that kind.
 */
import type { FieldIssue } from '../kinds';
import { buildClaudeCode } from './targets/claude-code';
import { buildCodex } from './targets/codex';
import { buildCopilot } from './targets/copilot';
import { buildCursor } from './targets/cursor';
import { buildFactory } from './targets/factory';
import type { EmitCopy, EmitFile, EmitInput, EmitResult, TargetBuildResult, TargetId } from './types';

export type { EmitCopy, EmitFile, EmitInput, EmitResult, TargetBuildResult, TargetId } from './types';
export { ALL_TARGET_IDS } from './types';
export { cursorEnvRefRewrite, findEnvRefs, rewriteEnvRefs } from './env-refs';
export type { EnvRef, RewriteEnvRefsResult } from './env-refs';
export { parseOuterlayerConfig } from './config';
export type { OuterlayerConfig } from './config';

const TARGET_BUILDERS: Record<TargetId, (input: EmitInput) => TargetBuildResult> = {
  'claude-code': buildClaudeCode,
  cursor: buildCursor,
  codex: buildCodex,
  copilot: buildCopilot,
  factory: buildFactory,
};

export function emitTree(input: EmitInput): EmitResult {
  if (input.targets.length === 0) {
    return {
      files: [],
      copies: [],
      warnings: [],
      errors: [{ path: 'targets', code: 'no_targets', message: 'no targets configured — nothing to emit' }],
    };
  }

  const perTarget = input.targets.map((target) => TARGET_BUILDERS[target](input));
  return mergeEmitResults(perTarget);
}

/**
 * The merge step, split out as its own primitive so conflict/dedup behavior
 * is directly testable against hand-built `TargetBuildResult`s — the five
 * real target modules never collide with *different* content at the same
 * path by construction, so exercising the
 * conflict path for real requires fabricating the inputs `emitTree` would
 * otherwise only ever produce non-conflicting versions of.
 */
export function mergeEmitResults(perTarget: TargetBuildResult[]): EmitResult {
  const { files, errors: fileErrors } = mergeFiles(perTarget.map((r) => r.files));
  const { copies, errors: copyErrors } = mergeCopies(perTarget.map((r) => r.copies));
  const warnings = sortIssues(perTarget.flatMap((r) => r.warnings));
  const errors = sortIssues([...fileErrors, ...copyErrors]);

  return { files, copies, warnings, errors };
}

function sortIssues(issues: FieldIssue[]): FieldIssue[] {
  return [...issues].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}

/**
 * Merges per-target file lists by output path. Identical content at the same
 * path (e.g. Cursor + Copilot both emitting the same root `AGENTS.md`) dedups
 * silently — that's construction, not luck: both targets build it from the
 * same source entry via the same header/passthrough logic. Genuinely
 * different content at the same path is a conflict: one `errors` entry, no
 * file written (never last-writer-wins).
 */
function mergeFiles(perTarget: EmitFile[][]): { files: EmitFile[]; errors: FieldIssue[] } {
  const byPath = new Map<string, string>();
  const conflicted = new Set<string>();

  for (const files of perTarget) {
    for (const f of files) {
      const existing = byPath.get(f.path);
      if (existing === undefined) byPath.set(f.path, f.content);
      else if (existing !== f.content) conflicted.add(f.path);
    }
  }

  const errors: FieldIssue[] = [...conflicted]
    .sort()
    .map((path) => ({ path, code: 'path_conflict', message: `multiple targets emit different content at "${path}" — no file written` }));

  const files: EmitFile[] = [...byPath.entries()]
    .filter(([path]) => !conflicted.has(path))
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { files, errors };
}

function mergeCopies(perTarget: EmitCopy[][]): { copies: EmitCopy[]; errors: FieldIssue[] } {
  const byPath = new Map<string, string>();
  const conflicted = new Set<string>();

  for (const copies of perTarget) {
    for (const c of copies) {
      const existing = byPath.get(c.toPath);
      if (existing === undefined) byPath.set(c.toPath, c.fromSourcePath);
      else if (existing !== c.fromSourcePath) conflicted.add(c.toPath);
    }
  }

  const errors: FieldIssue[] = [...conflicted]
    .sort()
    .map((path) => ({ path, code: 'path_conflict', message: `multiple targets copy different sources to "${path}" — no file copied` }));

  const copies: EmitCopy[] = [...byPath.entries()]
    .filter(([path]) => !conflicted.has(path))
    .map(([toPath, fromSourcePath]) => ({ toPath, fromSourcePath }))
    .sort((a, b) => a.toPath.localeCompare(b.toPath));

  return { copies, errors };
}
