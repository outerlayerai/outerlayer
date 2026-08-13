/**
 * `rejectManagementApiKeyBearer` — the session-only guard the custom-roles and
 * per-app member-roles route shims call before invoking their delegated EE
 * action, so a bearer caller gets a typed 401 instead of the wrapper's
 * catch-all mapping an untyped "Not authenticated" throw to a 500.
 */

vi.mock('server-only', () => ({}));

import { AnalyticsError } from '@repo/observability-service';
import { rejectManagementApiKeyBearer } from '../reject-management-api-key-bearer';

function requestWithAuth(authorization?: string): Request {
  return new Request('http://localhost/api/orgs/acme/custom-roles', {
    headers: authorization ? { authorization } : undefined,
  });
}

describe('rejectManagementApiKeyBearer', () => {
  it('throws a typed 401 for an olk_ bearer request', () => {
    expect(() => rejectManagementApiKeyBearer(requestWithAuth('Bearer olk_somekey'))).toThrow(AnalyticsError);
    try {
      rejectManagementApiKeyBearer(requestWithAuth('Bearer olk_somekey'));
      throw new Error('expected rejectManagementApiKeyBearer to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsError);
      expect((error as AnalyticsError).statusCode).toBe(401);
      expect((error as AnalyticsError).code).toBe('unauthorized');
      expect((error as AnalyticsError).message).toBe(
        'Management API keys are not supported on this endpoint; use a browser session',
      );
    }
  });

  it('returns without throwing when no Authorization header is present', () => {
    expect(rejectManagementApiKeyBearer(requestWithAuth())).toBeUndefined();
  });

  it('returns without throwing for a session request (no bearer scheme at all)', () => {
    expect(rejectManagementApiKeyBearer(requestWithAuth(undefined))).toBeUndefined();
  });

  it('returns without throwing for a Bearer token that is not an management API key (wrong prefix)', () => {
    expect(rejectManagementApiKeyBearer(requestWithAuth('Bearer sk_outerlayer_notanadminkey'))).toBeUndefined();
  });
});
