/**
 * Tests: GET/POST /api/orgs/[orgName]/apps/[appId]/member-roles
 *
 * Only the `@ee/features/app-access` actions are mocked (the MSW-only rule
 * forbids mocking Supabase directly; these actions are the audited seam) —
 * this suite proves the route translates each `ActionResult` shape into the
 * right HTTP response, including the fail-closed 403 on `entitlement_denied`.
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

const { listAppRolesAction, assignAppRoleAction } = vi.hoisted(() => ({
  listAppRolesAction: vi.fn(),
  assignAppRoleAction: vi.fn(),
}));

vi.mock('@ee/features/app-access/actions', () => ({
  listAppRolesAction,
  assignAppRoleAction,
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';

const routeCtx = { params: Promise.resolve({ orgName: 'acme', appId: 'app-1' }) };
const listReq = (qs = '') => new Request(`http://localhost/api/orgs/acme/apps/app-1/member-roles${qs}`);
const postReq = (body: unknown) =>
  new Request('http://localhost/api/orgs/acme/apps/app-1/member-roles', {
    method: 'POST',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/orgs/[orgName]/apps/[appId]/member-roles', () => {
  it('unwraps the { data } envelope and returns the enriched row list', async () => {
    const rows = [
      {
        id: 'amr-1',
        membershipId: 'm-1',
        appId: 'app-1',
        appName: 'demo-app',
        role: 'write',
        memberName: 'Jane Doe',
        memberEmail: 'jane@example.com',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
      },
    ];
    listAppRolesAction.mockResolvedValue({ ok: true, data: { data: rows } });

    const res = await GET(listReq(), routeCtx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(rows);
    expect(listAppRolesAction).toHaveBeenCalledWith({ appId: 'app-1', membershipId: undefined });
  });

  it('forwards the membershipId filter from the query string', async () => {
    listAppRolesAction.mockResolvedValue({ ok: true, data: { data: [] } });

    await GET(listReq('?membershipId=m-1'), routeCtx);

    expect(listAppRolesAction).toHaveBeenCalledWith({ appId: 'app-1', membershipId: 'm-1' });
  });

  it('maps the read helper reporting a query failure to 500, not a 200 with an error body', async () => {
    listAppRolesAction.mockResolvedValue({ ok: true, data: { error: 'connection reset' } });

    const res = await GET(listReq(), routeCtx);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'internal_error' } });
  });

  it('maps a permission denial to 403 forbidden', async () => {
    listAppRolesAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: app_member_role.read' },
    });

    const res = await GET(listReq(), routeCtx);

    expect(res.status).toBe(403);
  });
});

describe('POST /api/orgs/[orgName]/apps/[appId]/member-roles', () => {
  const body = { membershipId: 'm-1', role: 'write' as const };

  it('assigns a role and returns 201, threading the path appId into the action input', async () => {
    const created = { id: 'amr-1', membership_id: 'm-1', app_id: 'app-1', role: 'write', custom_role_id: null };
    assignAppRoleAction.mockResolvedValue({ ok: true, data: { success: true, data: created } });

    const res = await POST(postReq(body), routeCtx);

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(created);
    expect(assignAppRoleAction).toHaveBeenCalledWith({ appId: 'app-1', membershipId: 'm-1', role: 'write' });
  });

  it('fails closed with 403 when the app_level_roles entitlement is absent', async () => {
    assignAppRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'entitlement_denied', entitlement: { featureKey: 'app_level_roles' } },
    });

    const res = await POST(postReq(body), routeCtx);

    expect(res.status).toBe(403);
    const responseBody = await res.json();
    expect(responseBody.error.reason).toBe('entitlement_denied');
  });

  it('maps the owner-protection business rule to 400', async () => {
    assignAppRoleAction.mockResolvedValue({
      ok: true,
      data: { success: false, error: 'Cannot assign per-app roles to org owners' },
    });

    const res = await POST(postReq(body), routeCtx);

    expect(res.status).toBe(400);
  });

  it('rejects an invalid body with 400 before calling the action', async () => {
    const res = await POST(postReq({ membershipId: 'm-1', role: 'not-a-role' }), routeCtx);

    expect(res.status).toBe(400);
    expect(assignAppRoleAction).not.toHaveBeenCalled();
  });
});
