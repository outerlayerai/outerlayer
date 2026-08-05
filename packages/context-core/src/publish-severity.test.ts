import { describe, expect, it } from 'vitest';
import { classifyPublishValidation } from './publish-severity';

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`;

describe('classifyPublishValidation — two-tier publish gate', () => {
  it('demotes an empty description to a warning, keeping the file publishable', () => {
    const result = classifyPublishValidation('skill', skill('my-skill', ''), { dirName: 'my-skill' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.path).toBe('description');
  });

  it('demotes a missing description (no frontmatter block) to a warning', () => {
    const result = classifyPublishValidation('command', '# Just a body, no frontmatter\n');
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.path === 'description')).toBe(true);
  });

  it('keeps unparseable frontmatter YAML a hard error', () => {
    const broken = `---\nname: [unclosed\n---\n# Body\n`;
    const result = classifyPublishValidation('skill', broken, { dirName: 'my-skill' });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { path: '(frontmatter)', code: 'frontmatter_unparseable', message: 'frontmatter is not valid YAML' },
    ]);
  });

  it('keeps invalid mcp.json a hard error', () => {
    const result = classifyPublishValidation('mcp', '{ not valid json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid_json');
  });

  it('keeps a literal secret in mcp.json a hard error (security)', () => {
    const content = JSON.stringify({
      mcpServers: { foo: { command: 'run', env: { API_KEY: 'sk-abcdef1234567890' } } },
    });
    const result = classifyPublishValidation('mcp', content);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'secret-literal')).toBe(true);
  });

  it('keeps a skill name that mismatches its directory a hard error', () => {
    const result = classifyPublishValidation('skill', skill('other-name', 'A description'), {
      dirName: 'my-skill',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'name_mismatch')).toBe(true);
  });

  it('passes a fully valid skill with no errors or warnings', () => {
    const result = classifyPublishValidation('skill', skill('my-skill', 'Does a thing'), {
      dirName: 'my-skill',
    });
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });
});
