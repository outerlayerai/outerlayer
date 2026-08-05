import { describe, expect, test } from 'vitest';
import { unwrapMessages } from '../message-unwrap';

describe('unwrapMessages', () => {
  test('unwraps the OTLP messages envelope to its joined content', () => {
    expect(unwrapMessages('[{"role":"user","content":"use @repo/api, not the legacy client"}]')).toBe(
      'use @repo/api, not the legacy client',
    );
    expect(
      unwrapMessages('[{"role":"user","content":"first"},{"role":"assistant","content":"second"}]'),
    ).toBe('first\nsecond');
  });

  test('non-string content is JSON-stringified, not dropped', () => {
    expect(unwrapMessages('[{"role":"user","content":{"parts":["a"]}}]')).toBe('{"parts":["a"]}');
  });

  test('plain strings, tool JSON, and non-message arrays pass through untouched', () => {
    expect(unwrapMessages('just some words the developer typed')).toBe('just some words the developer typed');
    // A tool payload array without role/content is not the messages shape.
    expect(unwrapMessages('[{"path":"/x","bytes":10}]')).toBe('[{"path":"/x","bytes":10}]');
    // Malformed JSON starting with '[' returns as-is (never throws).
    expect(unwrapMessages('[not json')).toBe('[not json');
    expect(unwrapMessages('')).toBe('');
  });

  test('an empty array is not the messages shape — passes through, never becomes ""', () => {
    expect(unwrapMessages('[]')).toBe('[]');
  });

  test('a partial envelope missing role or content is not unwrapped', () => {
    // Only content, no role.
    expect(unwrapMessages('[{"content":"only content"}]')).toBe('[{"content":"only content"}]');
    // Only role, no content.
    expect(unwrapMessages('[{"role":"user"}]')).toBe('[{"role":"user"}]');
  });

  test('a null or primitive element is not an object envelope — passes through', () => {
    expect(unwrapMessages('[null]')).toBe('[null]');
    expect(unwrapMessages('["a bare string"]')).toBe('["a bare string"]');
  });

  test('EVERY element must be a message — one non-envelope element blocks the unwrap', () => {
    const mixed = '[{"role":"user","content":"real words"},"stray"]';
    expect(unwrapMessages(mixed)).toBe(mixed);
    const oneBad = '[{"role":"user","content":"real words"},{"path":"/x"}]';
    expect(unwrapMessages(oneBad)).toBe(oneBad);
  });
});
