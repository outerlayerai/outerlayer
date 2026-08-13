/**
 * Tests: GET/PATCH/DELETE /api/orgs/[orgName]/custom-roles/[roleId]
 *
 * See `../__tests__/route.test.ts` for the mocking rationale (only the
 * audited `@ee/features/custom-roles` actions are stubbed).
 */

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    constructor(body: unknown, init?: { status?: number }) {
      this._body = body;
      this.status = init?.status ?? 200;
    }
    async json() {
      return this._body;
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

const { mockCtx } = vi.hoisted(() => ({
  mockCtx: Object.freeze({ userId: 'user-1', tenantId: 'tenant-1', appId: 'app-1', dataRetentionDays: -1 }),
}));

vi.mock('@/lib/api/with-api', async () => {
  const { buildWithApiMock } = await import('@/lib/api/__tests__/fixtures');
  return buildWithApiMock(mockCtx);
});

const { getCustomRoleAction, updateCustomRoleAction, deleteCustomRoleAction } = vi.hoisted(() => ({
  getCustomRoleAction: vi.fn(),
  updateCustomRoleAction: vi.fn(),
  deleteCustomRoleAction: vi.fn(),
}));

vi.mock('@ee/features/custom-roles/actions', () => ({
  getCustomRoleAction,
  updateCustomRoleAction,
  deleteCustomRoleAction,
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, PATCH, DELETE } from '../route';

const routeCtx = { params: Promise.resolve({ orgName: 'acme', roleId: 'cr-1' }) };
const getReq = (headers?: Record<string, string>) =>
  new Request('http://localhost/api/orgs/acme/custom-roles/cr-1', { headers });
const patchReq = (body: unknown, headers?: Record<string, string>) =>
  new Request('http://localhost/api/orgs/acme/custom-roles/cr-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers,
  });
const deleteReq = (qs = '', headers?: Record<string, string>) =>
  new Request(`http://localhost/api/orgs/acme/custom-roles/cr-1${qs}`, { method: 'DELETE', headers });
const BEARER = { authorization: 'Bearer olk_somekey' };
const EXPECTED_BEARER_REJECTION = {
  error: {
    code: 'unauthorized',
    message: 'Admin API keys are not supported on this endpoint; use a browser session',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/orgs/[orgName]/custom-roles/[roleId]', () => {
  it('returns the role detail and forwards the path roleId to the action', async () => {
    const detail = { id: 'cr-1', name: 'reviewer', permissions: [], members: [] };
    getCustomRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: detail } });

    const res = await GET(getReq(), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(detail);
    expect(getCustomRoleAction).toHaveBeenCalledWith({ roleId: 'cr-1' });
  });

  it('returns a clean 401 for an admin-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await GET(getReq(BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(EXPECTED_BEARER_REJECTION);
    expect(getCustomRoleAction).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/orgs/[orgName]/custom-roles/[roleId]', () => {
  it('updates the role and merges the path roleId into the action input', async () => {
    const updated = { id: 'cr-1', name: 'reviewer-v2', permissions: ['trace.read'], memberCount: 1 };
    updateCustomRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: updated } });

    const res = await PATCH(patchReq({ name: 'reviewer-v2' }), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(updated);
    expect(updateCustomRoleAction).toHaveBeenCalledWith({ roleId: 'cr-1', name: 'reviewer-v2' });
  });

  // proves AC-059-23
  it('fails closed with 403 when the custom_roles entitlement is absent', async () => {
    updateCustomRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'entitlement_denied', entitlement: { featureKey: 'custom_roles' } },
    });

    const res = await PATCH(patchReq({ name: 'reviewer-v2' }), routeCtx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.reason).toBe('entitlement_denied');
  });

  it('returns a clean 401 for an admin-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await PATCH(patchReq({ name: 'reviewer-v2' }, BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(EXPECTED_BEARER_REJECTION);
    expect(updateCustomRoleAction).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/orgs/[orgName]/custom-roles/[roleId]', () => {
  it('deletes the role and reads fallbackRole from the query string', async () => {
    deleteCustomRoleAction.mockResolvedValue({
      ok: true,
      data: { success: true, data: { deleted: true, membersReassigned: 2 } },
    });

    const res = await DELETE(deleteReq('?fallbackRole=admin'), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ deleted: true, membersReassigned: 2 });
    expect(deleteCustomRoleAction).toHaveBeenCalledWith({ roleId: 'cr-1', fallbackRole: 'admin' });
  });

  it('maps "members assigned, no fallback" to 400', async () => {
    deleteCustomRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'Role has 3 assigned member(s). Specify a fallback role.' },
    });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'invalid_field_value', message: 'Role has 3 assigned member(s). Specify a fallback role.' },
    });
  });

  it('returns a clean 401 for an admin-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await DELETE(deleteReq('', BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(EXPECTED_BEARER_REJECTION);
    expect(deleteCustomRoleAction).not.toHaveBeenCalled();
  });
});
