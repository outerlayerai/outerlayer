/**
 * Tests: GET/POST /api/orgs/[orgName]/custom-roles
 *
 * Only the `@ee/features/custom-roles` actions are mocked (the MSW-only rule
 * forbids mocking Supabase directly, and these actions are the audited seam
 * that already proves auth/permission/entitlement behavior in
 * `ee/features/custom-roles/actions.test.ts`) — this suite proves the route
 * translates each `ActionResult` shape into the right HTTP response,
 * including the fail-closed 403 on `entitlement_denied`.
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

const { listCustomRolesAction, createCustomRoleAction } = vi.hoisted(() => ({
  listCustomRolesAction: vi.fn(),
  createCustomRoleAction: vi.fn(),
}));

vi.mock('@ee/features/custom-roles/actions', () => ({
  listCustomRolesAction,
  createCustomRoleAction,
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';

const routeCtx = { params: Promise.resolve({ orgName: 'acme' }) };
const listReq = (headers?: Record<string, string>) =>
  new Request('http://localhost/api/orgs/acme/custom-roles', { headers });
const postReq = (body: unknown, headers?: Record<string, string>) =>
  new Request('http://localhost/api/orgs/acme/custom-roles', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
const BEARER = { authorization: 'Bearer olk_somekey' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/orgs/[orgName]/custom-roles', () => {
  it('returns the role list on success', async () => {
    listCustomRolesAction.mockResolvedValue({
      ok: true,
      data: { success: true, data: [{ id: 'cr-1', name: 'reviewer', permissions: [], memberCount: 0 }] },
    });

    const res = await GET(listReq(), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([{ id: 'cr-1', name: 'reviewer', permissions: [], memberCount: 0 }]);
  });

  it('maps a permission denial to 403 forbidden', async () => {
    listCustomRolesAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: custom_role.read' },
    });

    const res = await GET(listReq(), routeCtx);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  it('returns a clean 401 for an admin-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await GET(listReq(BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'unauthorized',
        message: 'Admin API keys are not supported on this endpoint; use a browser session',
      },
    });
    expect(listCustomRolesAction).not.toHaveBeenCalled();
  });
});

describe('POST /api/orgs/[orgName]/custom-roles', () => {
  const validBody = { name: 'reviewer', permissions: ['trace.read'] };

  it('creates a role and returns 201', async () => {
    const created = { id: 'cr-1', name: 'reviewer', permissions: ['trace.read'], memberCount: 0 };
    createCustomRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: created } });

    const res = await POST(postReq(validBody), routeCtx);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(created);
    expect(createCustomRoleAction).toHaveBeenCalledWith(validBody);
  });

  // proves AC-059-22
  it('fails closed with 403 when the custom_roles entitlement is absent', async () => {
    createCustomRoleAction.mockResolvedValue({
      ok: true,
      data: {
        success: false,
        error: 'entitlement_denied',
        entitlement: { featureKey: 'custom_roles', requiredTier: 'team' },
      },
    });

    const res = await POST(postReq(validBody), routeCtx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
    expect(body.error.reason).toBe('entitlement_denied');
    expect(body.error.entitlement).toEqual({ featureKey: 'custom_roles', requiredTier: 'team' });
  });

  it('rejects an invalid body with 400 before calling the action', async () => {
    const res = await POST(postReq({ name: '' }), routeCtx);

    expect(res.status).toBe(400);
    expect(createCustomRoleAction).not.toHaveBeenCalled();
  });

  it('maps a business-rule failure (non-entitlement) to 400', async () => {
    createCustomRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'A role with this name already exists' },
    });

    const res = await POST(postReq(validBody), routeCtx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'invalid_field_value', message: 'A role with this name already exists' },
    });
  });

  it('returns a clean 401 for an admin-API-key bearer caller instead of hitting the session-only action', async () => {
    const res = await POST(postReq(validBody, BEARER), routeCtx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'unauthorized',
        message: 'Admin API keys are not supported on this endpoint; use a browser session',
      },
    });
    expect(createCustomRoleAction).not.toHaveBeenCalled();
  });
});
