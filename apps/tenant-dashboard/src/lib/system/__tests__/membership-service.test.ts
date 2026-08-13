import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import { server } from '../../../test-helpers/msw-server';
import { MembershipService } from '../membership-service';

const serverLoggerErrorMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/observability/server-logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/observability/server-logger')>()),
  serverLogger: {
    error: serverLoggerErrorMock,
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));
import {
  seedMembershipMswState,
  getMembershipRpcCalls,
  seedSupabaseMswState,
  getInsertedAuditLogRows,
  getDeletedAuthUserIds,
} from '../../../test-helpers/msw-handlers';

// True seams (per testing rules): entitlement gating and the injected
// email / rate-limit services. Supabase stays real over MSW.
vi.mock('../entitlement-service', () => ({
  EntitlementService: vi.fn().mockImplementation(function () {
    return {
      checkLimit: vi.fn().mockResolvedValue({ allowed: true }),
      canAccess: vi.fn().mockResolvedValue(true),
    };
  }),
  buildDeniedInfo: vi.fn(),
}));

const TENANT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const TARGET_USER_ID = '11111111-1111-4111-a111-111111111111';
const MEMBERSHIP_ID = '22222222-2222-4222-a222-222222222222';

const adminUser = {
  id: 'admin-1',
  email: 'owner@example.com',
  app_metadata: { tenant_id: TENANT_ID, role: 'owner' },
} as unknown as User;

function buildService() {
  const client = () => createClient('http://localhost:54321', 'test-service-role-key');
  return new MembershipService({
    supabaseAdmin: client(),
    supabaseServer: client(),
    emailService: { sendEmail: vi.fn().mockResolvedValue({ error: null }) } as never,
    rateLimitService: { limit: vi.fn().mockResolvedValue({ success: true }) } as never,
    stripeService: {} as never,
  });
}

describe('MembershipService atomic audit RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedMembershipMswState({
      memberships: [
        { id: MEMBERSHIP_ID, user_id: TARGET_USER_ID, tenant_id: TENANT_ID, role: 'read', status: 'active', custom_role_id: null },
      ],
      tenants: [{ tenant_id: TENANT_ID, company_name: 'Acme', organization_name: 'Acme Org' }],
      rpcResults: {
        change_member_role_transaction: { membership_id: MEMBERSHIP_ID, before_role: 'read', after_role: 'write' },
        remove_member_transaction: { membership_id: MEMBERSHIP_ID, removed_role: 'read' },
        invite_existing_user_transaction: MEMBERSHIP_ID,
      },
    });
    seedSupabaseMswState({
      profiles: [{ id: TARGET_USER_ID, email: 'target@example.com', name: 'Target' } as never],
    });
  });

  it('changeUserRole delegates the mutation AND audit to the atomic RPC', async () => {
    const service = buildService();

    const result = await service.changeUserRole({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: 'write',
    });

    expect(result).toEqual({ success: true });
    expect(getMembershipRpcCalls()).toEqual([
      {
        fn: 'change_member_role_transaction',
        params: {
          p_tenant_id: TENANT_ID,
          p_target_user_id: TARGET_USER_ID,
          p_actor_id: 'admin-1',
          p_new_role: 'write',
          p_custom_role_id: null,
          p_ip_address: null,
          p_user_agent: null,
          p_request_id: null,
        },
      },
    ]);
    // The audit row is written INSIDE the transaction, never app-side
    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  it('changeUserRole with a custom role sends the custom role id and no built-in role', async () => {
    const service = buildService();

    // The UI sends the 'read' built-in fallback alongside customRoleId; the
    // transaction ignores it (p_new_role null) and pins the fallback itself.
    await service.changeUserRole({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: 'read',
      customRoleId: 'crole-7',
    });

    expect(getMembershipRpcCalls()).toEqual([
      expect.objectContaining({
        fn: 'change_member_role_transaction',
        params: expect.objectContaining({ p_new_role: null, p_custom_role_id: 'crole-7' }),
      }),
    ]);
  });

  it('changeUserRole surfaces RPC failure as an error result', async () => {
    seedMembershipMswState({ forceRpcError: { fn: 'change_member_role_transaction', message: 'member_not_found' } });
    const service = buildService();

    const result = await service.changeUserRole({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: 'write',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('member_not_found');
  });

  it('removeUserFromOrg delegates the delete AND audit to the atomic RPC', async () => {
    const service = buildService();

    const result = await service.removeUserFromOrg({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
    expect(getMembershipRpcCalls()).toEqual([
      {
        fn: 'remove_member_transaction',
        params: {
          p_tenant_id: TENANT_ID,
          p_target_user_id: TARGET_USER_ID,
          p_actor_id: 'admin-1',
          p_ip_address: null,
          p_user_agent: null,
          p_request_id: null,
        },
      },
    ]);
    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  // proves AC-077-02
  it('sendInvite (existing user) passes actor and context into the invite transaction', async () => {
    // The target has no membership yet in this flow
    seedMembershipMswState({ memberships: [] });
    const service = buildService();

    const result = await service.sendInvite({
      adminUser,
      tenantId: TENANT_ID,
      name: 'Target',
      email: 'target@example.com',
      role: 'read',
      origin: 'http://localhost:3000',
    });

    expect(result).toEqual({ success: true, membershipId: MEMBERSHIP_ID });
    expect(getMembershipRpcCalls()).toEqual([
      {
        fn: 'invite_existing_user_transaction',
        params: {
          p_user_id: TARGET_USER_ID,
          p_tenant_id: TENANT_ID,
          p_invited_by: 'admin-1',
          p_role: 'read',
          p_invited_at: expect.any(String),
          p_expires_at: expect.any(String),
          p_ip_address: null,
          p_user_agent: null,
          p_request_id: null,
        },
      },
    ]);
    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  // proves AC-077-04
  it('sendInvite rejects an email that already has an active membership', async () => {
    seedMembershipMswState({
      memberships: [
        { id: MEMBERSHIP_ID, user_id: TARGET_USER_ID, tenant_id: TENANT_ID, role: 'write', status: 'active', custom_role_id: null },
      ],
    });
    const service = buildService();

    const result = await service.sendInvite({
      adminUser,
      tenantId: TENANT_ID,
      name: 'Target',
      email: 'target@example.com',
      role: 'read',
      origin: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'User is already a member of this organization',
    });
    // No membership row or invite transaction is attempted for an
    // already-active member.
    expect(getMembershipRpcCalls()).toEqual([]);
  });

  it('sendInvite reports a previously-disabled member distinctly from an active one', async () => {
    seedMembershipMswState({
      memberships: [
        { id: MEMBERSHIP_ID, user_id: TARGET_USER_ID, tenant_id: TENANT_ID, role: 'disabled', status: 'active', custom_role_id: null },
      ],
    });
    const service = buildService();

    const result = await service.sendInvite({
      adminUser,
      tenantId: TENANT_ID,
      name: 'Target',
      email: 'target@example.com',
      role: 'read',
      origin: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'This user was previously disabled in this organization',
    });
    expect(getMembershipRpcCalls()).toEqual([]);
  });

  // proves AC-077-09
  it('sendInvite (new user) deletes the just-provisioned auth account when the invite transaction fails', async () => {
    const NEW_USER_ID = '33333333-3333-4333-a333-333333333333';

    // No profile exists for this email — the new-user branch provisions one.
    seedSupabaseMswState({
      profiles: [],
      generatedAuthLinkUser: { id: NEW_USER_ID, hashedToken: 'new-user-token' },
    });
    seedMembershipMswState({
      memberships: [],
      forceRpcError: { fn: 'invite_new_user_transaction', message: 'transaction_failed' },
    });
    const service = buildService();

    const result = await service.sendInvite({
      adminUser,
      tenantId: TENANT_ID,
      name: 'New Person',
      email: 'newperson@example.com',
      role: 'read',
      origin: 'http://localhost:3000',
    });

    expect(result).toEqual({ success: false, error: 'transaction_failed' });
    // The auth account created via generateLink is cleaned up rather than
    // left orphaned once the membership transaction fails.
    expect(getDeletedAuthUserIds()).toEqual([NEW_USER_ID]);
    expect(getMembershipRpcCalls()).toEqual([
      expect.objectContaining({
        fn: 'invite_new_user_transaction',
        params: expect.objectContaining({ p_user_id: NEW_USER_ID }),
      }),
    ]);
  });

  function seedFailedNewUserInvite(newUserId: string) {
    seedSupabaseMswState({
      profiles: [],
      generatedAuthLinkUser: { id: newUserId, hashedToken: 'new-user-token' },
    });
    seedMembershipMswState({
      memberships: [],
      forceRpcError: { fn: 'invite_new_user_transaction', message: 'transaction_failed' },
    });
  }

  function sendFailingInvite() {
    return buildService().sendInvite({
      adminUser,
      tenantId: TENANT_ID,
      name: 'New Person',
      email: 'newperson@example.com',
      role: 'read',
      origin: 'http://localhost:3000',
    });
  }

  it('cleanup stops after ONE attempt when the auth user is already gone (404) — no retries, no orphan report', async () => {
    seedFailedNewUserInvite('44444444-4444-4444-a444-444444444444');
    let attempts = 0;
    server.use(
      http.delete('http://localhost:54321/auth/v1/admin/users/:id', () => {
        attempts += 1;
        return HttpResponse.json({ message: 'User not found' }, { status: 404 });
      }),
    );

    const result = await sendFailingInvite();

    expect(result).toEqual({ success: false, error: 'transaction_failed' });
    // 404 IS the desired end state (the user is gone); retrying it would
    // only stall the invite response, and it is not an orphan to page on.
    expect(attempts).toBe(1);
    expect(serverLoggerErrorMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('orphaned auth user') }),
      expect.anything(),
    );
  });

  it('cleanup retries a persistently failing delete and reports the orphan through the monitored logger', async () => {
    seedFailedNewUserInvite('55555555-5555-4555-a555-555555555555');
    let attempts = 0;
    server.use(
      http.delete('http://localhost:54321/auth/v1/admin/users/:id', () => {
        attempts += 1;
        return HttpResponse.json({ message: 'boom' }, { status: 500 });
      }),
    );

    const result = await sendFailingInvite();

    expect(result).toEqual({ success: false, error: 'transaction_failed' });
    // auth-js RETURNS HTTP failures rather than throwing — each returned
    // error must count as a failed attempt, and the terminal miss must
    // reach the monitored stream (an orphaned auth account is operator debt).
    expect(attempts).toBe(3);
    expect(serverLoggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Failed to cleanup orphaned auth user after 3 attempts'),
      }),
      expect.objectContaining({ userId: '55555555-5555-4555-a555-555555555555' }),
    );
  });

  it('cleanup recovers when a transient delete failure clears on retry', async () => {
    seedFailedNewUserInvite('66666666-6666-4666-a666-666666666666');
    let attempts = 0;
    server.use(
      http.delete('http://localhost:54321/auth/v1/admin/users/:id', () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ message: 'flaky' }, { status: 500 });
        }
        return HttpResponse.json({});
      }),
    );

    const result = await sendFailingInvite();

    expect(result).toEqual({ success: false, error: 'transaction_failed' });
    expect(attempts).toBe(2);
    expect(serverLoggerErrorMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('orphaned auth user') }),
      expect.anything(),
    );
  });
});
