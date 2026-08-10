import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock verify-bearer BEFORE importing permissions so the hoisted
// vi.mock picks up the hoisted mockCheckBearerPermission ref.
// checkBearerPermission is swapped per-test to simulate app_authorize
// true/false responses.
const { mockCheckBearerPermission } = vi.hoisted(() => ({
  mockCheckBearerPermission: vi.fn(),
}));
vi.mock('../verify-bearer', () => ({
  checkBearerPermission: mockCheckBearerPermission,
}));

import {
  GATEWAY_PERMISSIONS,
  ROLE_PERMISSION_SETS,
  setRoutePermission,
  getRoutePermission,
  _resetRoutePermissions,
  checkPermission,
  permissionMiddleware,
} from '../permissions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: {
  user?: {
    permissions?: string[];
    tenantId?: string;
    appId?: string;
    authMode?: 'apikey' | 'bearer';
    userJwt?: string;
  } | null;
  method?: string;
  routePath?: string;
  env?: Record<string, unknown>;
}) {
  const jsonSpy = vi.fn((body: unknown, status?: number) =>
    new Response(JSON.stringify(body), { status: status ?? 200 }),
  );
  return {
    c: {
      get: vi.fn((key: string) => (key === 'user' ? overrides.user : undefined)),
      req: {
        method: overrides.method ?? 'GET',
        routePath: overrides.routePath ?? '/v1/traces', // kept for compat
        path: overrides.routePath ?? '/v1/traces',      // used by permissionMiddleware
      },
      env: overrides.env ?? {},
      json: jsonSpy,
    } as any,
    next: vi.fn().mockResolvedValue(undefined),
    jsonSpy,
  };
}

// ---------------------------------------------------------------------------
// GATEWAY_PERMISSIONS
// ---------------------------------------------------------------------------

describe('GATEWAY_PERMISSIONS', () => {
  it('should contain all expected permission strings', () => {
    expect(GATEWAY_PERMISSIONS).toContain('trace.write');
    expect(GATEWAY_PERMISSIONS).toContain('trace.read');
    expect(GATEWAY_PERMISSIONS).toContain('score.write');
    expect(GATEWAY_PERMISSIONS).toContain('score.read');
    expect(GATEWAY_PERMISSIONS).toContain('score.delete');
    expect(GATEWAY_PERMISSIONS).toContain('span.read');
    expect(GATEWAY_PERMISSIONS).toContain('session.read');
    expect(GATEWAY_PERMISSIONS).toContain('metrics.read');
    // These permissions have no corresponding surface and must not reappear:
    expect(GATEWAY_PERMISSIONS).not.toContain('template.read');
    expect(GATEWAY_PERMISSIONS).not.toContain('dataset.read');
    expect(GATEWAY_PERMISSIONS).not.toContain('score_config.read');
    expect(GATEWAY_PERMISSIONS).not.toContain('annotation_queue.read');
    // Removed: gated zero gateway routes and zero RLS policies.
    expect(GATEWAY_PERMISSIONS).not.toContain('experiment.read');
    expect(GATEWAY_PERMISSIONS).not.toContain('environment.promote');
  });

  it('should have no duplicate entries', () => {
    const unique = new Set(GATEWAY_PERMISSIONS);
    expect(unique.size).toBe(GATEWAY_PERMISSIONS.length);
  });
});

// ---------------------------------------------------------------------------
// ROLE_PERMISSION_SETS
// ---------------------------------------------------------------------------

describe('ROLE_PERMISSION_SETS', () => {
  it('should define sdk role with ingest and score write', () => {
    expect(ROLE_PERMISSION_SETS['sdk']).toEqual(['trace.write', 'score.write']);
  });

  it('should define read-only role with only read permissions', () => {
    const readOnly = ROLE_PERMISSION_SETS['read-only']!;
    expect(readOnly.every((p) => p.endsWith('.read'))).toBe(true);
  });

  it('should define full-access role with all gateway permissions', () => {
    expect(ROLE_PERMISSION_SETS['full-access']).toEqual(expect.arrayContaining([...GATEWAY_PERMISSIONS]));
    expect(ROLE_PERMISSION_SETS['full-access']!.length).toBe(GATEWAY_PERMISSIONS.length);
  });

  it('excludes agents.sessions.team.read from read-only', () => {
    // Read-only keys must keep session reads anonymized — silently gaining
    // real actor identities would be a privacy regression, not a bugfix.
    expect(ROLE_PERMISSION_SETS['read-only']).toEqual([
      'trace.read',
      'span.read',
      'session.read',
      'score.read',
      'metrics.read',
      'environment.read',
      'app.read',
    ]);
  });

  it('includes agents.sessions.team.read in full-access', () => {
    expect(ROLE_PERMISSION_SETS['full-access']).toContain('agents.sessions.team.read');
  });
});

// ---------------------------------------------------------------------------
// Route permission registry
// ---------------------------------------------------------------------------

describe('route permission registry', () => {
  beforeEach(() => {
    _resetRoutePermissions();
  });

  describe('setRoutePermission / getRoutePermission', () => {
    it('stores and retrieves a permission for a static path', () => {
      setRoutePermission('GET', '/v1/traces', 'trace.read');
      expect(getRoutePermission('GET', '/v1/traces')).toBe('trace.read');
    });

    it('stores and retrieves a permission for a parameterised path', () => {
      setRoutePermission('DELETE', '/v1/traces/:traceId', 'trace.read');
      expect(getRoutePermission('DELETE', '/v1/traces/:traceId')).toBe('trace.read');
    });

    it('distinguishes between methods on the same path', () => {
      setRoutePermission('GET', '/v1/traces', 'trace.read');
      setRoutePermission('POST', '/v1/traces', 'trace.write');
      expect(getRoutePermission('GET', '/v1/traces')).toBe('trace.read');
      expect(getRoutePermission('POST', '/v1/traces')).toBe('trace.write');
    });

    it('returns null for unregistered routes', () => {
      expect(getRoutePermission('GET', '/v1/unknown')).toBeNull();
    });

    it('normalises method case on lookup', () => {
      setRoutePermission('GET', '/v1/traces', 'trace.read');
      expect(getRoutePermission('get', '/v1/traces')).toBe('trace.read');
    });

    it('throws when the same route is registered twice', () => {
      setRoutePermission('GET', '/v1/traces', 'trace.read');
      expect(() =>
        setRoutePermission('GET', '/v1/traces', 'trace.read'),
      ).toThrow(/already has a permission/);
    });
  });

  describe('_resetRoutePermissions', () => {
    it('clears all registered routes', () => {
      setRoutePermission('GET', '/v1/traces', 'trace.read');
      _resetRoutePermissions();
      expect(getRoutePermission('GET', '/v1/traces')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// checkPermission
// ---------------------------------------------------------------------------

describe('checkPermission', () => {
  it('should return true when the required permission is present', () => {
    expect(checkPermission(['trace.read', 'score.write'], 'trace.read')).toBe(true);
  });

  it('should return false when the required permission is absent', () => {
    expect(checkPermission(['trace.read'], 'score.write')).toBe(false);
  });

  it('should return false for an empty permission list', () => {
    expect(checkPermission([], 'trace.read')).toBe(false);
  });

  it('should return true when permission is the only entry', () => {
    expect(checkPermission(['trace.write'], 'trace.write')).toBe(true);
  });

  it('should not match partial permission strings', () => {
    expect(checkPermission(['trace'], 'trace.read')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// permissionMiddleware
// ---------------------------------------------------------------------------

describe('permissionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRoutePermissions();
    // Seed a handful of routes for the middleware tests
    setRoutePermission('GET', '/v1/traces', 'trace.read');
    setRoutePermission('POST', '/v1/traces', 'trace.write');
    setRoutePermission('DELETE', '/v1/traces/:traceId', 'trace.read');
  });

  it('should call next when no user context is present', async () => {
    const { c, next } = createMockContext({ user: undefined });

    await permissionMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('should call next when user is null', async () => {
    const { c, next } = createMockContext({ user: null as any });

    await permissionMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('should call next for routes with no permission mapping', async () => {
    const { c, next } = createMockContext({
      user: { permissions: ['trace.read'], tenantId: 't1', appId: 'a1' },
      method: 'GET',
      routePath: '/health',
    });

    await permissionMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('should return 403 JSON when the user lacks the required permission', async () => {
    const { c, next, jsonSpy } = createMockContext({
      user: { permissions: ['score.read'], tenantId: 't1', appId: 'a1' },
      method: 'POST',
      routePath: '/v1/traces',
    });

    await permissionMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      {
        error: {
          message: "Forbidden: missing required permission 'trace.write'",
          code: 'forbidden',
          required_permission: 'trace.write',
        },
      },
      403,
    );
  });

  it('should call next when the user has the required permission', async () => {
    const { c, next, jsonSpy } = createMockContext({
      user: { permissions: ['trace.read'], tenantId: 't1', appId: 'a1' },
      method: 'GET',
      routePath: '/v1/traces',
    });

    await permissionMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('should treat missing permissions array as empty', async () => {
    const { c, next, jsonSpy } = createMockContext({
      user: { tenantId: 't1', appId: 'a1' } as any,
      method: 'GET',
      routePath: '/v1/traces',
    });

    await permissionMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'forbidden' }),
      }),
      403,
    );
  });

  it('should include the required permission in the 403 response body', async () => {
    const { c, next, jsonSpy } = createMockContext({
      user: { permissions: [], tenantId: 't1', appId: 'a1' },
      method: 'DELETE',
      routePath: '/v1/traces/:traceId',
    });

    await permissionMiddleware(c, next);

    const responseBody = jsonSpy.mock.calls[0]![0] as any;
    expect(responseBody.error.required_permission).toBe('trace.read');
  });

  it('should look up permission by route pattern, not request URL', async () => {
    // The middleware relies on Hono's pre-matched pattern so we never re-parse
    // paths. Even if a caller hit `/v1/traces/abc-123`, the registry is keyed
    // by the pattern `/v1/traces/:traceId`.
    const { c, next } = createMockContext({
      user: { permissions: ['trace.read'], tenantId: 't1', appId: 'a1' },
      method: 'DELETE',
      routePath: '/v1/traces/:traceId',
    });

    await permissionMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// permissionMiddleware — API-key trace reads (regression guard)
//
// Programmatic consumers (CI pipelines, agents) authenticate with an app-
// scoped API key (authMode 'apikey'), not a session JWT. An app-scoped key
// that carries `trace.read` MUST be able to read its own app's traces —
// otherwise the metadata read API is useless to its primary consumer. A
// write-only SDK key (score.write/trace.write but no trace.read) is correctly
// denied. This pins the read-permission gap so it can't silently regress.
// ---------------------------------------------------------------------------

describe('permissionMiddleware — API-key trace reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRoutePermissions();
    setRoutePermission('GET', '/v1/traces', 'trace.read');
    setRoutePermission('GET', '/v1/traces/:traceId', 'trace.read');
  });

  it.each([
    ['GET', '/v1/traces'],
    ['GET', '/v1/traces/:traceId'],
  ])('allows an app-scoped API key with trace.read to read %s %s', async (method, routePath) => {
    const { c, next, jsonSpy } = createMockContext({
      user: {
        permissions: ['trace.read', 'span.read', 'session.read'],
        tenantId: 't1',
        appId: 'a1',
        authMode: 'apikey',
      },
      method,
      routePath,
    });

    await permissionMiddleware(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('denies a write-only SDK key (score.write but no trace.read) with 403', async () => {
    // Mirrors the production gap exactly: the same key POSTs scores fine
    // (score.write) but must not read traces without trace.read.
    const { c, next, jsonSpy } = createMockContext({
      user: {
        permissions: ['trace.write', 'score.write'],
        tenantId: 't1',
        appId: 'a1',
        authMode: 'apikey',
      },
      method: 'GET',
      routePath: '/v1/traces',
    });

    await permissionMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'forbidden',
          required_permission: 'trace.read',
        }),
      }),
      403,
    );
  });
});

// ============================================================================
// permissionMiddleware — bearer path
// ============================================================================

describe('permissionMiddleware (bearer auth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRoutePermissions();
    setRoutePermission('GET', '/v1/traces', 'trace.read');
    setRoutePermission('POST', '/v1/traces', 'trace.write');
    setRoutePermission('DELETE', '/v1/traces/:traceId', 'trace.read');
    setRoutePermission('POST', '/v1/scores', 'score.write');
  });

  it('defers every bearer permission decision to app_authorize — no channel-specific gate', async () => {
    // A bearer user with the right role should be able to ingest traces
    // exactly as they could via the dashboard. The middleware doesn't
    // second-guess the user's permissions; app_authorize is the single
    // source of truth.
    mockCheckBearerPermission.mockResolvedValueOnce(true);
    const { c, next } = createMockContext({
      user: {
        tenantId: 't1',
        appId: 'a1',
        authMode: 'bearer',
        userJwt: 'user-jwt',
        permissions: [],
      },
      method: 'POST',
      routePath: '/v1/traces', // an ingest route, reached here over bearer auth
    });

    await permissionMiddleware(c, next);

    expect(mockCheckBearerPermission).toHaveBeenCalledWith({
      env: expect.any(Object),
      userJwt: 'user-jwt',
      permission: 'trace.write',
      appId: 'a1',
      requestTenantId: 't1',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 PERMISSION_DENIED for bearer writes when app_authorize says no', async () => {
    mockCheckBearerPermission.mockResolvedValueOnce(false);
    const { c, next, jsonSpy } = createMockContext({
      user: {
        tenantId: 't1',
        appId: 'a1',
        authMode: 'bearer',
        userJwt: 'user-jwt',
        permissions: [],
      },
      method: 'DELETE',
      routePath: '/v1/traces/:traceId',
    });

    await permissionMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    const body = jsonSpy.mock.calls[0]![0] as any;
    expect(body.error.code).toBe('PERMISSION_DENIED');
    expect(body.error.required_permission).toBe('trace.read');
  });

  it('calls app_authorize and passes through when RPC returns true', async () => {
    mockCheckBearerPermission.mockResolvedValueOnce(true);
    const { c, next, jsonSpy } = createMockContext({
      user: {
        tenantId: 't1',
        appId: 'a1',
        authMode: 'bearer',
        userJwt: 'user-jwt',
        permissions: [],
      },
      method: 'GET',
      routePath: '/v1/traces',
      env: { SUPABASE_API_BASE_URL: 'http://x', SUPABASE_PUBLISHABLE_KEY: 'anon' },
    });

    await permissionMiddleware(c, next);

    expect(mockCheckBearerPermission).toHaveBeenCalledWith({
      env: expect.any(Object),
      userJwt: 'user-jwt',
      permission: 'trace.read',
      appId: 'a1',
      requestTenantId: 't1',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('returns 403 PERMISSION_DENIED when app_authorize returns false', async () => {
    mockCheckBearerPermission.mockResolvedValueOnce(false);
    const { c, next, jsonSpy } = createMockContext({
      user: {
        tenantId: 't1',
        appId: 'a1',
        authMode: 'bearer',
        userJwt: 'user-jwt',
        permissions: [],
      },
      method: 'GET',
      routePath: '/v1/traces',
    });

    await permissionMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(
      {
        error: {
          message: "Forbidden: missing required permission 'trace.read'",
          code: 'PERMISSION_DENIED',
          required_permission: 'trace.read',
        },
      },
      403,
    );
  });

  it('returns 401 defensively when bearer user context is missing userJwt', async () => {
    // A well-constructed auth middleware always populates userJwt for
    // bearer sessions. If this check fires, the middleware upstream
    // dropped it — treat as an auth state bug, not silently continue.
    const { c, next, jsonSpy } = createMockContext({
      user: {
        tenantId: 't1',
        appId: 'a1',
        authMode: 'bearer',
        // userJwt intentionally omitted
        permissions: [],
      },
      method: 'GET',
      routePath: '/v1/traces',
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await permissionMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    const body = jsonSpy.mock.calls[0]![0] as any;
    expect(body.error.code).toBe('PERMISSION_DENIED');
    expect(mockCheckBearerPermission).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not consult user.permissions array for bearer auth — always goes through RPC', async () => {
    // Even if a bearer user somehow has a populated permissions array,
    // permission decisions MUST come from app_authorize (single source
    // of truth). If this test fails, we've leaked the api-key logic
    // into the bearer path.
    mockCheckBearerPermission.mockResolvedValueOnce(false);
    const { c, next } = createMockContext({
      user: {
        tenantId: 't1',
        appId: 'a1',
        authMode: 'bearer',
        userJwt: 'user-jwt',
        permissions: ['trace.read'], // LOCAL claim says yes…
      },
      method: 'GET',
      routePath: '/v1/traces',
    });

    await permissionMiddleware(c, next);

    // …but app_authorize says no, and the middleware trusts the RPC.
    expect(mockCheckBearerPermission).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });
});
