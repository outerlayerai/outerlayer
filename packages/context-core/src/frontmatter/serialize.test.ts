import { describe, expect, it } from 'vitest';
import { parseContextFile, type ParsedContextFile } from '@outerlayer/context-format';
import { serializeContextFile } from './serialize';

describe('serializeContextFile — byte-stable for untouched input', () => {
  it('reproduces the original bytes exactly when nothing changed', () => {
    const raw =
      '---\nname: deploy\ndescription: Ships it\ncustom_field: keep-me\ntags:\n  - a\n  - b\n---\n# Deploy\n\nSome *body* with  double  spaces.\n';
    const parsed = parseContextFile(raw);

    expect(serializeContextFile(parsed)).toBe(raw);
  });

  it('is byte-stable even when the caller rebuilds a structurally-identical frontmatter object (not the same reference)', () => {
    const raw = '---\nname: deploy\ndescription: Ships it\n---\nBody.\n';
    const parsed = parseContextFile(raw);
    const rebuilt: ParsedContextFile = { ...parsed, frontmatter: { name: 'deploy', description: 'Ships it' } };

    expect(serializeContextFile(rebuilt)).toBe(raw);
  });

  it('reproduces a file with no frontmatter at all exactly', () => {
    const raw = 'Just a body, no frontmatter.\n';
    expect(serializeContextFile(parseContextFile(raw))).toBe(raw);
  });

  it('preserves CRLF line endings on an untouched round-trip', () => {
    const raw = '---\r\nname: deploy\r\ndescription: Ships it\r\n---\r\nBody.\r\n';
    expect(serializeContextFile(parseContextFile(raw))).toBe(raw);
  });
});

describe('serializeContextFile — edits via direct frontmatter mutation', () => {
  it('changes one field while leaving unknown keys and the body untouched', () => {
    const raw = '---\nname: deploy\ndescription: old\ncustom_field: keep-me\n---\nBody.\n';
    const parsed = parseContextFile(raw);
    const edited: ParsedContextFile = { ...parsed, frontmatter: { ...parsed.frontmatter, description: 'new' } };

    const next = serializeContextFile(edited);
    const reparsed = parseContextFile(next);

    expect(reparsed.frontmatter).toEqual({ name: 'deploy', description: 'new', custom_field: 'keep-me' });
    expect(reparsed.body).toBe('Body.\n');
  });

  it('re-emits CRLF after an edit on a CRLF file', () => {
    const raw = '---\r\nname: deploy\r\ndescription: old\r\n---\r\nBody.\r\n';
    const parsed = parseContextFile(raw);
    const edited: ParsedContextFile = { ...parsed, frontmatter: { ...parsed.frontmatter, description: 'new' } };

    expect(serializeContextFile(edited)).toBe('---\r\nname: deploy\r\ndescription: new\r\n---\r\nBody.\r\n');
  });

  it('deletes a key when it is absent from the new frontmatter object', () => {
    const raw = '---\nname: deploy\ndescription: old\ncustom_field: keep-me\n---\nBody.\n';
    const parsed = parseContextFile(raw);
    const { custom_field: _drop, ...rest } = parsed.frontmatter!;
    const edited: ParsedContextFile = { ...parsed, frontmatter: rest };

    const reparsed = parseContextFile(serializeContextFile(edited));
    expect(reparsed.frontmatter).toEqual({ name: 'deploy', description: 'old' });
  });

  it('adds a frontmatter block to a file that had none', () => {
    const raw = 'Just a body, no frontmatter.\n';
    const parsed = parseContextFile(raw);
    const edited: ParsedContextFile = { ...parsed, frontmatter: { description: 'A reference doc' } };

    const reparsed = parseContextFile(serializeContextFile(edited));
    expect(reparsed.frontmatter).toEqual({ description: 'A reference doc' });
    expect(reparsed.body).toBe(raw);
  });

  it('removes the frontmatter block entirely when the frontmatter becomes empty', () => {
    const raw = '---\ndescription: only field\n---\nBody.\n';
    const parsed = parseContextFile(raw);
    const edited: ParsedContextFile = { ...parsed, frontmatter: {} };

    expect(serializeContextFile(edited)).toBe('Body.\n');
  });

  it('removes the frontmatter block entirely when frontmatter is set to null', () => {
    const raw = '---\ndescription: only field\n---\nBody.\n';
    const parsed = parseContextFile(raw);
    const edited: ParsedContextFile = { ...parsed, frontmatter: null };

    expect(serializeContextFile(edited)).toBe('Body.\n');
  });

  it('replaces the body outright alongside a frontmatter edit', () => {
    const raw = '---\nname: deploy\n---\nOld body.\n';
    const parsed = parseContextFile(raw);
    const edited: ParsedContextFile = { ...parsed, body: 'New body.\n' };

    expect(serializeContextFile(edited)).toBe('---\nname: deploy\n---\nNew body.\n');
  });
});
