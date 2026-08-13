/**
 * `rejectAdminApiKeyBearer` — the session-only guard the custom-roles and
 * per-app member-roles route shims call before invoking their delegated EE
 * action, so a bearer caller gets a typed 401 instead of the wrapper's
 * catch-all mapping an untyped "Not authenticated" throw to a 500.
 */

vi.mock('server-only', () => ({}));

import { AnalyticsError } from '@repo/observability-service';
import { rejectAdminApiKeyBearer } from '../reject-admin-api-key-bearer';

function requestWithAuth(authorization?: string): Request {
  return new Request('http://localhost/api/orgs/acme/custom-roles', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('rejectAdminApiKeyBearer', () => {
  it('throws a typed 401 for an olk_ bearer request', () => {
    expect(() => rejectAdminApiKeyBearer(requestWithAuth('Bearer olk_somekey'))).toThrow(AnalyticsError);
    try {
      rejectAdminApiKeyBearer(requestWithAuth('Bearer olk_somekey'));
      throw new Error('expected rejectAdminApiKeyBearer to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsError);
      expect((error as AnalyticsError).statusCode).toBe(401);
      expect((error as AnalyticsError).code).toBe('unauthorized');
      expect((error as AnalyticsError).message).toBe(
        'Admin API keys are not supported on this endpoint; use a browser session',
      );
    }
  });

  it('returns without throwing when no Authorization header is present', () => {
    expect(rejectAdminApiKeyBearer(requestWithAuth())).toBeUndefined();
  });

  it('returns without throwing for a session request (no bearer scheme at all)', () => {
    expect(rejectAdminApiKeyBearer(requestWithAuth(undefined))).toBeUndefined();
  });

  it('returns without throwing for a Bearer token that is not an admin API key (wrong prefix)', () => {
    expect(rejectAdminApiKeyBearer(requestWithAuth('Bearer sk_outerlayer_notanadminkey'))).toBeUndefined();
  });
});
