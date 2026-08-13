/**
 * Tests: PATCH/DELETE /api/orgs/[orgName]/apps/[appId]/member-roles/[appMemberRoleId]
 *
 * See `../__tests__/route.test.ts` for the mocking rationale (only the
 * audited `@ee/features/app-access` actions are stubbed).
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

const { updateAppRoleAction, updateAppCustomRoleAction, revokeAppRoleAction } = vi.hoisted(() => ({
  updateAppRoleAction: vi.fn(),
  updateAppCustomRoleAction: vi.fn(),
  revokeAppRoleAction: vi.fn(),
}));

vi.mock('@ee/features/app-access/actions', () => ({
  updateAppRoleAction,
  updateAppCustomRoleAction,
  revokeAppRoleAction,
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATCH, DELETE } from '../route';

const routeCtx = { params: Promise.resolve({ orgName: 'acme', appId: 'app-1', appMemberRoleId: 'amr-1' }) };
const patchReq = (body: unknown, headers?: Record<string, string>) =>
  new Request('http://localhost/api/orgs/acme/apps/app-1/member-roles/amr-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers,
  });
const deleteReq = (headers?: Record<string, string>) =>
  new Request('http://localhost/api/orgs/acme/apps/app-1/member-roles/amr-1', { method: 'DELETE', headers });
const BEARER = { authorization: 'Bearer olk_somekey' };
const EXPECTED_BEARER_REJECTION = {
  error: {
    code: 'unauthorized',
    message: 'Management API keys are not supported on this endpoint; use a browser session',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /api/orgs/[orgName]/apps/[appId]/member-roles/[appMemberRoleId]', () => {
  it('dispatches a { role } body to the built-in-role action', async () => {
    const updated = { id: 'amr-1', role: 'admin', custom_role_id: null };
    updateAppRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: updated } });

    const res = await PATCH(patchReq({ role: 'admin' }), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(updated);
    expect(updateAppRoleAction).toHaveBeenCalledWith({ appMemberRoleId: 'amr-1', role: 'admin' });
    expect(updateAppCustomRoleAction).not.toHaveBeenCalled();
  });

  it('dispatches a { customRoleId } body to the custom-role action', async () => {
    const updated = { id: 'amr-1', role: 'read', custom_role_id: 'cr-1' };
    updateAppCustomRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: updated } });

    const res = await PATCH(patchReq({ customRoleId: 'cr-1' }), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(updated);
    expect(updateAppCustomRoleAction).toHaveBeenCalledWith({ appMemberRoleId: 'amr-1', customRoleId: 'cr-1' });
    expect(updateAppRoleAction).not.toHaveBeenCalled();
  });

  it('rejects a body with neither role nor customRoleId', async () => {
    const res = await PATCH(patchReq({}), routeCtx);
    expect(res.status).toBe(400);
    expect(updateAppRoleAction).not.toHaveBeenCalled();
    expect(updateAppCustomRoleAction).not.toHaveBeenCalled();
  });

  it('rejects a body with both role and customRoleId', async () => {
    const res = await PATCH(patchReq({ role: 'admin', customRoleId: 'cr-1' }), routeCtx);
    expect(res.status).toBe(400);
  });

  it('fails closed with 403 when the app_level_roles entitlement is absent', async () => {
    updateAppRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'entitlement_denied', entitlement: { featureKey: 'app_level_roles' } },
    });

    const res = await PATCH(patchReq({ role: 'admin' }), routeCtx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.reason).toBe('entitlement_denied');
  });

  it('returns a clean 401 for an management-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await PATCH(patchReq({ role: 'admin' }, BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(EXPECTED_BEARER_REJECTION);
    expect(updateAppRoleAction).not.toHaveBeenCalled();
    expect(updateAppCustomRoleAction).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/orgs/[orgName]/apps/[appId]/member-roles/[appMemberRoleId]', () => {
  it('revokes the assignment — the service reports a bare ack, not the deleted row', async () => {
    revokeAppRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: { success: true } } });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(revokeAppRoleAction).toHaveBeenCalledWith({ appMemberRoleId: 'amr-1' });
  });

  it('fails closed with 403 when the app_level_roles entitlement is absent', async () => {
    revokeAppRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'entitlement_denied', entitlement: { featureKey: 'app_level_roles' } },
    });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.reason).toBe('entitlement_denied');
  });

  it('maps a permission denial to 403 forbidden', async () => {
    revokeAppRoleAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: app_member_role.delete' },
    });

    const res = await DELETE(deleteReq(), routeCtx);

    expect(res.status).toBe(403);
  });

  it('returns a clean 401 for an management-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await DELETE(deleteReq(BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(EXPECTED_BEARER_REJECTION);
    expect(revokeAppRoleAction).not.toHaveBeenCalled();
  });
});
