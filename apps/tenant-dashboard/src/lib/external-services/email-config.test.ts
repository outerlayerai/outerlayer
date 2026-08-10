import { describe, expect, it } from 'vitest';
import {
  resolveEmailConfig,
  resolveRecipientAllowlist,
  isRecipientAllowed,
} from './email-config';

describe('resolveEmailConfig', () => {
  it('is disabled and defaults to resend when nothing is set', () => {
    expect(resolveEmailConfig({})).toEqual({ enabled: false, backend: 'resend' });
  });

  it('stays disabled when EMAIL_ENABLED is falsey', () => {
    expect(resolveEmailConfig({ EMAIL_ENABLED: 'false' })).toEqual({
      enabled: false,
      backend: 'resend',
    });
  });

  it('enables the resend backend by default when EMAIL_ENABLED is true', () => {
    expect(resolveEmailConfig({ EMAIL_ENABLED: 'true' })).toEqual({
      enabled: true,
      backend: 'resend',
    });
  });

  it('enables the smtp backend when EMAIL_PROVIDER=smtp', () => {
    expect(
      resolveEmailConfig({ EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'smtp' })
    ).toEqual({ enabled: true, backend: 'smtp' });
  });

  it('honours an explicit resend provider', () => {
    expect(
      resolveEmailConfig({ EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'resend' })
    ).toEqual({ enabled: true, backend: 'resend' });
  });

  it('falls back to resend for an unknown provider', () => {
    expect(
      resolveEmailConfig({ EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'mailgun' })
    ).toEqual({ enabled: true, backend: 'resend' });
  });

  it('resolves the backend even while disabled (selection independent of enabled)', () => {
    expect(resolveEmailConfig({ EMAIL_PROVIDER: 'smtp' })).toEqual({
      enabled: false,
      backend: 'smtp',
    });
  });

  it.each(['1', 'yes', 'on', 'TRUE'])(
    'accepts the truthy spelling %j for EMAIL_ENABLED',
    (raw) => {
      expect(resolveEmailConfig({ EMAIL_ENABLED: raw }).enabled).toBe(true);
    }
  );
});

describe('resolveRecipientAllowlist', () => {
  it('is empty when unset', () => {
    expect(resolveRecipientAllowlist({})).toEqual([]);
  });

  it('is empty for a value of only separators and whitespace', () => {
    expect(resolveRecipientAllowlist({ EMAIL_RECIPIENT_ALLOWLIST: ' , ,, ' })).toEqual([]);
  });

  it('splits, trims, and lowercases entries in order', () => {
    expect(
      resolveRecipientAllowlist({
        EMAIL_RECIPIENT_ALLOWLIST: '@Corp.com, Someone@Other.COM ,,@third.io',
      })
    ).toEqual(['@corp.com', 'someone@other.com', '@third.io']);
  });
});

describe('isRecipientAllowed', () => {
  it('permits everything when the allowlist is empty', () => {
    expect(isRecipientAllowed('anyone@anywhere.test', [])).toBe(true);
  });

  it('matches a domain entry on the @-suffix', () => {
    expect(isRecipientAllowed('dev@corp.com', ['@corp.com'])).toBe(true);
  });

  it('matches a whole-address entry exactly', () => {
    expect(isRecipientAllowed('dev@corp.com', ['dev@corp.com'])).toBe(true);
  });

  it('rejects a different local part when the entry is a whole address', () => {
    expect(isRecipientAllowed('other@corp.com', ['dev@corp.com'])).toBe(false);
  });

  it('normalizes case and surrounding whitespace on the candidate', () => {
    expect(isRecipientAllowed('  Dev@Corp.com ', ['dev@corp.com'])).toBe(true);
  });

  it('matches when any one of several entries applies', () => {
    expect(isRecipientAllowed('dev@corp.com', ['@other.io', 'dev@corp.com'])).toBe(true);
  });

  // The @ is part of the domain comparison so a lookalike domain that merely
  // ends with the allowed one cannot pass the guard.
  it.each([
    'attacker@evil-corp.com',
    'attacker@notcorp.com',
    'attacker@sub.corp.com',
    'attacker@corp.com.evil.io',
  ])('rejects the lookalike domain %j against @corp.com', (email) => {
    expect(isRecipientAllowed(email, ['@corp.com'])).toBe(false);
  });

  it('rejects an address that only contains the allowed domain in its local part', () => {
    expect(isRecipientAllowed('dev@corp.com@evil.io', ['@corp.com'])).toBe(false);
  });
});
