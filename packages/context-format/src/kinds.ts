/**
 * Shared classification + validation contract types.
 * `external-instructions` is folded directly into `ContextKind` (not a
 * separate type) — it's a read-only marker kind, not a
 * different category of thing.
 */

export type ContextKind =
  | 'instructions'
  | 'skill'
  | 'skill-reference'
  | 'command'
  | 'reference'
  | 'mcp'
  | 'subagent'
  | 'folder'
  | 'external-instructions';

export interface ClassifiedEntry {
  /** Repo-relative, `/`-normalized path. */
  path: string;
  kind: ContextKind;
  /** Parent dir of the governing `.outerlayer/` dir (or the file's own parent dir for external-instructions). `''` = repo root. */
  scopePath: string;
  /** Set for `skill` and `skill-reference` kinds only — the skill's directory name. */
  skillName?: string;
  /**
   * Set for `command` kinds that live in a namespace — the intermediate
   * segments between `commands/` and the filename (`commands/deploy/ship.md`
   * → `['deploy']`). Absent for a flat command, so a flat entry stays
   * byte-identical to its pre-namespace shape.
   */
  namespace?: string[];
}

export interface ClassifyIssue {
  /**
   * `missing-skill-md`: a skill dir with no SKILL.md. `shadowed`: a
   * skill/command hidden by a nearer-scope definition. `misplaced`: a file
   * in a location that carries no meaning — a subagent nested under
   * `agents/`, or a command whose namespace segment is not a valid name.
   */
  type: 'missing-skill-md' | 'shadowed' | 'misplaced';
  /** The relevant file path — the expected-but-absent SKILL.md for `missing-skill-md`, the offending file for `shadowed`/`misplaced`. */
  path: string;
  scopePath: string;
  detail: string;
}

export interface ClassifyResult {
  entries: ClassifiedEntry[];
  excludedCounts: Array<{ scopePath: string; skillName: string; count: number }>;
  issues: ClassifyIssue[];
}

export interface FieldIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: FieldIssue[];
  warnings: FieldIssue[];
}

export interface ParsedContextFile {
  frontmatter: Record<string, unknown> | null;
  body: string;
  /** The full original file content, verbatim — the byte-stable fallback source for serialize. */
  raw: string;
}
