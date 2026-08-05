import { describe, expect, it } from 'vitest';
import {
  commandFrontmatterSchema,
  referenceFrontmatterSchema,
  skillFrontmatterSchema,
  subagentFrontmatterSchema,
  validateFrontmatter,
} from './schemas';
import type { ParsedContextFile } from '@outerlayer/context-format';

function file(frontmatter: Record<string, unknown> | null, body = 'Body.\n'): ParsedContextFile {
  const raw = frontmatter === null ? body : `---\n---\n${body}`;
  return { frontmatter, body, raw };
}

describe('skillFrontmatterSchema', () => {
  it.each([
    ['a', true],
    ['a1', true],
    ['deploy-checklist', true],
    ['deploy-checklist-2', true],
    ['-deploy', false],
    ['deploy-', false],
    ['deploy--checklist', false],
    ['Deploy', false],
    ['deploy_checklist', false],
    ['', false],
  ])('name %j is valid=%s', (name, expected) => {
    const result = skillFrontmatterSchema.safeParse({ name, description: 'x' });
    expect(result.success).toBe(expected);
  });

  it('rejects a name over 64 characters', () => {
    const result = skillFrontmatterSchema.safeParse({ name: 'a'.repeat(65), description: 'x' });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields: license, compatibility, metadata, allowed-tools', () => {
    const result = skillFrontmatterSchema.safeParse({
      name: 'deploy',
      description: 'x',
      license: 'MIT',
      compatibility: 'works with v2+',
      metadata: { team: 'platform' },
      'allowed-tools': ['bash', 'read'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects compatibility over 500 characters', () => {
    const result = skillFrontmatterSchema.safeParse({
      name: 'deploy',
      description: 'x',
      compatibility: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a metadata map with non-string values', () => {
    const result = skillFrontmatterSchema.safeParse({ name: 'deploy', description: 'x', metadata: { count: 5 } });
    expect(result.success).toBe(false);
  });
});

describe('commandFrontmatterSchema', () => {
  it('requires description and allows optional argument-hint', () => {
    expect(commandFrontmatterSchema.safeParse({}).success).toBe(false);
    expect(commandFrontmatterSchema.safeParse({ description: 'Ships it' }).success).toBe(true);
    expect(commandFrontmatterSchema.safeParse({ description: 'Ships it', 'argument-hint': '<env>' }).success).toBe(
      true,
    );
  });
});

describe('subagentFrontmatterSchema', () => {
  it.each([
    ['reviewer', true],
    ['code-reviewer', true],
    ['reviewer2', false],
    ['reviewer_2', false],
    ['Reviewer', false],
    ['-reviewer', false],
  ])('name %j is valid=%s', (name, expected) => {
    const result = subagentFrontmatterSchema.safeParse({ name, description: 'x' });
    expect(result.success).toBe(expected);
  });

  it('accepts the cross-tool default model keyword "inherit" as an ordinary string', () => {
    expect(subagentFrontmatterSchema.safeParse({ name: 'reviewer', description: 'x', model: 'inherit' }).success).toBe(
      true,
    );
  });
});

describe('referenceFrontmatterSchema', () => {
  it('has no required fields', () => {
    expect(referenceFrontmatterSchema.safeParse({}).success).toBe(true);
  });
});

describe('validateFrontmatter — per-kind, ZodError never crosses the boundary', () => {
  it('accepts a valid skill frontmatter whose name matches its directory', () => {
    const result = validateFrontmatter(
      'skill',
      file({ name: 'deploy-checklist', description: 'Ships safely' }),
      { dirName: 'deploy-checklist' },
    );
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('rejects a skill name containing consecutive hyphens with the exact path/code/message', () => {
    const result = validateFrontmatter('skill', file({ name: 'deploy--checklist', description: 'x' }), {
      dirName: 'deploy--checklist',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        path: 'name',
        code: 'invalid_format',
        message:
          'must be lowercase alphanumeric with single hyphens; no leading, trailing, or consecutive hyphens',
      },
    ]);
  });

  it('rejects a skill whose name does not equal its directory name', () => {
    const result = validateFrontmatter('skill', file({ name: 'deploy', description: 'x' }), {
      dirName: 'deploy-checklist',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: 'name', code: 'name_mismatch', message: 'skill "name" ("deploy") must equal its directory name ("deploy-checklist")' },
    ]);
  });

  it('rejects a skill description over 1024 characters', () => {
    const result = validateFrontmatter('skill', file({ name: 'deploy', description: 'x'.repeat(1025) }), {
      dirName: 'deploy',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: 'description', code: 'too_big', message: 'Too big: expected string to have <=1024 characters' },
    ]);
  });

  it('rejects frontmatter present on an instructions (AGENTS.md) file', () => {
    const result = validateFrontmatter('instructions', file({ description: 'nope' }));

    expect(result).toEqual({
      ok: false,
      errors: [{ path: '(frontmatter)', code: 'frontmatter_forbidden', message: 'AGENTS.md must not have frontmatter' }],
      warnings: [],
    });
  });

  it('accepts an instructions file with no frontmatter present', () => {
    const result = validateFrontmatter('instructions', file(null));
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('treats external-instructions the same as instructions — frontmatter forbidden', () => {
    const result = validateFrontmatter('external-instructions', file({ description: 'nope' }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe('frontmatter_forbidden');
  });

  it('treats a folder (.gitkeep keeper) as trivially valid — nothing to validate', () => {
    expect(validateFrontmatter('folder', file(null))).toEqual({ ok: true, errors: [], warnings: [] });
    // Even if a keeper somehow carried frontmatter, a folder is never validated against a schema.
    expect(validateFrontmatter('folder', file({ description: 'ignored' }))).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('rejects a subagent whose name does not equal its filename stem', () => {
    const result = validateFrontmatter('subagent', file({ name: 'code-reviewer', description: 'x' }), {
      fileStem: 'reviewer',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: 'name', code: 'name_mismatch', message: 'subagent "name" ("code-reviewer") must equal its filename ("reviewer")' },
    ]);
  });

  it('rejects a subagent name containing digits', () => {
    const result = validateFrontmatter('subagent', file({ name: 'reviewer2', description: 'x' }), {
      fileStem: 'reviewer2',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: 'name', code: 'invalid_format', message: 'must be lowercase letters and single hyphens only' },
    ]);
  });

  it('requires a command description', () => {
    const result = validateFrontmatter('command', file({}));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: 'description', code: 'invalid_type', message: 'Invalid input: expected string, received undefined' },
    ]);
  });

  it('flags unknown frontmatter keys as warnings, not errors, and preserves them', () => {
    const result = validateFrontmatter(
      'skill',
      file({ name: 'deploy', description: 'x', context: true, hooks: ['pre'] }),
      { dirName: 'deploy' },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      { path: 'context', code: 'unknown_key', message: 'unknown frontmatter key "context" — preserved, not validated' },
      { path: 'hooks', code: 'unknown_key', message: 'unknown frontmatter key "hooks" — preserved, not validated' },
    ]);
  });

  it('accepts a reference with no frontmatter fields at all', () => {
    expect(validateFrontmatter('reference', file(null))).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('validates skill-reference and mcp kinds against the reference (all-optional) schema', () => {
    expect(validateFrontmatter('skill-reference', file({ description: 'ok' }))).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
    expect(validateFrontmatter('mcp', file(null))).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('treats a null frontmatter as an empty object for kinds with required fields, producing normal required-field errors', () => {
    const result = validateFrontmatter('skill', file(null), { dirName: 'deploy' });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.path).sort()).toEqual(['description', 'name']);
  });
});
