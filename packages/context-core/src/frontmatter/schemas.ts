/**
 * Per-kind Zod frontmatter schemas, plus
 * `validateFrontmatter`, the boundary function where Zod stays internal:
 * `ZodError` never crosses the public API, only `FieldIssue`/`ValidationResult`.
 */
import { z } from 'zod';
import type { ContextKind, FieldIssue, ParsedContextFile, ValidationResult } from '@outerlayer/context-format';

/** Lowercase alphanumeric, single hyphens, no leading/trailing/consecutive hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Lowercase letters and single hyphens only — the strictest-common charset (no digits/underscores). */
const SUBAGENT_NAME_PATTERN = /^[a-z]+(-[a-z]+)*$/;

export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      SKILL_NAME_PATTERN,
      'must be lowercase alphanumeric with single hyphens; no leading, trailing, or consecutive hyphens',
    ),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
});

export const commandFrontmatterSchema = z.object({
  description: z.string().min(1),
  'argument-hint': z.string().optional(),
});

export const subagentFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(SUBAGENT_NAME_PATTERN, 'must be lowercase letters and single hyphens only'),
  description: z.string().min(1),
  model: z.string().optional(),
});

export const referenceFrontmatterSchema = z.object({
  description: z.string().optional(),
});

/** `skill-reference` and `mcp` have no dedicated schema — they validate as `reference` (all optional). */
function schemaForKind(kind: ContextKind) {
  switch (kind) {
    case 'skill':
      return skillFrontmatterSchema;
    case 'command':
      return commandFrontmatterSchema;
    case 'subagent':
      return subagentFrontmatterSchema;
    case 'reference':
    case 'skill-reference':
    case 'mcp':
      return referenceFrontmatterSchema;
    case 'instructions':
    case 'external-instructions':
    case 'folder':
      return null;
  }
}

export interface ValidateFrontmatterContext {
  /** skill: containing directory name — frontmatter `name` must equal it. */
  dirName?: string;
  /** subagent: filename stem — frontmatter `name` must equal it. */
  fileStem?: string;
}

/**
 * Validates a parsed file's frontmatter against its kind's schema plus the
 * cross-field rules the schema alone can't express (skill name === dir name,
 * subagent name === filename, AGENTS.md frontmatter ban).
 */
export function validateFrontmatter(
  kind: ContextKind,
  file: ParsedContextFile,
  ctx: ValidateFrontmatterContext = {},
): ValidationResult {
  if (kind === 'instructions' || kind === 'external-instructions') {
    if (file.frontmatter !== null) {
      return {
        ok: false,
        errors: [
          { path: '(frontmatter)', code: 'frontmatter_forbidden', message: 'AGENTS.md must not have frontmatter' },
        ],
        warnings: [],
      };
    }
    return { ok: true, errors: [], warnings: [] };
  }

  // A `folder` entry is a `.gitkeep` keeper — empty by construction, no
  // frontmatter to validate; it is trivially valid.
  if (kind === 'folder') {
    return { ok: true, errors: [], warnings: [] };
  }

  const schema = schemaForKind(kind)!;
  const frontmatter = file.frontmatter ?? {};
  const result = schema.safeParse(frontmatter);

  const errors: FieldIssue[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        code: issue.code,
        message: issue.message,
      }));

  if (result.success && kind === 'skill' && ctx.dirName !== undefined) {
    const data = result.data as { name: string };
    if (data.name !== ctx.dirName) {
      errors.push({
        path: 'name',
        code: 'name_mismatch',
        message: `skill "name" ("${data.name}") must equal its directory name ("${ctx.dirName}")`,
      });
    }
  }

  if (result.success && kind === 'subagent' && ctx.fileStem !== undefined) {
    const data = result.data as { name: string };
    if (data.name !== ctx.fileStem) {
      errors.push({
        path: 'name',
        code: 'name_mismatch',
        message: `subagent "name" ("${data.name}") must equal its filename ("${ctx.fileStem}")`,
      });
    }
  }

  const knownKeys = new Set(Object.keys(schema.shape));
  const warnings: FieldIssue[] = Object.keys(frontmatter)
    .filter((key) => !knownKeys.has(key))
    .map((key) => ({ path: key, code: 'unknown_key', message: `unknown frontmatter key "${key}" — preserved, not validated` }));

  return { ok: errors.length === 0, errors, warnings };
}
