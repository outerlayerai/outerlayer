import { describe, expect, it } from 'vitest';
import { parseEmailAllowlist, isEmailAllowed } from './email-allowlist';

describe('parseEmailAllowlist', () => {
  it('is empty when unset', () => {
    expect(parseEmailAllowlist(undefined)).toEqual([]);
  });

  it('is empty for a value of only separators and whitespace', () => {
    expect(parseEmailAllowlist(' , ,, ')).toEqual([]);
  });

  it('splits, trims, and lowercases entries in order', () => {
    expect(parseEmailAllowlist('@Corp.com, Someone@Other.COM ,,@third.io')).toEqual([
      '@corp.com',
      'someone@other.com',
      '@third.io',
    ]);
  });
});

describe('isEmailAllowed', () => {
  it('permits everything when the allowlist is empty', () => {
    expect(isEmailAllowed('anyone@anywhere.test', [])).toBe(true);
  });

  it('matches a domain entry on the @-suffix', () => {
    expect(isEmailAllowed('dev@corp.com', ['@corp.com'])).toBe(true);
  });

  it('matches a whole-address entry exactly', () => {
    expect(isEmailAllowed('dev@corp.com', ['dev@corp.com'])).toBe(true);
  });

  it('rejects a different local part when the entry is a whole address', () => {
    expect(isEmailAllowed('other@corp.com', ['dev@corp.com'])).toBe(false);
  });

  it('normalizes case and surrounding whitespace on the candidate', () => {
    expect(isEmailAllowed('  Dev@Corp.com ', ['dev@corp.com'])).toBe(true);
  });

  it('matches when any one of several entries applies', () => {
    expect(isEmailAllowed('dev@corp.com', ['@other.io', 'dev@corp.com'])).toBe(true);
  });

  // The @ is part of the domain comparison so a lookalike domain that merely
  // ends with the allowed one cannot pass the guard.
  it.each([
    'attacker@evil-corp.com',
    'attacker@notcorp.com',
    'attacker@sub.corp.com',
    'attacker@corp.com.evil.io',
  ])('rejects the lookalike domain %j against @corp.com', (email) => {
    expect(isEmailAllowed(email, ['@corp.com'])).toBe(false);
  });

  it('rejects an address that only contains the allowed domain in its local part', () => {
    expect(isEmailAllowed('dev@corp.com@evil.io', ['@corp.com'])).toBe(false);
  });
});
