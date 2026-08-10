import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * `SIGNUP_EMAIL_ALLOWLIST` is read at module scope through
 * config-global.server, so each case re-imports the gate against a mocked
 * config rather than mutating the already-bound value.
 */
async function importGateWith(allowlist: string | undefined) {
  vi.resetModules();
  vi.doMock('../../../config-global.server', () => ({
    SIGNUP_EMAIL_ALLOWLIST: allowlist,
  }));
  return import('./signup-allowlist');
}

describe('isSignupEmailAllowed', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../../config-global.server');
    vi.resetModules();
  });

  it('allows any address when no allowlist is configured', async () => {
    const { isSignupEmailAllowed } = await importGateWith(undefined);
    expect(isSignupEmailAllowed('stranger@gmail.com')).toBe(true);
  });

  it('allows an address on the configured domain', async () => {
    const { isSignupEmailAllowed } = await importGateWith('@corp.com');
    expect(isSignupEmailAllowed('dev@corp.com')).toBe(true);
  });

  it('blocks an address off the configured domain', async () => {
    const { isSignupEmailAllowed } = await importGateWith('@corp.com');
    expect(isSignupEmailAllowed('stranger@gmail.com')).toBe(false);
  });

  it('blocks a lookalike of the configured domain', async () => {
    const { isSignupEmailAllowed } = await importGateWith('@corp.com');
    expect(isSignupEmailAllowed('attacker@evil-corp.com')).toBe(false);
  });

  it('honours a multi-entry allowlist', async () => {
    const { isSignupEmailAllowed } = await importGateWith('@corp.com,contractor@partner.io');
    expect(isSignupEmailAllowed('contractor@partner.io')).toBe(true);
    expect(isSignupEmailAllowed('someone.else@partner.io')).toBe(false);
  });
});

describe('SIGNUP_NOT_ALLOWED_ERROR', () => {
  it('does not disclose the allowlist to whoever hit the gate', async () => {
    const { SIGNUP_NOT_ALLOWED_ERROR } = await importGateWith('@corp.com');
    expect(SIGNUP_NOT_ALLOWED_ERROR).not.toContain('corp.com');
    expect(SIGNUP_NOT_ALLOWED_ERROR).toBe(
      'Registration is not open on this deployment. Ask an administrator for an invitation.'
    );
  });
});
