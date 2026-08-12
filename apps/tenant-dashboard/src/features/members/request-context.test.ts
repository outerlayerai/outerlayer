/**
 * `requireOrgContext` / `requireMembershipContext` — the org-scoped auth seam
 * the members REST routes resolve instead of `withApi`'s built-in
 * app-scoped `authenticateRequest`. Pinning the exact status codes matters:
 * a client can't tell "not signed in" from "no permission" apart otherwise.
 *
 * A `Bearer olk_…` scheme is a distinct branch from session auth (see
 * `resolveOrgContext`), so its security-relevant cases — mismatched org,
 * denied permission, revoked/malformed key — are pinned here too, alongside
 * unchanged coverage of the session path.
 */

const { mockLoadCtx, mockCheckPerm, mockLoadBearerCtx, headersGet } = vi.hoisted(() => ({
  mockLoadCtx: vi.fn(),
  mockCheckPerm: vi.fn(),
  mockLoadBearerCtx: vi.fn(),
  headersGet: vi.fn<(name: string) => string | null>(() => null),
}));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: mockLoadCtx,
  checkRequestPermission: mockCheckPerm,
}));

vi.mock('@/lib/system/admin-api-key-service', () => ({
  loadBearerServiceContext: mockLoadBearerCtx,
  ADMIN_API_KEY_PREFIX: 'olk_',
}));

vi.mock('next/headers', () => ({
  headers: () => ({ get: headersGet }),
}));

import { requireOrgContext, requireMembershipContext } from './request-context';

const ACTOR = { userId: 'user-1', role: 'admin' };
const CTX = { db: {}, tenantId: 'tenant-1', actor: ACTOR };

const BEARER_ACTOR = { userId: 'creator-1', role: 'owner' };
const BEARER_CTX = { db: {}, tenantId: 'tenant-1', actor: BEARER_ACTOR };

beforeEach(() => {
  vi.clearAllMocks();
  headersGet.mockReturnValue(null);
});

describe('requireOrgContext — session path (unchanged)', () => {
  it('returns the resolved context on success', async () => {
    mockLoadCtx.mockResolvedValue(CTX);

    await expect(requireOrgContext()).resolves.toBe(CTX);
  });

  it('maps an unauthenticated session to a 401', async () => {
    mockLoadCtx.mockRejectedValue(new Error('Not authenticated'));

    await expect(requireOrgContext()).rejects.toMatchObject({ statusCode: 401 });
  });

  it('maps a missing tenant to a 403, not a generic 401', async () => {
    mockLoadCtx.mockRejectedValue(new Error('No tenant for request'));

    await expect(requireOrgContext()).rejects.toMatchObject({ statusCode: 403 });
  });

  it('never calls the bearer resolver when no Authorization header is present', async () => {
    mockLoadCtx.mockResolvedValue(CTX);

    await requireOrgContext();

    expect(mockLoadBearerCtx).not.toHaveBeenCalled();
  });

  it('falls through to session auth for a Bearer token that is not an admin API key (wrong prefix)', async () => {
    headersGet.mockReturnValue('Bearer sk_outerlayer_agatewaykey');
    mockLoadCtx.mockResolvedValue(CTX);

    await expect(requireOrgContext()).resolves.toBe(CTX);
    expect(mockLoadBearerCtx).not.toHaveBeenCalled();
  });
});

describe('requireOrgContext — bearer path', () => {
  it('returns the bearer ServiceContext on a key bound to this org', async () => {
    headersGet.mockReturnValue('Bearer olk_validkey');
    mockLoadBearerCtx.mockResolvedValue({
      ok: true,
      ctx: BEARER_CTX,
      keyPermissions: ['membership.read'],
    });

    await expect(requireOrgContext()).resolves.toBe(BEARER_CTX);
    expect(mockLoadCtx).not.toHaveBeenCalled();
  });

  it('maps an invalid/expired/revoked/malformed key to a 401, never falling through to session auth', async () => {
    headersGet.mockReturnValue('Bearer olk_badkey');
    mockLoadBearerCtx.mockResolvedValue({ ok: false, status: 401, message: 'Not authenticated' });

    await expect(requireOrgContext()).rejects.toMatchObject({ statusCode: 401 });
    expect(mockLoadCtx).not.toHaveBeenCalled();
  });

  it("maps a key for a different org (tenant mismatch) to a 403", async () => {
    headersGet.mockReturnValue('Bearer olk_otherorgkey');
    mockLoadBearerCtx.mockResolvedValue({
      ok: false,
      status: 403,
      message: 'This key does not belong to this organization',
    });

    await expect(requireOrgContext()).rejects.toMatchObject({
      statusCode: 403,
      message: 'This key does not belong to this organization',
    });
  });

  it("maps a key whose creator is no longer an active member to a 403", async () => {
    headersGet.mockReturnValue('Bearer olk_orphanedkey');
    mockLoadBearerCtx.mockResolvedValue({
      ok: false,
      status: 403,
      message: "This key's creator is no longer an active member",
    });

    await expect(requireOrgContext()).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('requireMembershipContext — session path (unchanged)', () => {
  it('returns the context when the permission check allows', async () => {
    mockLoadCtx.mockResolvedValue(CTX);
    mockCheckPerm.mockResolvedValue(true);

    const result = await requireMembershipContext('membership.read');

    expect(result).toBe(CTX);
    expect(mockCheckPerm).toHaveBeenCalledWith(ACTOR, 'membership.read');
  });

  it('throws a 403 naming the denied permission, without ever resolving twice', async () => {
    mockLoadCtx.mockResolvedValue(CTX);
    mockCheckPerm.mockResolvedValue(false);

    await expect(requireMembershipContext('membership.delete')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Permission denied: membership.delete',
    });
  });
});

describe('requireMembershipContext — bearer path', () => {
  it("grants when the permission is in the key's own permission set — never calling the session RPC checker", async () => {
    headersGet.mockReturnValue('Bearer olk_validkey');
    mockLoadBearerCtx.mockResolvedValue({
      ok: true,
      ctx: BEARER_CTX,
      keyPermissions: ['membership.read', 'membership.insert'],
    });

    const result = await requireMembershipContext('membership.insert');

    expect(result).toBe(BEARER_CTX);
    expect(mockCheckPerm).not.toHaveBeenCalled();
  });

  it("denies with a 403 when the permission is absent from the key's own permission set", async () => {
    headersGet.mockReturnValue('Bearer olk_readonlykey');
    mockLoadBearerCtx.mockResolvedValue({
      ok: true,
      ctx: BEARER_CTX,
      keyPermissions: ['membership.read'],
    });

    await expect(requireMembershipContext('membership.delete')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Permission denied: membership.delete',
    });
    expect(mockCheckPerm).not.toHaveBeenCalled();
  });
});
