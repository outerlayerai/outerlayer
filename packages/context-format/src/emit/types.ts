/**
 * Emitter contract types. `emitTree`
 * compiles a classified `.outerlayer/` source tree into every configured
 * target's native files — pure, deterministic, no I/O.
 */
import type { ClassifiedEntry, FieldIssue } from '../kinds';

export type TargetId = 'claude-code' | 'cursor' | 'codex' | 'copilot' | 'factory';

export const ALL_TARGET_IDS: readonly TargetId[] = ['claude-code', 'cursor', 'codex', 'copilot', 'factory'];

export interface EmitInput {
  entries: ClassifiedEntry[];
  /** Repo-relative path → source content, content kinds only (instructions/skill/skill-reference/command/mcp). */
  contents: ReadonlyMap<string, string>;
  /** Explicit per-target opt-in — empty is a hard `no_targets` refusal, never an implicit default. */
  targets: TargetId[];
  /**
   * Repo-relative paths of skill assets/scripts. `classifyTree` never
   * puts these in `entries` — the mirror/UI only ever sees an aggregate
   * count, never the paths, because the product does not display or mirror
   * them. The emitter's caller (the future CLI) reads the git tree directly
   * and has no such restriction, so it supplies the raw paths here for
   * byte-copy passthrough ("the emitter copies them verbatim from git").
   */
  assetPaths: string[];
}

export interface EmitFile {
  path: string;
  content: string;
}

/** Binary/asset passthrough — the emitter never touches bytes, the CLI does the copy. */
export interface EmitCopy {
  toPath: string;
  fromSourcePath: string;
}

export interface EmitResult {
  files: EmitFile[];
  copies: EmitCopy[];
  warnings: FieldIssue[];
  errors: FieldIssue[];
}

/** Per-target module return shape — merged (and conflict-checked) by `emitTree`. */
export interface TargetBuildResult {
  files: EmitFile[];
  copies: EmitCopy[];
  warnings: FieldIssue[];
}
