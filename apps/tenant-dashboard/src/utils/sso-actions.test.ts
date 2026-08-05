/**
 * Unit tests for the OPEN login-flow SSO guards in sso-actions.ts:
 * checkDomainSSO + validatePasswordLoginAllowed. These must work on
 * unlicensed self-hosted instances (core auth), which is why they stay
 * outside ee/, unlike the SSO configuration actions — those are EE and are
 * tested in ee/features/sso/actions.test.ts.
 *
 * The domain lookup is mocked at the owned-module seam
 * (@/lib/auth/sso-domain-check); no Supabase query builders are stubbed.
 */

import { checkDomainSSOStatus } from '@/lib/auth/sso-domain-check';
import { checkDomainSSO, validatePasswordLoginAllowed } from './sso-actions';

vi.mock('@/lib/auth/sso-domain-check', () => ({
  checkDomainSSOStatus: vi.fn(),
}));

const checkDomainSSOStatusMock = vi.mocked(checkDomainSSOStatus);

beforeEach(() => {
  checkDomainSSOStatusMock.mockReset();
});

describe('checkDomainSSO', () => {
  it('should return hasSso=false without a lookup when email has no @ sign', async () => {
    const result = await checkDomainSSO('notanemail');

    expect(result).toEqual({ hasSso: false, enforced: false });
    expect(checkDomainSSOStatusMock).not.toHaveBeenCalled();
  });

  it('should return hasSso=false without a lookup when email is empty', async () => {
    const result = await checkDomainSSO('');

    expect(result).toEqual({ hasSso: false, enforced: false });
    expect(checkDomainSSOStatusMock).not.toHaveBeenCalled();
  });

  it('should delegate to the domain check with the extracted domain', async () => {
    checkDomainSSOStatusMock.mockResolvedValue({ hasSso: true, enforced: true });

    const result = await checkDomainSSO('alice@example.com');

    expect(checkDomainSSOStatusMock).toHaveBeenCalledWith(expect.anything(), 'example.com');
    expect(result).toEqual({ hasSso: true, enforced: true });
  });

  it('should return the safe default with an error message when the lookup throws', async () => {
    checkDomainSSOStatusMock.mockRejectedValue(new Error('DB query failed'));

    const result = await checkDomainSSO('alice@example.com');

    expect(result).toEqual({
      hasSso: false,
      enforced: false,
      error: 'Unable to check SSO status',
    });
  });
});

describe('validatePasswordLoginAllowed', () => {
  it('should block password login when the domain enforces SSO', async () => {
    checkDomainSSOStatusMock.mockResolvedValue({ hasSso: true, enforced: true });

    const result = await validatePasswordLoginAllowed('alice@example.com');

    expect(result).toEqual({
      allowed: false,
      error:
        'Your organization requires SSO authentication. Password-based login is not permitted.',
    });
    expect(checkDomainSSOStatusMock).toHaveBeenCalledWith(expect.anything(), 'example.com');
  });

  it('should allow password login when the domain has SSO but not enforced', async () => {
    checkDomainSSOStatusMock.mockResolvedValue({ hasSso: true, enforced: false });

    expect(await validatePasswordLoginAllowed('alice@example.com')).toEqual({ allowed: true });
  });

  it('should allow password login without a lookup when the email has no domain', async () => {
    expect(await validatePasswordLoginAllowed('notanemail')).toEqual({ allowed: true });
    expect(checkDomainSSOStatusMock).not.toHaveBeenCalled();
  });

  it('should fail open with a warning when the enforcement check itself errors', async () => {
    checkDomainSSOStatusMock.mockRejectedValue(new Error('boom'));

    expect(await validatePasswordLoginAllowed('alice@example.com')).toEqual({
      allowed: true,
      error: 'SSO enforcement check is temporarily unavailable.',
    });
  });
});
