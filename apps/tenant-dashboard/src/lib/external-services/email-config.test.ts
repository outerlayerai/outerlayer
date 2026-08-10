import { describe, expect, it } from 'vitest';
import {
  resolveEmailConfig,
  resolveRecipientAllowlist,
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
