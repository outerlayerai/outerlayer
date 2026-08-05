/**
 * email-error-mapper - Tests against real Supabase AuthApiError
 */
import { AuthApiError } from '@supabase/supabase-js';
import { getEmailChangeErrorCode } from '../email-error-mapper';

describe('getEmailChangeErrorCode', () => {
  it('detects error code from real AuthApiError', () => {
    const emailExists = new AuthApiError('Email taken', 422, 'email_exists');
    const ssoManaged = new AuthApiError('SSO user', 403, 'user_sso_managed');

    expect(getEmailChangeErrorCode(emailExists)).toBe('email_exists');
    expect(getEmailChangeErrorCode(ssoManaged)).toBe('user_sso_managed');
  });

  it('falls back to message detection when code missing', () => {
    const error = new AuthApiError('rate limit exceeded', 429, undefined as unknown as string);
    expect(getEmailChangeErrorCode(error)).toBe('over_request_rate_limit');
  });

  it('returns unknown for unrecognized errors', () => {
    const error = new AuthApiError('Something weird', 500, 'unexpected_failure');
    expect(getEmailChangeErrorCode(error)).toBe('unknown');
    expect(getEmailChangeErrorCode(null)).toBe('unknown');
  });
});
