/**
 * `withApi` auth path: `authenticateRequest` resolves the session, the
 * request tenant, and the app-access check the same way `withAnalyticsAuth`
 * does (it is lifted from there) — this pins that the wrapper still reaches a
 * verified `TenantContext` end to end, over the real Supabase client (MSW),
 * not a mocked `verifyAppAccess`.
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

const headersGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock('next/headers', () => ({
  cookies: () => getSupabaseTestCookieStore(),
  headers: () => ({ get: headersGet }),
}));

import { z } from 'zod';
import { getSupabaseTestCookieStore } from '@/test-helpers/supabase-session';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';
import { seedSupabaseAuth, seedSupabaseMswState } from '@/test-helpers/msw-handlers';
import { createMswRestClient } from '@/test-helpers/rest-client';
import { mintManagementApiKeySystem } from '@/lib/system/management-api-key-service';
import { withApi, type ApiRouteSchema } from '../with-api';

const validUser = {
  ...mockUser,
  id: 'user-123',
  app_metadata: { ...mockUser.app_metadata, tenant_id: 'tenant-456' },
};

const SCHEMA: ApiRouteSchema = {
  method: 'get',
  path: '/api/with-api-test',
  tags: ['test'],
  summary: 'test route',
  operationId: 'withApiTestRoute',
  responses: { 200: { description: 'ok' } },
};

function createRequest(appId?: string, headers?: Record<string, string>) {
  const url = appId
    ? `http://localhost/api/with-api-test?appId=${appId}`
    : 'http://localhost/api/with-api-test';
  return new Request(url, headers ? { headers } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNextResponseJson.mockClear();
  headersGet.mockReturnValue(null);
});

describe('withApi auth (authenticateRequest → verifyAppAccess over the real Supabase client)', () => {
  it('reaches the handler with a verified TenantContext on a valid session + owned app', async () => {
    headersGet.mockReturnValue('tenant-456');
    seedSupabaseAuth({ user: validUser });
    seedSupabaseMswState({
      apps: [{ id: 'app-789', tenant_id: 'tenant-456' }],
      tenantEntitlementOverrides: [
        {
          id: 'override-1',
          tenant_id: 'tenant-456',
          entitlement_key: 'data_retention_days',
          value: { v: 30 },
        },
      ],
    });

    const handler = vi.fn().mockResolvedValue({ ok: true });
    const route = withApi(SCHEMA, handler);

    const response = await route(createRequest('app-789'));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          userId: 'user-123',
          tenantId: 'tenant-456',
          appId: 'app-789',
          dataRetentionDays: 30,
        }),
      }),
    );
  });

  it('returns 403 without calling the handler when the app belongs to a different tenant', async () => {
    headersGet.mockReturnValue('tenant-456');
    seedSupabaseAuth({ user: validUser });
    seedSupabaseMswState({ apps: [{ id: 'app-789', tenant_id: 'other-tenant' }] });

    const handler = vi.fn();
    const route = withApi(SCHEMA, handler);

    const response = await route(createRequest('app-789'));

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips auth entirely when the schema opts out (authRequired: false)', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const route = withApi({ ...SCHEMA, authRequired: false }, handler);

    const response = await route(createRequest());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ context: null }));
  });
});

describe('withApi auth (management API key bearer branch)', () => {
  it('reaches the handler with a verified TenantContext on a valid, unrevoked bearer key + owned app', async () => {
    const db = createMswRestClient();
    const { plaintext, row } = await mintManagementApiKeySystem({
      rowClient: db,
      tenantId: 'tenant-456',
      name: 'automation key',
      permissions: ['membership.read'],
      expiresAt: null,
      createdBy: 'user-1',
    });
    seedSupabaseMswState({
      apps: [{ id: 'app-789', tenant_id: 'tenant-456' }],
      tenantEntitlementOverrides: [
        {
          id: 'override-1',
          tenant_id: 'tenant-456',
          entitlement_key: 'data_retention_days',
          value: { v: 30 },
        },
      ],
    });

    const handler = vi.fn().mockResolvedValue({ ok: true });
    const route = withApi(SCHEMA, handler);

    const response = await route(
      createRequest('app-789', { authorization: `Bearer ${plaintext}` }),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          userId: `management_api_key:${row.id}`,
          tenantId: 'tenant-456',
          appId: 'app-789',
          dataRetentionDays: 30,
        }),
      }),
    );
  });

  it('returns 401 without calling the handler for an unknown/malformed bearer key, never falling through to session auth', async () => {
    // A valid SESSION is seeded too — if the bearer branch silently fell
    // through on failure, this would incorrectly succeed as a session-authed
    // request instead of failing closed on the bad bearer token.
    headersGet.mockReturnValue('tenant-456');
    seedSupabaseAuth({ user: validUser });
    seedSupabaseMswState({ apps: [{ id: 'app-789', tenant_id: 'tenant-456' }] });

    const handler = vi.fn();
    const route = withApi(SCHEMA, handler);

    const response = await route(
      createRequest('app-789', { authorization: 'Bearer olk_doesnotexist' }),
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 without calling the handler when the bearer key\'s app belongs to a different tenant', async () => {
    const db = createMswRestClient();
    const { plaintext } = await mintManagementApiKeySystem({
      rowClient: db,
      tenantId: 'tenant-456',
      name: 'automation key',
      permissions: [],
      expiresAt: null,
      createdBy: 'user-1',
    });
    seedSupabaseMswState({ apps: [{ id: 'app-789', tenant_id: 'other-tenant' }] });

    const handler = vi.fn();
    const route = withApi(SCHEMA, handler);

    const response = await route(
      createRequest('app-789', { authorization: `Bearer ${plaintext}` }),
    );

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 without calling the handler when a valid bearer key omits the appId query param', async () => {
    const db = createMswRestClient();
    const { plaintext } = await mintManagementApiKeySystem({
      rowClient: db,
      tenantId: 'tenant-456',
      name: 'automation key',
      permissions: [],
      expiresAt: null,
      createdBy: 'user-1',
    });

    const handler = vi.fn();
    const route = withApi(SCHEMA, handler);

    const response = await route(createRequest(undefined, { authorization: `Bearer ${plaintext}` }));

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('withApi input validation', () => {
  it('parses a query schema and hands the parsed value to the handler', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const route = withApi(
      {
        ...SCHEMA,
        authRequired: false,
        request: { query: z.object({ limit: z.coerce.number() }) },
      },
      handler,
    );

    await route(new Request('http://localhost/api/with-api-test?limit=5'));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ query: { limit: 5 } }) }),
    );
  });
});
