/**
 * Tests: CLI Dev Key API Routes
 *
 * Tests API key creation, deletion, and refresh/rotation for CLI dev keys after
 * the Postgres key-store cutover. Minting now goes through
 * @repo/api-key-service's `mintApiKey` (row + digest, no Unkey); deletion is a
 * plain row delete whose cascading secret is the revocation.
 *
 * Covers authentication checks, validation, key-store minting, and DB operations.
 */

// ---------------------------------------------------------------------------
// Mock user data
// ---------------------------------------------------------------------------

const mockUser = {
  id: 'user-123',
  email: 'dev@example.com',
  app_metadata: { tenant_id: 'tenant-456' },
};

const mockUserNoTenant = {
  id: 'user-no-tenant',
  email: 'no-tenant@example.com',
  app_metadata: {},
};

const APP_UUID = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// Chainable Supabase mock builder
// ---------------------------------------------------------------------------

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, any> = {};
  // `maybeSingle` is needed by feature-054 `resolveDefaultEnvironmentId`.
  ['select', 'eq', 'single', 'maybeSingle', 'insert', 'delete'].forEach((m) => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  chain['then'] = (resolve: (v: typeof result) => void) => {
    resolve(result);
    return Promise.resolve(result);
  };
  return chain;
}

/**
 * `membership` is queried by TWO different call sites with different result
 * shapes: the route's own actor-lookup (`select('id')`, single row)
 * and `resolveCliTenant`'s sole-active-membership fallback
 * (`select('tenant_id')`, array). A single static chain can't serve both, so
 * this branches on which `select()` was requested.
 */
function makeMembershipChain(opts: {
  actorLookup?: { data: unknown; error: unknown };
  soleMembership?: { data: unknown; error: unknown };
}) {
  const actorLookup = opts.actorLookup ?? { data: { id: 'membership-test-1' }, error: null };
  const soleMembership =
    opts.soleMembership ?? { data: [{ tenant_id: 'tenant-456' }], error: null };
  let mode: 'actor' | 'sole' = 'sole';
  const chain: Record<string, any> = {};
  chain.select = vi.fn((cols: string) => {
    mode = cols === 'id' ? 'actor' : 'sole';
    return chain;
  });
  ['eq', 'neq', 'insert', 'delete', 'single', 'maybeSingle'].forEach((m) => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  chain.then = (resolve: (v: unknown) => void) => {
    const result = mode === 'actor' ? actorLookup : soleMembership;
    resolve(result);
    return Promise.resolve(result);
  };
  return chain;
}

/**
 * The create-dev-key route issues five table accesses — `app` lookup,
 * `tenant` org-name lookup, the feature-054 `environment` default-env
 * lookup (`resolveDefaultEnvironmentId`), the `membership` lookup
 * (actor-scoped keys), then the key-store mint (which owns the `api_key`
 * row insert internally — mocked here) — PLUS resolveCliTenant's own
 * `profile` + `membership` reads ahead of all of it. Route the `from(table)`
 * call by table name instead of positional call count. `tenant`,
 * `environment`, `profile`, and `membership` default to benign results
 * (no preference; a sole active membership in tenant-456) unless a test
 * overrides them.
 */
function makeTableDispatch(chains: {
  app: ReturnType<typeof makeChain>;
  api_key?: ReturnType<typeof makeChain>;
  tenant?: ReturnType<typeof makeChain>;
  environment?: ReturnType<typeof makeChain>;
  membership?: ReturnType<typeof makeMembershipChain>;
  profile?: ReturnType<typeof makeChain>;
}) {
  const tenant =
    chains.tenant ??
    makeChain({ data: { organization_name: 'Test Org' }, error: null });
  const environment =
    chains.environment ??
    makeChain({ data: { id: 'env-default-test' }, error: null });
  const membership = chains.membership ?? makeMembershipChain({});
  const profile =
    chains.profile ?? makeChain({ data: { last_active_tenant_id: null }, error: null });
  const apiKey = chains.api_key ?? makeChain({ data: null, error: null });
  return (table: string) => {
    if (table === 'app') return chains.app;
    if (table === 'tenant') return tenant;
    if (table === 'environment') return environment;
    if (table === 'membership') return membership;
    if (table === 'profile') return profile;
    if (table === 'api_key') return apiKey;
    throw new Error(`dev-key test: unexpected table access "${table}"`);
  };
}

/**
 * Wraps a fallback chain (used for the test's own business-logic table,
 * e.g. `api_key`) so resolveCliTenant's `profile`/`membership` reads still
 * resolve deterministically (default: no preference, sole membership in
 * tenant-456) regardless of what the fallback chain itself was built for.
 * `fallback` may be a function to preserve call-order-sensitive behavior
 * (e.g. DELETE's fetch-then-delete sequence) — table interception happens
 * first, so the fallback only ever sees the table it was written for.
 */
function withCliTenantDefaults(
  fallback: ReturnType<typeof makeChain> | ((table: string) => ReturnType<typeof makeChain>),
  overrides?: {
    profile?: ReturnType<typeof makeChain>;
    membership?: ReturnType<typeof makeMembershipChain>;
  },
) {
  const profile =
    overrides?.profile ?? makeChain({ data: { last_active_tenant_id: null }, error: null });
  const membership = overrides?.membership ?? makeMembershipChain({});
  return (table: string) => {
    if (table === 'profile') return profile;
    if (table === 'membership') return membership;
    return typeof fallback === 'function' ? fallback(table) : fallback;
  };
}

/** A `membership` override whose sole-membership query resolves empty — the
 * shape `resolveCliTenant` sees for a user with no active memberships. */
function noMembershipChain() {
  return makeMembershipChain({ soleMembership: { data: [], error: null } });
}

/**
 * Baseline `mockFrom` for a fresh test: resolveCliTenant's own reads resolve
 * to the default (no preference, sole membership in tenant-456), and any
 * OTHER table access throws loudly rather than silently reusing whatever a
 * PREVIOUS test happened to configure — `vi.clearAllMocks()` clears calls,
 * not implementations, so an unconfigured `mockFrom` would otherwise leak
 * the prior test's business-logic mock across test boundaries.
 */
function setDefaultCliTenantMock() {
  mockFrom.mockImplementation(
    withCliTenantDefaults((table) => {
      throw new Error(
        `dev-key test: unconfigured table access "${table}" — set mockFrom explicitly for this test`,
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Shared mock references
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

// The Postgres key-store mint. Returns a fresh plaintext + row (api_key_id).
// `vi.hoisted` lifts it above the auto-hoisted `vi.mock` factory that
// references it directly.
const mockMintApiKey = vi.hoisted(() => vi.fn());

// `serverLogger` is the contract the catch blocks MUST hit. Pinning the
// mock lets us assert "if the route returned 500 from the catch block,
// it logged the error with the correct route context" — the guard against
// a catch block silently swallowing the error.
const { mockLoggerError } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../auth-helper', () => ({
  createCliSupabaseClient: vi.fn((request: Request) => {
    const auth = request.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return null;
    return {
      auth: { getUser: mockGetUser },
      from: mockFrom,
    };
  }),
}));

vi.mock('@repo/api-key-service', () => ({ mintApiKey: mockMintApiKey }));

vi.mock('@/config-global.server', () => ({
  API_KEY_PEPPER: 'test-pepper',
  SUPABASE_SECRET_KEY: 'test-service-role-key',
  UNKEY_API_KEY: 'test-unkey-root-key',
}));

vi.mock('@/config-global', () => ({
  GATEWAY_URL: 'https://gateway.test.co',
  API_URL: 'https://api.test.co',
  // createSupabaseAdminClient (constructed as mintApiKey's adminClient arg)
  // reads these. mintApiKey is mocked, so the client is never used, but the
  // constructor still runs.
  SUPABASE_API: { url: 'http://localhost:54321', key: 'test-anon-key' },
}));

vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: {
    error: mockLoggerError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock NextResponse: supports both NextResponse.json() and new NextResponse()
vi.mock('next/server', async () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    constructor(body: unknown, init?: { status?: number }) {
      this._body = body;
      this.status = init?.status ?? 200;
    }
    async json() {
      if (this._body === null || this._body === undefined) return null;
      if (typeof this._body === 'string') return JSON.parse(this._body);
      return this._body;
    }
    static json(body: unknown, init?: { status?: number }) {
      const instance = new MockNextResponse(body, init);
      return instance;
    }
  }
  return { NextResponse: MockNextResponse };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { POST as createDevKey } from '../dev-key/route';
import { DELETE as deleteDevKey } from '../dev-key/[keyId]/route';
import { POST as refreshDevKey } from '../dev-key/[keyId]/refresh/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  method: string,
  body?: unknown,
  token?: string
): Request {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request('http://localhost/api/cli/dev-key', init);
}

function makeRouteContext(keyId: string) {
  return { params: Promise.resolve({ keyId }) };
}

/** The default successful mint result — set in each describe's beforeEach. */
function resetMintDefault() {
  mockMintApiKey.mockResolvedValue({
    plaintext: 'sk_outerlayer_dev_xyz',
    row: { id: 'uuid-d', api_key_id: 'key_d' },
  });
}

// ---------------------------------------------------------------------------
// Tests: POST /api/cli/dev-key (Create)
// ---------------------------------------------------------------------------

describe('POST /api/cli/dev-key (create)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultCliTenantMock();
    resetMintDefault();
  });

  it('should return 401 when Authorization header is missing', async () => {
    const request = new Request('http://localhost/api/cli/dev-key', {
      method: 'POST',
      body: JSON.stringify({ app_id: APP_UUID }),
    });
    const response = await createDevKey(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Missing Authorization header');
  });

  it('should return 401 when Bearer token is invalid', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token' },
    });
    const request = makeRequest('POST', { app_id: APP_UUID }, 'bad-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Not authenticated');
  });

  it('should return 403 when user has no tenant_id', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: mockUserNoTenant },
      error: null,
    });
    mockFrom.mockImplementation(withCliTenantDefaults(makeChain({ data: null, error: null }), {
      membership: noMembershipChain(),
    }));
    const request = makeRequest('POST', { app_id: APP_UUID }, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('No tenant associated with user');
  });

  it('should return 400 when JSON body is malformed', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const request = new Request('http://localhost/api/cli/dev-key', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
      body: 'not-json',
    });
    const response = await createDevKey(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  it('should return 400 when app_id is not a valid UUID', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const request = makeRequest('POST', { app_id: 'not-a-uuid' }, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('app_id must be a valid UUID');
  });

  it('should return 400 when app_id is missing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const request = makeRequest('POST', {}, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(400);
  });

  it('should return 400 when device_name contains invalid characters', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const request = makeRequest(
      'POST',
      { app_id: APP_UUID, device_name: '<script>alert(1)</script>' },
      'valid-token'
    );
    const response = await createDevKey(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid characters in device_name');
  });

  it('should return 403 when app is not found for the tenant', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(makeChain({ data: null, error: { code: 'OTHER', message: 'No rows' } })),
    );
    const request = makeRequest('POST', { app_id: APP_UUID }, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('App not found or access denied');
  });

  it('should return 404 when app query returns PGRST116', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(
        makeChain({ data: null, error: { code: 'PGRST116', message: 'Not found' } }),
      ),
    );
    const request = makeRequest('POST', { app_id: APP_UUID }, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(404);
  });

  it('should return 500 when the key-store mint fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const appChain = makeChain({
      data: { id: APP_UUID, name: 'My App', tenant_id: 'tenant-456' },
      error: null,
    });
    mockFrom.mockImplementation(makeTableDispatch({ app: appChain }));
    // mintApiKey rolls back internally on any failure and rethrows.
    mockMintApiKey.mockRejectedValueOnce(new Error('digest write failed'));

    const request = makeRequest('POST', { app_id: APP_UUID }, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to store API key');
  });

  it('should return 201 with key details on successful creation', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const appChain = makeChain({
      data: { id: APP_UUID, name: 'My App', tenant_id: 'tenant-456' },
      error: null,
    });
    mockFrom.mockImplementation(makeTableDispatch({ app: appChain }));

    const request = makeRequest(
      'POST',
      { app_id: APP_UUID, device_name: 'My Laptop' },
      'valid-token'
    );
    const response = await createDevKey(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        key: 'sk_outerlayer_dev_xyz',
        key_id: 'key_d',
        app_id: APP_UUID,
        app_name: 'My App',
        org_name: 'Test Org',
        tenant_id: 'tenant-456',
        base_url: 'https://api.test.co',
        scope: 'traces:write',
      })
    );
    // Dev keys expire 30 days out. Assert the ISO timestamp lands in that
    // window (no fake timers here, so check the contract, not an exact value).
    const expiresAt = new Date(body.expires_at).getTime();
    const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Number.isNaN(expiresAt)).toBe(false);
    expect(Math.abs(expiresAt - thirtyDaysFromNow)).toBeLessThan(60 * 1000);
  });

  it('mints with trace.write scope, dev prefix, and a 30-day expiry', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const appChain = makeChain({
      data: { id: APP_UUID, name: 'My App', tenant_id: 'tenant-456' },
      error: null,
    });
    mockFrom.mockImplementation(makeTableDispatch({ app: appChain }));

    const request = makeRequest(
      'POST',
      { app_id: APP_UUID, device_name: 'Work MacBook' },
      'valid-token'
    );
    await createDevKey(request);

    expect(mockMintApiKey).toHaveBeenCalledTimes(1);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-456',
        appId: APP_UUID,
        name: 'Work MacBook',
        environmentId: 'env-default-test',
        permissions: ['trace.write'],
        prefix: 'sk_outerlayer_dev_',
        expiresAt: expect.any(String),
        // 057 A6b actor-scoped keys: the caller's membership binds the key so
        // synced agent sessions attribute to the developer's seat.
        actorMembershipId: 'membership-test-1',
      })
    );
  });

  it('should generate default key name when device_name is omitted', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    const appChain = makeChain({
      data: { id: APP_UUID, name: 'My App', tenant_id: 'tenant-456' },
      error: null,
    });
    mockFrom.mockImplementation(makeTableDispatch({ app: appChain }));

    const request = makeRequest('POST', { app_id: APP_UUID }, 'valid-token');
    await createDevKey(request);

    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('CLI Dev Key - '),
      })
    );
  });

  it('should return 500 when an unexpected error is thrown', async () => {
    mockGetUser.mockRejectedValue(new Error('Unexpected crash'));
    const request = makeRequest('POST', { app_id: APP_UUID }, 'valid-token');
    const response = await createDevKey(request);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
    // Catch-block contract: the error MUST be logged with a route-scoped
    // context tag so observability can trace it back to this handler.
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: '[CLI API] POST /api/cli/dev-key failed',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/cli/dev-key/:keyId
// ---------------------------------------------------------------------------

describe('DELETE /api/cli/dev-key/:keyId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultCliTenantMock();
  });

  it('should return 401 when Authorization header is missing', async () => {
    const request = new Request('http://localhost/api/cli/dev-key/key-1', { method: 'DELETE' });
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Missing Authorization header');
  });

  it('should return 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Expired token' },
    });
    const request = makeRequest('DELETE', undefined, 'expired-token');
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Not authenticated');
  });

  it('should return 403 when user has no tenant_id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUserNoTenant }, error: null });
    mockFrom.mockImplementation(withCliTenantDefaults(makeChain({ data: null, error: null }), {
      membership: noMembershipChain(),
    }));
    const request = makeRequest('DELETE', undefined, 'valid-token');
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('No tenant associated with user');
  });

  it('should return 404 when key does not belong to tenant', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(makeChain({ data: null, error: { message: 'Not found' } })),
    );
    const request = makeRequest('DELETE', undefined, 'valid-token');
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('API key not found or access denied');
  });

  it('should return 500 when DB delete fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

    // First call: key lookup succeeds
    const fetchChain = makeChain({
      data: { api_key_id: 'key-1', tenant_id: 'tenant-456' },
      error: null,
    });
    // Second call: delete fails
    const deleteChain = makeChain({ data: null, error: { message: 'DB error' } });

    let callCount = 0;
    mockFrom.mockImplementation(
      withCliTenantDefaults((_table) => {
        callCount++;
        return callCount === 1 ? fetchChain : deleteChain;
      }),
    );

    const request = makeRequest('DELETE', undefined, 'valid-token');
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('Failed to delete API key');
  });

  it('deletes the api_key row keyed by api_key_id + tenant_id and returns 204', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

    // First call: key lookup succeeds
    const fetchChain = makeChain({
      data: { api_key_id: 'key-1', tenant_id: 'tenant-456' },
      error: null,
    });
    // Second call: delete succeeds
    const deleteChain = makeChain({ data: null, error: null });

    let callCount = 0;
    mockFrom.mockImplementation(
      withCliTenantDefaults((_table) => {
        callCount++;
        return callCount === 1 ? fetchChain : deleteChain;
      }),
    );

    const request = makeRequest('DELETE', undefined, 'valid-token');
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(204);

    // Deletion IS revocation (the private digest cascades) — the row delete is
    // scoped to the key AND the tenant, with no external provider call.
    expect(deleteChain.delete).toHaveBeenCalledTimes(1);
    expect(deleteChain.eq).toHaveBeenCalledWith('api_key_id', 'key-1');
    expect(deleteChain.eq).toHaveBeenCalledWith('tenant_id', 'tenant-456');
  });

  it('should return 500 when an unexpected error is thrown', async () => {
    mockGetUser.mockRejectedValue(new Error('Unexpected crash'));
    const request = makeRequest('DELETE', undefined, 'valid-token');
    const response = await deleteDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: '[CLI API] DELETE /api/cli/dev-key/:keyId failed',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/cli/dev-key/:keyId/refresh
// ---------------------------------------------------------------------------

describe('POST /api/cli/dev-key/:keyId/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaultCliTenantMock();
    resetMintDefault();
  });

  it('should return 401 when Authorization header is missing', async () => {
    const request = new Request('http://localhost/api/cli/dev-key/key-1/refresh', {
      method: 'POST',
    });
    const response = await refreshDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Missing Authorization header');
  });

  it('should return 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Token expired' },
    });
    const request = makeRequest('POST', undefined, 'expired-token');
    const response = await refreshDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Not authenticated');
  });

  it('should return 403 when user has no tenant_id', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUserNoTenant }, error: null });
    mockFrom.mockImplementation(withCliTenantDefaults(makeChain({ data: null, error: null }), {
      membership: noMembershipChain(),
    }));
    const request = makeRequest('POST', undefined, 'valid-token');
    const response = await refreshDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(403);
  });

  it('should return 404 when key does not belong to tenant', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(makeChain({ data: null, error: { message: 'Not found' } })),
    );
    const request = makeRequest('POST', undefined, 'valid-token');
    const response = await refreshDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('API key not found or access denied');
  });

  it('should return 500 when the key-store re-mint fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(
        makeChain({
          data: {
            api_key_id: 'old-key-1',
            name: 'My Key',
            app_id: 'app-1',
            tenant_id: 'tenant-456',
            environment_id: 'env-7',
          },
          error: null,
        }),
      ),
    );
    // replaceExisting delete or the re-insert failed inside mintApiKey.
    mockMintApiKey.mockRejectedValueOnce(new Error('replace failed'));

    const request = makeRequest('POST', undefined, 'valid-token');
    const response = await refreshDevKey(request, makeRouteContext('old-key-1'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to refresh API key');
  });

  it('should return new key details on successful refresh', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(
        makeChain({
          data: {
            api_key_id: 'old-key-1',
            name: 'My Key',
            app_id: 'app-1',
            tenant_id: 'tenant-456',
            environment_id: 'env-7',
          },
          error: null,
        }),
      ),
    );

    const request = makeRequest('POST', undefined, 'valid-token');
    const response = await refreshDevKey(request, makeRouteContext('old-key-1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        key: 'sk_outerlayer_dev_xyz',
        key_id: 'key_d',
      })
    );
    // Refreshed dev keys also expire 30 days out.
    const expiresAt = new Date(body.expires_at).getTime();
    const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Number.isNaN(expiresAt)).toBe(false);
    expect(Math.abs(expiresAt - thirtyDaysFromNow)).toBeLessThan(60 * 1000);
  });

  it('re-mints in place (replaceExisting) preserving the key name, app, and env', async () => {
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockFrom.mockImplementation(
      withCliTenantDefaults(
        makeChain({
          data: {
            api_key_id: 'old-key-1',
            name: 'Original Name',
            app_id: 'app-42',
            tenant_id: 'tenant-456',
            environment_id: 'env-7',
          },
          error: null,
        }),
      ),
    );

    const request = makeRequest('POST', undefined, 'valid-token');
    await refreshDevKey(request, makeRouteContext('old-key-1'));

    expect(mockMintApiKey).toHaveBeenCalledTimes(1);
    expect(mockMintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-456',
        appId: 'app-42',
        name: 'Original Name',
        environmentId: 'env-7',
        permissions: ['trace.write'],
        prefix: 'sk_outerlayer_dev_',
        replaceExisting: true,
        expiresAt: expect.any(String),
      })
    );
  });

  it('should return 500 when an unexpected error is thrown', async () => {
    mockGetUser.mockRejectedValue(new Error('Unexpected crash'));
    const request = makeRequest('POST', undefined, 'valid-token');
    const response = await refreshDevKey(request, makeRouteContext('key-1'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: '[CLI API] POST /api/cli/dev-key/:keyId/refresh failed',
      }),
    );
  });
});
