/**
 * withAnalyticsAuth() Wrapper Tests
 *
 * Test names follow "should [outcome] when [condition]".
 */

vi.mock('server-only', () => ({}));

const mockNextResponseJson = vi.fn();
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => {
      mockNextResponseJson(data, init);
      return {
        status: init?.status || 200,
        json: () => Promise.resolve(data),
        headers: new Headers(init?.headers),
      };
    },
  },
}));

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { error: vi.fn() },
}));

// The middleware forwards the URL-derived tenant as x-tenant-id; default to
// absent so the un-moved-route tests exercise the claim fallback. Overrides the
// global next/headers mock, keeping its cookie store so the Supabase server
// client still authenticates.
const headersGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { getSupabaseTestCookieStore } from '@/test-helpers/supabase-session';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';
import {
  seedSupabaseAuth,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';
import {
  withAnalyticsAuth,
  withAnalyticsAuthParams,
  type AuthenticatedHandler,
  type AuthenticatedHandlerWithParams,
} from '../with-auth';
import type { TenantContext } from '@/lib/analytics/tenant-context';

const validUser = {
  ...mockUser,
  id: 'user-123',
  app_metadata: {
    ...mockUser.app_metadata,
    tenant_id: 'tenant-456',
  },
};

function createRequest(appId?: string) {
  const url = appId
    ? `http://localhost/api/analytics/metrics?appId=${appId}`
    : 'http://localhost/api/analytics/metrics';

  return new Request(url);
}

function seedAuthorizedAnalyticsRequest(appId = 'app-789') {
  seedSupabaseAuth({ user: validUser });
  seedSupabaseMswState({
    apps: [{ id: appId, tenant_id: 'tenant-456' }],
    tenantEntitlementOverrides: [
      {
        id: 'override-1',
        tenant_id: 'tenant-456',
        entitlement_key: 'data_retention_days',
        value: { v: 30 },
      },
    ],
  });
}

describe('withAnalyticsAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNextResponseJson.mockClear();
    headersGet.mockReturnValue(null);
  });

  describe('successful authentication', () => {
    beforeEach(() => {
      headersGet.mockReturnValue('tenant-456');
      seedAuthorizedAnalyticsRequest();
    });

    it('should call handler with verified TenantContext', async () => {
      const mockHandler: AuthenticatedHandler = vi.fn().mockResolvedValue(
        { json: () => Promise.resolve({ success: true }), status: 200 } as Response,
      );
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      await wrappedHandler(request);

      expect(mockHandler).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          userId: 'user-123',
          tenantId: 'tenant-456',
          appId: 'app-789',
        }),
      );
    });

    it('should return handler response on success', async () => {
      const mockHandler: AuthenticatedHandler = vi.fn().mockResolvedValue(
        { json: () => Promise.resolve({ data: 'test' }), status: 200 } as Response,
      );
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(200);
    });

    it('should pass frozen TenantContext to handler', async () => {
      let capturedContext: TenantContext | null = null;
      const mockHandler: AuthenticatedHandler = vi.fn().mockImplementation((_, ctx) => {
        capturedContext = ctx;
        return Promise.resolve({ json: () => Promise.resolve({}), status: 200 } as Response);
      });
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      await wrappedHandler(request);

      expect(capturedContext).not.toBeNull();
      expect(Object.isFrozen(capturedContext)).toBe(true);
    });
  });

  describe('request-tenant source (URL-derived tenant only, no claim fallback)', () => {
    it('uses the URL-derived request tenant, ignoring a different claim', async () => {
      // Claim says tenant-456; the middleware derived tenant-req from the URL.
      // The app belongs to tenant-req, so the context must carry tenant-req.
      headersGet.mockReturnValue('tenant-req');
      seedSupabaseAuth({ user: validUser });
      seedSupabaseMswState({
        apps: [{ id: 'app-req', tenant_id: 'tenant-req' }],
        tenantEntitlementOverrides: [
          {
            id: 'override-req',
            tenant_id: 'tenant-req',
            entitlement_key: 'data_retention_days',
            value: { v: 30 },
          },
        ],
      });

      let capturedContext: TenantContext | null = null;
      const mockHandler: AuthenticatedHandler = vi.fn().mockImplementation((_, ctx) => {
        capturedContext = ctx;
        return Promise.resolve({ json: () => Promise.resolve({}), status: 200 } as Response);
      });

      await withAnalyticsAuth(mockHandler)(createRequest('app-req'));

      expect(capturedContext).toEqual(
        expect.objectContaining({ tenantId: 'tenant-req', appId: 'app-req' }),
      );
    });

    it('denies (403) when no request-tenant header is present, even though the claim names a tenant with a matching app', async () => {
      // Default headersGet → null; the un-moved route sees no x-tenant-id.
      seedAuthorizedAnalyticsRequest();

      const mockHandler: AuthenticatedHandler = vi.fn();
      const response = await withAnalyticsAuth(mockHandler)(createRequest('app-789'));

      expect(response.status).toBe(403);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('denies (403) when the request tenant does not own the app', async () => {
      // Header names a tenant the app does not belong to (the app is the
      // claim tenant's). verifyAppAccess runs under the request tenant, finds
      // no matching app row, and denies — the claim cannot rescue it.
      headersGet.mockReturnValue('tenant-spoof');
      seedSupabaseAuth({ user: validUser });
      seedSupabaseMswState({
        apps: [{ id: 'app-789', tenant_id: 'tenant-456' }],
      });

      const mockHandler: AuthenticatedHandler = vi.fn();
      const response = await withAnalyticsAuth(mockHandler)(createRequest('app-789'));

      expect(response.status).toBe(403);
      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe('authentication failures', () => {
    it('should return 401 when user is not authenticated', async () => {
      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(401);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should return 403 when user has no tenant_id', async () => {
      seedSupabaseAuth({
        user: {
          ...validUser,
          app_metadata: {
            ...validUser.app_metadata,
            tenant_id: undefined,
          },
        },
      });

      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should return 400 when appId is missing', async () => {
      headersGet.mockReturnValue('tenant-456');
      seedSupabaseAuth({ user: validUser });
      seedSupabaseMswState({
        tenantEntitlementOverrides: [
          {
            id: 'override-1',
            tenant_id: 'tenant-456',
            entitlement_key: 'data_retention_days',
            value: { v: 30 },
          },
        ],
      });

      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest();

      const response = await wrappedHandler(request);

      expect(response.status).toBe(400);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should return 403 when app belongs to different tenant', async () => {
      headersGet.mockReturnValue('tenant-456');
      seedSupabaseAuth({ user: validUser });
      seedSupabaseMswState({
        apps: [{ id: 'other-tenant-app', tenant_id: 'tenant-999' }],
        tenantEntitlementOverrides: [
          {
            id: 'override-1',
            tenant_id: 'tenant-456',
            entitlement_key: 'data_retention_days',
            value: { v: 30 },
          },
        ],
      });

      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('other-tenant-app');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe('error responses', () => {
    it('should include error code in 401 response', async () => {
      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      await wrappedHandler(request);

      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
        expect.objectContaining({ status: 401 }),
      );
    });

    it('should include error code in 403 response', async () => {
      headersGet.mockReturnValue('tenant-456');
      seedSupabaseAuth({ user: validUser });
      seedSupabaseMswState({
        apps: [{ id: 'other-app', tenant_id: 'tenant-999' }],
        tenantEntitlementOverrides: [
          {
            id: 'override-1',
            tenant_id: 'tenant-456',
            entitlement_key: 'data_retention_days',
            value: { v: 30 },
          },
        ],
      });

      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('other-app');

      await wrappedHandler(request);

      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'FORBIDDEN' }),
        expect.objectContaining({ status: 403 }),
      );
    });

    it('should include error code in 400 response', async () => {
      headersGet.mockReturnValue('tenant-456');
      seedSupabaseAuth({ user: validUser });
      seedSupabaseMswState({
        tenantEntitlementOverrides: [
          {
            id: 'override-1',
            tenant_id: 'tenant-456',
            entitlement_key: 'data_retention_days',
            value: { v: 30 },
          },
        ],
      });

      const mockHandler: AuthenticatedHandler = vi.fn();
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest();

      await wrappedHandler(request);

      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        expect.objectContaining({ status: 400 }),
      );
    });
  });

  describe('handler error handling', () => {
    beforeEach(() => {
      headersGet.mockReturnValue('tenant-456');
      seedAuthorizedAnalyticsRequest();
    });

    it('should return 500 when handler throws unexpected error', async () => {
      const mockHandler: AuthenticatedHandler = vi.fn().mockRejectedValue(
        new Error('Unexpected database error'),
      );
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(500);
    });

    it('should not leak internal error details in response', async () => {
      const mockHandler: AuthenticatedHandler = vi.fn().mockRejectedValue(
        new Error('SECRET_DATABASE_PASSWORD exposed'),
      );
      const wrappedHandler = withAnalyticsAuth(mockHandler);
      const request = createRequest('app-789');

      await wrappedHandler(request);

      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.not.objectContaining({ error: expect.stringContaining('SECRET') }),
        expect.any(Object),
      );
    });
  });

  describe('TypeScript type safety', () => {
    it('should enforce handler signature with TenantContext', () => {
      const handler: AuthenticatedHandler = async (_request, context) => {
        const { appId, tenantId, userId } = context;
        expect(typeof appId).toBe('string');
        expect(typeof tenantId).toBe('string');
        expect(typeof userId).toBe('string');
        return { json: () => Promise.resolve({}), status: 200 } as Response;
      };

      expect(typeof handler).toBe('function');
    });
  });
});

describe('withAnalyticsAuthParams (request-tenant flip)', () => {
  const params = { params: Promise.resolve({ id: 'trace-1' }) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockNextResponseJson.mockClear();
    headersGet.mockReturnValue(null);
  });

  it('prefers the URL-derived request tenant over the claim and forwards the route params', async () => {
    headersGet.mockReturnValue('tenant-req');
    seedSupabaseAuth({ user: validUser });
    seedSupabaseMswState({
      apps: [{ id: 'app-req', tenant_id: 'tenant-req' }],
      tenantEntitlementOverrides: [
        {
          id: 'override-req',
          tenant_id: 'tenant-req',
          entitlement_key: 'data_retention_days',
          value: { v: 30 },
        },
      ],
    });

    let capturedContext: TenantContext | null = null;
    let capturedParams: { id: string } | null = null;
    const handler: AuthenticatedHandlerWithParams<{ id: string }> = vi
      .fn()
      .mockImplementation((_req, ctx, p) => {
        capturedContext = ctx;
        capturedParams = p;
        return Promise.resolve({ json: () => Promise.resolve({}), status: 200 } as Response);
      });

    await withAnalyticsAuthParams(handler)(createRequest('app-req'), params);

    expect(capturedContext).toEqual(
      expect.objectContaining({ tenantId: 'tenant-req', appId: 'app-req' }),
    );
    expect(capturedParams).toEqual({ id: 'trace-1' });
  });

  it('denies (403) a request tenant the caller is not a member of, without calling the handler', async () => {
    headersGet.mockReturnValue('tenant-spoof');
    seedSupabaseAuth({ user: validUser });
    seedSupabaseMswState({ apps: [{ id: 'app-789', tenant_id: 'tenant-456' }] });

    const handler: AuthenticatedHandlerWithParams<{ id: string }> = vi.fn();
    const response = await withAnalyticsAuthParams(handler)(createRequest('app-789'), params);

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});
