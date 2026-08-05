import { describe, expect, it } from 'vitest';
import { parseContextFile } from './parse';

describe('parseContextFile — pure split, never throws', () => {
  it('parses a well-formed frontmatter block and body', () => {
    const raw = '---\nname: deploy\ndescription: Ships it\n---\nBody text.\n';
    const parsed = parseContextFile(raw);

    expect(parsed).toEqual({
      frontmatter: { name: 'deploy', description: 'Ships it' },
      body: 'Body text.\n',
      raw,
    });
  });

  it('returns frontmatter: null and the whole content as body when there is no leading delimiter', () => {
    const raw = '# Just a doc\n\nNo frontmatter here.\n';
    expect(parseContextFile(raw)).toEqual({ frontmatter: null, body: raw, raw });
  });

  it('returns frontmatter: null when the leading --- has no closing delimiter', () => {
    const raw = '---\nname: deploy\nBody without a closing delimiter.\n';
    expect(parseContextFile(raw)).toEqual({ frontmatter: null, body: raw, raw });
  });

  it('parses an empty frontmatter block as an empty object, distinct from no block at all', () => {
    const raw = '---\n---\nBody.\n';
    expect(parseContextFile(raw)).toEqual({ frontmatter: {}, body: 'Body.\n', raw });
  });

  it('parses CRLF frontmatter and preserves CRLF body untouched', () => {
    const raw = '---\r\nname: deploy\r\ndescription: Ships it\r\n---\r\nBody line one.\r\nBody line two.\r\n';
    const parsed = parseContextFile(raw);

    expect(parsed.frontmatter).toEqual({ name: 'deploy', description: 'Ships it' });
    expect(parsed.body).toBe('Body line one.\r\nBody line two.\r\n');
    expect(parsed.raw).toBe(raw);
  });

  it('returns frontmatter: null (never throws) when the block is not a YAML mapping', () => {
    const raw = '---\n- a\n- b\n---\nBody.\n';
    // A throw here would fail this test directly (uncaught exception) — the
    // toEqual below is what proves the "never throws, returns null" contract.
    expect(parseContextFile(raw)).toEqual({ frontmatter: null, body: 'Body.\n', raw });
  });

  it('returns frontmatter: null (never throws) on malformed YAML', () => {
    const raw = '---\nname: [unclosed\n---\nBody.\n';
    expect(parseContextFile(raw).frontmatter).toBeNull();
  });

  it('handles a frontmatter block with no trailing newline after the closing delimiter (EOF)', () => {
    const raw = '---\nname: deploy\n---';
    expect(parseContextFile(raw)).toEqual({ frontmatter: { name: 'deploy' }, body: '', raw });
  });
});
