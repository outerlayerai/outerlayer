import { sanitizeSearchTerm } from '../sanitize-search';

describe('sanitizeSearchTerm', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeSearchTerm('')).toBe('');
  });

  it('passes through normal alphanumeric strings', () => {
    expect(sanitizeSearchTerm('hello')).toBe('hello');
    expect(sanitizeSearchTerm('test123')).toBe('test123');
    expect(sanitizeSearchTerm('Hello World')).toBe('Hello World');
  });

  it('escapes SQL LIKE wildcards', () => {
    expect(sanitizeSearchTerm('100%')).toBe('100\\%');
    expect(sanitizeSearchTerm('test_value')).toBe('test\\_value');
    expect(sanitizeSearchTerm('50% off_sale')).toBe('50\\% off\\_sale');
  });

  it('escapes PostgREST filter syntax characters', () => {
    // Dot separates column.operator in PostgREST
    expect(sanitizeSearchTerm('user.name')).toBe('user\\.name');

    // Comma separates conditions in or()
    expect(sanitizeSearchTerm('a,b,c')).toBe('a\\,b\\,c');

    // Parentheses for grouping
    expect(sanitizeSearchTerm('(test)')).toBe('\\(test\\)');
  });

  it('escapes backslashes first to prevent double-escaping', () => {
    expect(sanitizeSearchTerm('path\\file')).toBe('path\\\\file');
    expect(sanitizeSearchTerm('a\\%b')).toBe('a\\\\\\%b');
  });

  it('handles complex attack strings', () => {
    // Attempt to inject a new filter condition
    const attack1 = 'admin),email.eq.admin@evil.com,(name.ilike.';
    expect(sanitizeSearchTerm(attack1)).toBe(
      'admin\\)\\,email\\.eq\\.admin@evil\\.com\\,\\(name\\.ilike\\.'
    );

    // Attempt to use wildcards for broader matching
    const attack2 = '%admin%';
    expect(sanitizeSearchTerm(attack2)).toBe('\\%admin\\%');
  });
});
