/**
 * `managementAuthGuard` — the auth seam for `/v1/orgs/:orgName/...`.
 *
 * `resolveBearerServiceContext` (and everything it delegates to — digest
 * verification, tenant binding, creator-permission intersection) is
 * unit-tested exhaustively in `@repo/org-management-service`'s own suite;
 * these tests prove the GATEWAY'S wiring around it: the guard passes the
 * request's raw `Authorization` header and `orgName` param through
 * unmodified, translates every `resolveBearerServiceContext` outcome to the
 * right HTTP status/body, enforces the route's required permission against
 * the already-intersected set, and — the one behavior worth re-verifying
 * against the REAL package function rather than a mock — fails closed with
 * zero database round-trips when the pepper is unconfigured.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { managementAuthGuard, isManagementApiPath, MANAGEMENT_API_PATH_PREFIX } from './management-auth';

const resolveBearerServiceContext = vi.fn();

vi.mock('@repo/org-management-service', () => ({
  resolveBearerServiceContext: (...args: unknown[]) => resolveBearerServiceContext(...args),
}));

const adminClientStub = { __marker: 'admin-client' };
vi.mock('./system-client', () => ({
  createSystemAdminClient: vi.fn(() => adminClientStub),
}));

function makeContext(opts: {
  orgName?: string;
  authorization?: string | null;
  pepper?: string;
}): { ctx: Context; captured: () => { body: unknown; status: number } | null; nextSpy: ReturnType<typeof vi.fn> } {
  let captured: { body: unknown; status: number } | null = null;
  const headers: Record<string, string> = {};
  if (opts.authorization !== null && opts.authorization !== undefined) {
    headers['Authorization'] = opts.authorization;
  }
  const setValues: Record<string, unknown> = {};
  const ctx = {
    req: {
      param: vi.fn((key: string) => (key === 'orgName' ? opts.orgName : undefined)),
      header: vi.fn((name: string) => headers[name]),
    },
    env: { MANAGEMENT_API_KEY_PEPPER: opts.pepper },
    set: vi.fn((key: string, value: unknown) => {
      setValues[key] = value;
    }),
    get: vi.fn((key: string) => setValues[key]),
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
  } as unknown as Context;
  return { ctx, captured: () => captured, nextSpy: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isManagementApiPath', () => {
  it('matches only the /v1/orgs/ prefix', () => {
    expect(isManagementApiPath('/v1/orgs/acme/members')).toBe(true);
    expect(isManagementApiPath(MANAGEMENT_API_PATH_PREFIX)).toBe(true);
    expect(isManagementApiPath('/v1/apps')).toBe(false);
    expect(isManagementApiPath('/v1/organgs/acme')).toBe(false);
  });
});

describe('managementAuthGuard', () => {
  it('passes the raw Authorization header, org param, admin client, and pepper straight through', async () => {
    resolveBearerServiceContext.mockResolvedValue({
      ok: true,
      ctx: { db: adminClientStub, tenantId: 't1', actor: { userId: 'u1', role: 'owner' } },
      keyPermissions: ['membership.read'],
    });
    const { ctx, nextSpy } = makeContext({
      orgName: 'acme',
      authorization: 'Bearer olk_abc',
      pepper: 'pepper-1',
    });

    await managementAuthGuard('membership.read')(ctx, nextSpy);

    expect(resolveBearerServiceContext).toHaveBeenCalledWith({
      authorizationHeader: 'Bearer olk_abc',
      orgName: 'acme',
      adminClient: adminClientStub,
      pepper: 'pepper-1',
    });
  });

  it('sets managementAuth and calls next() on a valid, permitted key', async () => {
    resolveBearerServiceContext.mockResolvedValue({
      ok: true,
      ctx: { db: adminClientStub, tenantId: 't1', actor: { userId: 'u1', role: 'owner' } },
      keyPermissions: ['membership.read', 'membership.insert'],
    });
    const { ctx, nextSpy } = makeContext({ orgName: 'acme', authorization: 'Bearer olk_abc' });

    const result = await managementAuthGuard('membership.read')(ctx, nextSpy);

    expect(result).toBeUndefined();
    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(ctx.set).toHaveBeenCalledWith('managementAuth', {
      ctx: { db: adminClientStub, tenantId: 't1', actor: { userId: 'u1', role: 'owner' } },
      permissions: ['membership.read', 'membership.insert'],
    });
  });

  // proves AC-059-18: an invalid/expired/revoked/malformed bearer is denied
  // with 401 and next() is never called — the route handler never runs.
  it('returns 401 unauthorized with no Authorization header at all, and never calls next()', async () => {
    resolveBearerServiceContext.mockResolvedValue({ ok: false, status: 401, message: 'Not authenticated' });
    const { ctx, captured, nextSpy } = makeContext({ orgName: 'acme', authorization: null });

    await managementAuthGuard('membership.read')(ctx, nextSpy);

    expect(captured()).toEqual({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Not authenticated' } },
    });
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for an sk_outerlayer_* gateway key presented on a management route', async () => {
    // The package's own bearer-shape check rejects anything not `olk_*`
    // before any DB round-trip — this test only pins that OUR guard forwards
    // the raw header (so a real sk_ key reaches that check) and maps the
    // resulting 401 the same way as a missing header, never falling through
    // to any other auth scheme.
    resolveBearerServiceContext.mockResolvedValue({ ok: false, status: 401, message: 'Not authenticated' });
    const { ctx, captured, nextSpy } = makeContext({
      orgName: 'acme',
      authorization: 'Bearer sk_outerlayer_realkey',
    });

    await managementAuthGuard('membership.read')(ctx, nextSpy);

    expect(resolveBearerServiceContext).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationHeader: 'Bearer sk_outerlayer_realkey' }),
    );
    expect(captured()?.status).toBe(401);
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it('returns 403 forbidden when the key does not belong to the URL org (cross-tenant / unresolved org)', async () => {
    resolveBearerServiceContext.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'This key does not belong to this organization',
    });
    const { ctx, captured, nextSpy } = makeContext({ orgName: 'other-org', authorization: 'Bearer olk_abc' });

    await managementAuthGuard('membership.read')(ctx, nextSpy);

    expect(captured()).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'This key does not belong to this organization' } },
    });
    expect(nextSpy).not.toHaveBeenCalled();
  });

  // proves AC-059-02, AC-059-04, AC-059-08, AC-059-10: every member route denies
  // with 403 when the caller's intersected permission set lacks the route's
  // required grant, uniformly across membership.read/insert/update/delete.
  it('returns 403 when the verified/tenant-bound key lacks the route permission (post creator-demotion intersection)', async () => {
    // keyPermissions is already the package's demotion-aware intersection
    // (auth.permissions ∩ creator's live role_permissions) — a permission
    // missing here means either the key never had it, or its creator was
    // demoted since mint time. Either way the guard must deny.
    resolveBearerServiceContext.mockResolvedValue({
      ok: true,
      ctx: { db: adminClientStub, tenantId: 't1', actor: { userId: 'u1', role: 'read' } },
      keyPermissions: ['membership.read'],
    });
    const { ctx, captured, nextSpy } = makeContext({ orgName: 'acme', authorization: 'Bearer olk_abc' });

    await managementAuthGuard('membership.delete')(ctx, nextSpy);

    expect(captured()).toEqual({
      status: 403,
      body: {
        error: {
          code: 'forbidden',
          message: "Missing required permission 'membership.delete'",
          required_permission: 'membership.delete',
        },
      },
    });
    expect(nextSpy).not.toHaveBeenCalled();
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it('forwards an org name containing path-like/encoded segments verbatim, with no local decoding or string-building', async () => {
    resolveBearerServiceContext.mockResolvedValue({ ok: false, status: 403, message: 'This key does not belong to this organization' });
    const trickyOrgName = '..%2F..%2Facme';
    const { ctx, nextSpy } = makeContext({ orgName: trickyOrgName, authorization: 'Bearer olk_abc' });

    await managementAuthGuard('membership.read')(ctx, nextSpy);

    expect(resolveBearerServiceContext).toHaveBeenCalledWith(
      expect.objectContaining({ orgName: trickyOrgName }),
    );
    expect(nextSpy).not.toHaveBeenCalled();
  });
});

describe('managementAuthGuard — unset pepper fails closed with zero DB round-trips (real package function, not mocked)', () => {
  it('rejects a well-formed olk_ bearer with no RPC/query ever issued when MANAGEMENT_API_KEY_PEPPER is unset', async () => {
    vi.resetModules();
    vi.doUnmock('@repo/org-management-service');
    const { managementAuthGuard: realGuard } = await import('./management-auth');

    const rpc = vi.fn();
    const from = vi.fn();
    const { createSystemAdminClient } = await import('./system-client');
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ rpc, from });

    const { ctx, captured, nextSpy } = makeContext({
      orgName: 'acme',
      authorization: 'Bearer olk_wellformedbutunverifiable',
      pepper: undefined,
    });

    await realGuard('membership.read')(ctx, nextSpy);

    expect(captured()?.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(nextSpy).not.toHaveBeenCalled();
  });
});
