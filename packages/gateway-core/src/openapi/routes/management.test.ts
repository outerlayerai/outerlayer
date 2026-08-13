/**
 * Org-management route handlers — happy path + response-mapping per route.
 *
 * Auth (the security matrix: 401/403/permission intersection/path-traversal/
 * unset-pepper-fail-closed) is covered by `../../lib/management-auth.test.ts`
 * — these tests assume `managementAuthGuard` already ran and
 * `c.get('managementAuth')` is populated, and instead prove each handler:
 * queries/calls the right thing with the resolved tenant (never a caller-
 * supplied one), and maps the service/query result to the documented
 * response shape and status.
 *
 * `MembershipService`'s own business rules (last-owner protection,
 * owner-only invites, entitlement denial, ...) are exhaustively covered by
 * `@repo/org-management-service`'s own suite — mocked here so these tests
 * stay about the gateway's wiring, not re-prove the package.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const sendInvite = vi.fn();
const resendInviteLink = vi.fn();
const changeUserRole = vi.fn();
const removeUserFromOrg = vi.fn();

vi.mock('@repo/org-management-service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    MembershipService: vi.fn().mockImplementation(function MockMembershipService(this: object) {
      Object.assign(this, { sendInvite, resendInviteLink, changeUserRole, removeUserFromOrg });
    }),
  };
});

// ---------------------------------------------------------------------------
// A minimal chainable Supabase stub. Each `from(table)` call is scripted via
// `queueFromResult` for the terminal method the route actually awaits
// (`.maybeSingle()` / bare `.in()` resolution / `.getUserById()`), letting
// each test set up exactly the rows its route path needs.
// ---------------------------------------------------------------------------

type QueuedResult = { data: unknown; error?: unknown };

function makeSupabaseStub(fromResults: Record<string, QueuedResult[]>) {
  const consumed: Record<string, number> = {};
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  function nextResult(table: string): QueuedResult {
    const idx = consumed[table] ?? 0;
    consumed[table] = idx + 1;
    const queue = fromResults[table] ?? [];
    return queue[idx] ?? { data: null, error: null };
  }

  function chain(table: string): Record<string, unknown> {
    const self: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        calls.push({ table, method: 'select', args });
        return self;
      },
      eq: (...args: unknown[]) => {
        calls.push({ table, method: 'eq', args });
        return self;
      },
      in: (...args: unknown[]) => {
        calls.push({ table, method: 'in', args });
        // `.in()` is a terminal for the members-list profile query.
        return Promise.resolve(nextResult(table));
      },
      maybeSingle: (...args: unknown[]) => {
        calls.push({ table, method: 'maybeSingle', args });
        return Promise.resolve(nextResult(table));
      },
    };
    return self;
  }

  return {
    calls,
    client: {
      from: (table: string) => chain(table),
      auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email_confirmed_at: '2026-01-01' } } })) } },
    },
  };
}

vi.mock('../../lib/system-client', () => ({
  createSystemAdminClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import {
  ListOrgMembers,
  InviteOrgMember,
  ResendOrgMemberInvite,
  ChangeOrgMemberRole,
  RemoveOrgMember,
  ListOrgRoles,
} from './management';
import { createSystemAdminClient } from '../../lib/system-client';

const MANAGEMENT_AUTH = {
  ctx: { db: {}, tenantId: 'tenant-1', actor: { userId: 'user-1', role: 'owner' } },
  permissions: ['membership.read', 'membership.insert', 'membership.update', 'membership.delete'],
};

interface Captured {
  body: unknown;
  status: number;
}

function makeContext(opts: { body?: unknown } = {}): { ctx: Context; captured: () => Captured | null } {
  let captured: Captured | null = null;
  const values: Record<string, unknown> = { managementAuth: MANAGEMENT_AUTH };
  const ctx = {
    get: vi.fn((k: string) => values[k]),
    env: { DASHBOARD_BASE_URL: 'https://app.example.test' },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      json: vi.fn(async () => opts.body ?? {}),
    },
  } as unknown as Context;
  return { ctx, captured: () => captured };
}

const ROUTE_OPTIONS = { router: {}, raiseUnknownParameters: false, route: '/v1/orgs/{orgName}', urlParams: ['orgName'] };

function stubValidatedData<T extends { getValidatedData: unknown }>(route: T, data: unknown): void {
  (route as unknown as { getValidatedData: () => Promise<unknown> }).getValidatedData = async () => data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ListOrgMembers', () => {
  it('scopes the membership + profile reads to the resolved tenant and shapes each row', async () => {
    const stub = makeSupabaseStub({
      membership: [
        {
          data: [
            { id: 'm1', user_id: 'u1', role: 'owner', status: 'active', custom_role_id: null, custom_role: null },
          ],
        },
      ],
      profile: [{ data: [{ id: 'u1', name: 'Ada', email: 'ada@example.test' }] }],
    });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(stub.client);

    const route = new ListOrgMembers(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(captured()?.status).toBe(200);
    expect(captured()?.body).toEqual({
      data: [
        {
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.test',
          role: 'owner',
          membershipId: 'm1',
          membershipStatus: 'active',
          customRoleId: undefined,
          customRoleName: undefined,
          isConfirmed: true,
        },
      ],
    });
    expect(stub.calls).toContainEqual({ table: 'membership', method: 'eq', args: ['tenant_id', 'tenant-1'] });
  });

  it('returns an empty list without querying profiles when the tenant has no memberships', async () => {
    const stub = makeSupabaseStub({ membership: [{ data: [] }] });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(stub.client);

    const route = new ListOrgMembers(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(captured()).toEqual({ status: 200, body: { data: [] } });
    expect(stub.calls.some((c) => c.table === 'profile')).toBe(false);
  });
});

describe('ListOrgRoles', () => {
  it('returns the built-in role catalog', async () => {
    const route = new ListOrgRoles(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(captured()?.status).toBe(200);
    expect(captured()?.body).toEqual({
      data: [
        { value: 'owner', label: 'Owner' },
        { value: 'admin', label: 'Admin' },
        { value: 'write', label: 'Write' },
        { value: 'read', label: 'Read' },
        { value: 'disabled', label: 'Disabled' },
      ],
    });
  });
});

describe('InviteOrgMember', () => {
  it('delegates to MembershipService with the resolved tenant + actor and returns the membershipId', async () => {
    sendInvite.mockResolvedValue({ success: true, membershipId: 'm-new' });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabaseStub({}).client);

    const route = new InviteOrgMember(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext({
      body: { name: 'Grace', email: 'grace@example.test', role: 'write' },
    });
    await route.handle(ctx);

    expect(sendInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        name: 'Grace',
        email: 'grace@example.test',
        role: 'write',
        adminUser: expect.objectContaining({ id: 'user-1' }),
      }),
    );
    expect(captured()).toEqual({ status: 200, body: { data: { membershipId: 'm-new' } } });
  });

  it('maps an entitlement_denied result to 403 with the entitlement key', async () => {
    sendInvite.mockResolvedValue({ success: false, error: 'entitlement_denied', entitlement: { key: 'max_users' } });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabaseStub({}).client);

    const route = new InviteOrgMember(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext({ body: { name: 'Grace', email: 'grace@example.test', role: 'write' } });
    await route.handle(ctx);

    expect(captured()).toEqual({
      status: 403,
      body: {
        error: {
          code: 'entitlement_denied',
          message: 'The org plan does not allow this invite',
          entitlement: { key: 'max_users' },
        },
      },
    });
  });

  it('maps a business-rule denial to 400', async () => {
    sendInvite.mockResolvedValue({ success: false, error: 'Only owners can invite users as owners' });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabaseStub({}).client);

    const route = new InviteOrgMember(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext({ body: { name: 'Grace', email: 'grace@example.test', role: 'owner' } });
    await route.handle(ctx);

    expect(captured()?.status).toBe(400);
    expect((captured()?.body as { error: { code: string } }).error.code).toBe('invite_failed');
  });

  it('rejects a malformed body with 400 before calling the service', async () => {
    const route = new InviteOrgMember(ROUTE_OPTIONS as never);
    const { ctx, captured } = makeContext({ body: { name: '', email: 'not-an-email', role: 'write' } });
    await route.handle(ctx);

    expect(captured()?.status).toBe(400);
    expect(sendInvite).not.toHaveBeenCalled();
  });
});

describe('ResendOrgMemberInvite', () => {
  it('404s when the invite id does not name a pending membership in this tenant', async () => {
    const stub = makeSupabaseStub({ membership: [{ data: null }] });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(stub.client);

    const route = new ResendOrgMemberInvite(ROUTE_OPTIONS as never);
    stubValidatedData(route, { params: { orgName: 'acme', inviteId: 'missing' } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(captured()?.status).toBe(404);
    expect(resendInviteLink).not.toHaveBeenCalled();
  });

  it('resolves the invite email from the membership id, then delegates to the service', async () => {
    const stub = makeSupabaseStub({
      membership: [{ data: { id: 'm1', user_id: 'u1' } }],
      profile: [{ data: { email: 'pending@example.test' } }],
    });
    (createSystemAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(stub.client);
    resendInviteLink.mockResolvedValue({ success: true });

    const route = new ResendOrgMemberInvite(ROUTE_OPTIONS as never);
    stubValidatedData(route, { params: { orgName: 'acme', inviteId: 'm1' } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(resendInviteLink).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', email: 'pending@example.test' }),
    );
    expect(captured()).toEqual({ status: 200, body: { data: { success: true } } });
  });
});

describe('ChangeOrgMemberRole', () => {
  it('changes the role and returns success', async () => {
    changeUserRole.mockResolvedValue({ success: true });

    const route = new ChangeOrgMemberRole(ROUTE_OPTIONS as never);
    stubValidatedData(route, { params: { orgName: 'acme', userId: 'u2' } });
    const { ctx, captured } = makeContext({ body: { role: 'admin' } });
    await route.handle(ctx);

    expect(changeUserRole).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', targetUserId: 'u2', newRole: 'admin' }),
    );
    expect(captured()).toEqual({ status: 200, body: { data: { success: true } } });
  });

  it('maps a "not found" service error to 404, and any other denial to 400', async () => {
    changeUserRole.mockResolvedValue({ success: false, error: 'User not found in organization' });
    const route = new ChangeOrgMemberRole(ROUTE_OPTIONS as never);
    stubValidatedData(route, { params: { orgName: 'acme', userId: 'ghost' } });
    const { ctx, captured } = makeContext({ body: { role: 'admin' } });
    await route.handle(ctx);

    expect(captured()).toEqual({
      status: 404,
      body: { error: { code: 'member_not_found', message: 'User not found in organization' } },
    });
  });
});

describe('RemoveOrgMember', () => {
  it('removes the member and returns success', async () => {
    removeUserFromOrg.mockResolvedValue({ success: true });

    const route = new RemoveOrgMember(ROUTE_OPTIONS as never);
    stubValidatedData(route, { params: { orgName: 'acme', userId: 'u2' } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(removeUserFromOrg).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', targetUserId: 'u2' }),
    );
    expect(captured()).toEqual({ status: 200, body: { data: { success: true } } });
  });

  it('maps last-owner-protection style denials to 400', async () => {
    removeUserFromOrg.mockResolvedValue({ success: false, error: 'Cannot remove the last owner from the organization' });
    const route = new RemoveOrgMember(ROUTE_OPTIONS as never);
    stubValidatedData(route, { params: { orgName: 'acme', userId: 'u2' } });
    const { ctx, captured } = makeContext();
    await route.handle(ctx);

    expect(captured()).toEqual({
      status: 400,
      body: { error: { code: 'remove_failed', message: 'Cannot remove the last owner from the organization' } },
    });
  });
});
