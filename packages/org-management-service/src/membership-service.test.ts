/**
 * Unit tests for MembershipService. Supabase and every injected dependency
 * are stubbed directly (constructor DI) — this package has no MSW/Postgrest
 * fixture harness of its own.
 */
import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { User } from '@supabase/supabase-js';
import { MembershipService, type MembershipServiceConfig } from './membership-service';
import { MembershipRoleEnum } from './types';
import type { EntitlementGate } from './types';

const UNLIMITED = -1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminUser(overrides: Partial<User> = {}): User {
  return {
    id: 'admin-user-id',
    app_metadata: {
      tenant_id: 'tenant-123',
      role: MembershipRoleEnum.ADMIN,
    },
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as User;
}

/** Builds a minimal Supabase stub for the membership count query */
function stubSupabaseAdmin(activeUserCount: number) {
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    neq: vi.fn().mockResolvedValue({
      count: activeUserCount,
      data: null,
      error: null,
    }),
    // The table-driven owner gate reads the actor's role from their membership;
    // a non-owner keeps the "only owners can invite as owners" rejection.
    maybeSingle: vi.fn().mockResolvedValue({
      data: { role: MembershipRoleEnum.ADMIN },
      error: null,
    }),
  };

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'membership') {
      return { select: vi.fn().mockReturnValue(selectChain) };
    }
    if (table === 'tenant') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { company_name: 'Acme Corp' },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'profile') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      };
    }
    return {};
  });

  return { from } as unknown as MembershipServiceConfig['supabaseAdmin'];
}

function stubSupabaseServer() {
  return {} as unknown as MembershipServiceConfig['supabaseServer'];
}

function stubEmailService() {
  return {
    sendEmail: vi.fn().mockResolvedValue({ error: null }),
  } as unknown as MembershipServiceConfig['emailService'];
}

function stubRateLimitService(allowed = true) {
  return {
    limit: vi.fn().mockResolvedValue({ success: allowed }),
  } as unknown as MembershipServiceConfig['rateLimitService'];
}

function stubStripeService() {
  return {} as unknown as MembershipServiceConfig['stripeService'];
}

function stubEntitlements(overrides: Partial<EntitlementGate> = {}): EntitlementGate {
  return {
    checkLimit: vi.fn().mockResolvedValue({ allowed: true, limit: UNLIMITED, currentCount: 0 }),
    canAccess: vi.fn().mockResolvedValue(true),
    buildDeniedInfo: vi.fn().mockImplementation((key: string, result?: unknown) => ({
      featureKey: key,
      featureDisplayName: 'Team Members',
      requiredTier: 'growth',
      requiredTierDisplayName: 'Growth',
      isSelfServe: true,
      pricing: '$24/user/month',
      upgradeUrl: '/settings/billing',
      currentLimit: (result as { limit?: number })?.limit ?? null,
      requiredTierLimit: 25,
    })),
    ...overrides,
  };
}

function stubAuditLog() {
  return { create: vi.fn().mockResolvedValue(undefined) } as unknown as MembershipServiceConfig['auditLog'];
}

function stubAppRoleAssigner() {
  return {
    bulkAssign: vi.fn().mockResolvedValue({ success: true, data: { errors: [] } }),
  } as unknown as MembershipServiceConfig['appRoleAssigner'];
}

function stubLogger() {
  return { error: vi.fn().mockResolvedValue(undefined) } as unknown as MembershipServiceConfig['logger'];
}

function buildService(overrides: Partial<MembershipServiceConfig> = {}) {
  return new MembershipService({
    supabaseAdmin: stubSupabaseAdmin(0),
    supabaseServer: stubSupabaseServer(),
    emailService: stubEmailService(),
    rateLimitService: stubRateLimitService(),
    stripeService: stubStripeService(),
    entitlements: stubEntitlements(),
    auditLog: stubAuditLog(),
    getRequestContext: vi.fn().mockResolvedValue({ ipAddress: null, userAgent: null, requestId: null }),
    logger: stubLogger(),
    appRoleAssigner: stubAppRoleAssigner(),
    appUrl: 'http://localhost:3002',
    ...overrides,
  });
}

type AdminInviteStub = MembershipServiceConfig['supabaseAdmin'] & {
  auth: {
    admin: {
      generateLink: ReturnType<typeof vi.fn>;
    };
  };
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
};

function stubSupabaseServerWithNoProfile(): MembershipServiceConfig['supabaseServer'] {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  } as unknown as MembershipServiceConfig['supabaseServer'];
}

function wireNewUserInviteFlow(
  supabaseAdmin: MembershipServiceConfig['supabaseAdmin'],
  membershipId: string,
  hashedToken: string,
) {
  const client = supabaseAdmin as unknown as AdminInviteStub;

  client.auth = {
    admin: {
      generateLink: vi.fn().mockResolvedValue({
        data: {
          user: { id: 'new-user-id' },
          properties: { hashed_token: hashedToken },
        },
        error: null,
      }),
    },
  } as AdminInviteStub['auth'];

  client.rpc = vi.fn().mockResolvedValue({
    data: membershipId,
    error: null,
  });

  const originalFrom = client.from;
  client.from = vi.fn().mockImplementation((table: string) => {
    if (table === 'billing') {
      return {
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: null,
          }),
        }),
      };
    }
    return originalFrom(table);
  });

  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembershipService.sendInvite()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseParams = {
    adminUser: makeAdminUser(),
    tenantId: 'tenant-123',
    name: 'Jane Doe',
    email: 'jane@example.com',
    role: MembershipRoleEnum.WRITE,
    origin: 'https://app.example.com',
  };

  // ── Entitlement: allowed ────────────────────────────────────────────

  describe('when entitlement check allows the invite', () => {
    it('should proceed past the entitlement gate (new user flow)', async () => {
      const supabaseAdmin = stubSupabaseAdmin(3);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-1', 'abc123');

      const checkLimit = vi.fn().mockResolvedValue({ allowed: true, limit: 25, currentCount: 3 });
      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService,
        entitlements: stubEntitlements({ checkLimit }),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.membershipId).toBe('membership-id-1');
      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 3);
    });

    it('should allow when limit is unlimited', async () => {
      const supabaseAdmin = stubSupabaseAdmin(999);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-2', 'abc123');

      const checkLimit = vi.fn().mockResolvedValue({ allowed: true, limit: UNLIMITED, currentCount: 999 });
      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService,
        entitlements: stubEntitlements({ checkLimit }),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 999);
    });

    it('should email new users an invite link that flags the invite flow for the password page', async () => {
      const supabaseAdmin = stubSupabaseAdmin(3);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-1', 'abc123');

      const checkLimit = vi.fn().mockResolvedValue({ allowed: true, limit: 25, currentCount: 3 });
      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService,
        entitlements: stubEntitlements({ checkLimit }),
      });

      await svc.sendInvite(baseParams);

      // `?flow=invite` must ride INSIDE the encoded `next` value — unencoded
      // it would parse as a param of /auth/confirm and the password page
      // would fall back to the confusing reset copy.
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jane@example.com',
          templateParams: expect.objectContaining({
            inviteLink:
              'https://app.example.com/auth/confirm?token_hash=abc123&type=invite&next=%2Fauth%2Fnew-password%3Fflow%3Dinvite',
          }),
        })
      );
    });

    it('should resend an unconfirmed user a fresh link with the same invite flow flag', async () => {
      const supabaseAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'profile') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi
                    .fn()
                    .mockResolvedValue({ data: { id: 'invited-user-id' }, error: null }),
                }),
              }),
            };
          }
          if (table === 'membership') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: { id: 'membership-id-1', status: 'pending' },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
        auth: {
          admin: {
            getUserById: vi
              .fn()
              .mockResolvedValue({ data: { user: { confirmed_at: null } } }),
            generateLink: vi.fn().mockResolvedValue({
              data: {
                user: { id: 'invited-user-id' },
                properties: { hashed_token: 'resend456' },
              },
              error: null,
            }),
          },
        },
      } as unknown as MembershipServiceConfig['supabaseAdmin'];

      const supabaseServer = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi
              .fn()
              .mockResolvedValue({ data: { company_name: 'Acme Corp' }, error: null }),
          }),
        }),
      } as unknown as MembershipServiceConfig['supabaseServer'];

      const emailService = stubEmailService();
      const svc = buildService({ supabaseAdmin, supabaseServer, emailService });

      const result = await svc.resendInviteLink({
        adminUser: makeAdminUser(),
        tenantId: 'tenant-123',
        email: 'jane@example.com',
        origin: 'https://app.example.com',
      });

      expect(result).toEqual({ success: true });
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'jane@example.com',
          templateParams: expect.objectContaining({
            inviteLink:
              'https://app.example.com/auth/confirm?token_hash=resend456&type=invite&next=%2Fauth%2Fnew-password%3Fflow%3Dinvite',
          }),
        })
      );
    });
  });

  // ── Entitlement: denied ─────────────────────────────────────────────

  describe('when entitlement check denies the invite', () => {
    it('should return entitlement_denied with denied info', async () => {
      const checkLimit = vi.fn().mockResolvedValue({
        allowed: false, limit: 1, currentCount: 1, requiredTier: 'growth', upgradeUrl: '/settings/billing',
      });

      const svc = buildService({ supabaseAdmin: stubSupabaseAdmin(1), entitlements: stubEntitlements({ checkLimit }) });
      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(false);
      expect(result.error).toBe('entitlement_denied');
      expect(result.entitlement!.featureKey).toBe('max_users');
      expect(result.entitlement!.requiredTier).toBe('growth');
      expect(result.entitlement!.upgradeUrl).toBe('/settings/billing');
    });

    it('should not proceed to tenant lookup when denied', async () => {
      const supabaseAdmin = stubSupabaseAdmin(5);
      const fromSpy = supabaseAdmin.from as Mock;

      const checkLimit = vi.fn().mockResolvedValue({
        allowed: false, limit: 5, currentCount: 5, requiredTier: 'growth', upgradeUrl: '/settings/billing',
      });

      const svc = buildService({ supabaseAdmin, entitlements: stubEntitlements({ checkLimit }) });
      await svc.sendInvite(baseParams);

      // membership table is queried for the count, but tenant should NOT be queried
      const tableCalls = fromSpy.mock.calls.map((c: string[]) => c[0]);
      expect(tableCalls).toContain('membership');
      expect(tableCalls).not.toContain('tenant');
      expect(tableCalls).not.toContain('profile');
    });

    it('should not send any emails when denied', async () => {
      const checkLimit = vi.fn().mockResolvedValue({ allowed: false, limit: 1, currentCount: 1, requiredTier: 'growth' });

      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin: stubSupabaseAdmin(1),
        emailService,
        entitlements: stubEntitlements({ checkLimit }),
      });

      await svc.sendInvite(baseParams);

      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('should pass the current active user count to checkLimit', async () => {
      const activeCount = 7;

      const checkLimit = vi.fn().mockResolvedValue({
        allowed: false, limit: 5, currentCount: activeCount, requiredTier: 'growth',
      });

      const svc = buildService({ supabaseAdmin: stubSupabaseAdmin(activeCount), entitlements: stubEntitlements({ checkLimit }) });
      await svc.sendInvite(baseParams);

      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', activeCount);
    });
  });

  // ── Entitlement gate vs earlier validations ─────────────────────────

  describe('validation ordering', () => {
    it('should reject invalid email before checking entitlements', async () => {
      const checkLimit = vi.fn();
      const svc = buildService({ entitlements: stubEntitlements({ checkLimit }) });
      const result = await svc.sendInvite({
        ...baseParams,
        email: 'not-an-email',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(checkLimit).not.toHaveBeenCalled();
    });

    it('should reject owner-invite-by-non-owner before checking entitlements', async () => {
      const checkLimit = vi.fn();
      const svc = buildService({ entitlements: stubEntitlements({ checkLimit }) });
      const result = await svc.sendInvite({
        ...baseParams,
        role: MembershipRoleEnum.OWNER,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Only owners can invite users as owners');
      expect(checkLimit).not.toHaveBeenCalled();
    });

    it('should reject rate-limited requests before checking entitlements', async () => {
      const checkLimit = vi.fn();
      const svc = buildService({
        rateLimitService: stubRateLimitService(false),
        entitlements: stubEntitlements({ checkLimit }),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain('recently sent');
      expect(checkLimit).not.toHaveBeenCalled();
    });
  });

  // ── Tier-based max_users enforcement ─────────────────────────────────

  describe('max_users tier enforcement', () => {
    /**
     * Hobby tier: limit=2. When userCount=2 the tenant is AT the limit.
     * checkLimit uses `currentCount < limit`, so count=2 with limit=2 is NOT allowed.
     */
    it('should block invite when hobby tier is at the 2-user limit', async () => {
      const checkLimit = vi.fn().mockResolvedValue({
        allowed: false, limit: 2, currentCount: 2, requiredTier: 'growth', upgradeUrl: '/settings/billing',
      });

      const svc = buildService({ supabaseAdmin: stubSupabaseAdmin(2), entitlements: stubEntitlements({ checkLimit }) });
      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(false);
      expect(result.error).toBe('entitlement_denied');
      expect(result.entitlement!.featureKey).toBe('max_users');
      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 2);
    });

    /**
     * Hobby tier: limit=2. When userCount=1 the tenant is below the limit.
     * The invite should proceed (past the entitlement gate).
     */
    it('should allow invite when hobby tier has one slot remaining (userCount=1, limit=2)', async () => {
      const checkLimit = vi.fn().mockResolvedValue({ allowed: true, limit: 2, currentCount: 1 });

      // Wire up the full new-user invite flow so the service can complete
      const supabaseAdmin = stubSupabaseAdmin(1);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-hobby', 'tok-abc');

      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService: stubEmailService(),
        entitlements: stubEntitlements({ checkLimit }),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 1);
    });

    /**
     * Growth tier: limit=-1 (UNLIMITED). Even with 999 active users, invite is allowed.
     */
    it('should always allow invite when growth tier has unlimited users (limit=-1)', async () => {
      const checkLimit = vi.fn().mockResolvedValue({ allowed: true, limit: UNLIMITED, currentCount: 999 });

      const supabaseAdmin = stubSupabaseAdmin(999);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-growth', 'tok-growth');

      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService: stubEmailService(),
        entitlements: stubEntitlements({ checkLimit }),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 999);
    });

    /**
     * Exactly at the limit (count === limit): must be blocked, not one-over.
     * This verifies the `currentCount < limit` semantics (strict less-than).
     */
    it('should block at exactly the limit and allow at one below', async () => {
      // At limit: blocked
      const blockedCheckLimit = vi.fn().mockResolvedValue({
        allowed: false, limit: 5, currentCount: 5, requiredTier: 'growth',
      });

      const blocked = await buildService({
        supabaseAdmin: stubSupabaseAdmin(5),
        entitlements: stubEntitlements({ checkLimit: blockedCheckLimit }),
      }).sendInvite(baseParams);

      expect(blocked.success).toBe(false);
      expect(blocked.error).toBe('entitlement_denied');

      // One below limit: allowed (requires full invite flow wiring)
      const allowedCheckLimit = vi.fn().mockResolvedValue({ allowed: true, limit: 5, currentCount: 4 });

      const supabaseAdmin = stubSupabaseAdmin(4);
      wireNewUserInviteFlow(supabaseAdmin, 'mid', 'tok');

      const allowed = await buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService: stubEmailService(),
        entitlements: stubEntitlements({ checkLimit: allowedCheckLimit }),
      }).sendInvite(baseParams);

      expect(allowed.success).toBe(true);
    });

    /**
     * When the membership count query returns null (DB error or empty), the service
     * uses `userCount ?? 0` as a fallback. The entitlement check is still called with 0.
     */
    it('should use 0 as fallback userCount when membership query returns null count', async () => {
      const supabaseAdmin = (() => {
        const selectChain = {
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          neq: vi.fn().mockResolvedValue({
            count: null, // <-- simulate null count
            data: null,
            error: null,
          }),
        };
        const from = vi.fn().mockImplementation((table: string) => {
          if (table === 'membership') {
            return { select: vi.fn().mockReturnValue(selectChain) };
          }
          if (table === 'tenant') {
            return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { company_name: 'Acme' }, error: null }) }) }) };
          }
          if (table === 'profile') {
            return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) };
          }
          return {};
        });
        return { from } as unknown as MembershipServiceConfig['supabaseAdmin'];
      })();

      const checkLimit = vi.fn().mockResolvedValue({ allowed: false, limit: 2, currentCount: 0, requiredTier: 'growth' });

      const svc = buildService({ supabaseAdmin, entitlements: stubEntitlements({ checkLimit }) });
      await svc.sendInvite(baseParams);

      // Verify the service falls back to 0 (not null) when count is null
      expect(checkLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Atomic-RPC delegation: the mutation and its audit row commit or roll back
// together inside the transaction functions, never as a separate app-side
// write. `auditLog.create` must stay uncalled for these three flows.
// ---------------------------------------------------------------------------

describe('MembershipService atomic audit RPCs', () => {
  const TENANT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
  const TARGET_USER_ID = '11111111-1111-4111-a111-111111111111';
  const MEMBERSHIP_ID = '22222222-2222-4222-a222-222222222222';

  const adminUser = {
    id: 'admin-1',
    email: 'owner@example.com',
    app_metadata: { tenant_id: TENANT_ID, role: 'owner' },
  } as unknown as User;

  function stubAdminForRpc(opts: {
    rpcResults: Record<string, unknown>;
    membership?: { id: string; role: string; status: string; custom_role_id?: string | null } | null;
    rpcErrors?: Record<string, string>;
  }) {
    const rpc = vi.fn().mockImplementation((fn: string, _args: unknown) => {
      if (opts.rpcErrors?.[fn]) {
        return Promise.resolve({ data: null, error: { message: opts.rpcErrors[fn] } });
      }
      return Promise.resolve({ data: opts.rpcResults[fn], error: null });
    });

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'membership') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          single: () => Promise.resolve({ data: opts.membership ?? null, error: opts.membership ? null : { message: 'not found' } }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'profile') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { email: 'target@example.com' }, error: null }) }),
          }),
        };
      }
      if (table === 'tenant') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { organization_name: 'Acme Org', company_name: 'Acme' }, error: null }) }),
          }),
        };
      }
      return {};
    });

    return { from, rpc } as unknown as MembershipServiceConfig['supabaseAdmin'];
  }

  it('changeUserRole delegates the mutation AND audit to the atomic RPC', async () => {
    const supabaseAdmin = stubAdminForRpc({
      rpcResults: { change_member_role_transaction: { membership_id: MEMBERSHIP_ID, before_role: 'read', after_role: 'write' } },
      membership: { id: MEMBERSHIP_ID, role: 'read', status: 'active', custom_role_id: null },
    });
    const auditLog = stubAuditLog();
    const service = buildService({ supabaseAdmin, auditLog });

    const result = await service.changeUserRole({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: 'write',
    });

    expect(result).toEqual({ success: true });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith('change_member_role_transaction', {
      p_tenant_id: TENANT_ID,
      p_target_user_id: TARGET_USER_ID,
      p_actor_id: 'admin-1',
      p_new_role: 'write',
      p_custom_role_id: null,
      p_ip_address: null,
      p_user_agent: null,
      p_request_id: null,
    });
    // The audit row is written INSIDE the transaction, never app-side
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it('changeUserRole with a custom role sends the custom role id and no built-in role', async () => {
    const supabaseAdmin = stubAdminForRpc({
      rpcResults: { change_member_role_transaction: { membership_id: MEMBERSHIP_ID } },
      membership: { id: MEMBERSHIP_ID, role: 'write', status: 'active', custom_role_id: null },
    });
    const service = buildService({ supabaseAdmin });

    await service.changeUserRole({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: 'read',
      customRoleId: 'crole-7',
    });

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      'change_member_role_transaction',
      expect.objectContaining({ p_new_role: null, p_custom_role_id: 'crole-7' }),
    );
  });

  it('changeUserRole surfaces RPC failure as an error result', async () => {
    const supabaseAdmin = stubAdminForRpc({
      rpcResults: {},
      membership: { id: MEMBERSHIP_ID, role: 'read', status: 'active' },
      rpcErrors: { change_member_role_transaction: 'member_not_found' },
    });
    const service = buildService({ supabaseAdmin });

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
    const supabaseAdmin = stubAdminForRpc({
      rpcResults: { remove_member_transaction: { membership_id: MEMBERSHIP_ID, removed_role: 'read' } },
      membership: { id: MEMBERSHIP_ID, role: 'read', status: 'active' },
    });
    const auditLog = stubAuditLog();
    const service = buildService({ supabaseAdmin, auditLog });

    const result = await service.removeUserFromOrg({
      adminUser,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith('remove_member_transaction', {
      p_tenant_id: TENANT_ID,
      p_target_user_id: TARGET_USER_ID,
      p_actor_id: 'admin-1',
      p_ip_address: null,
      p_user_agent: null,
      p_request_id: null,
    });
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it('sendInvite (existing user) passes actor and context into the invite transaction', async () => {
    const supabaseAdmin = stubAdminForRpc({
      rpcResults: { invite_existing_user_transaction: MEMBERSHIP_ID },
      membership: null,
    });
    // sendInvite queries `profile` first to route to the existing-user flow.
    supabaseAdmin.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'profile') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: TARGET_USER_ID }, error: null }) }) }) };
      }
      if (table === 'membership') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          neq: () => Promise.resolve({ count: 0, data: null, error: null }),
          single: () => Promise.resolve({ data: null, error: { message: 'not found' } }),
        };
        return chain;
      }
      if (table === 'tenant') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { company_name: 'Acme' }, error: null }) }) }) };
      }
      return {};
    }) as Mock;
    const auditLog = stubAuditLog();
    const service = buildService({ supabaseAdmin, auditLog });

    const result = await service.sendInvite({
      adminUser,
      tenantId: TENANT_ID,
      name: 'Target',
      email: 'target@example.com',
      role: 'read',
      origin: 'http://localhost:3000',
    });

    expect(result).toEqual({ success: true, membershipId: MEMBERSHIP_ID });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith('invite_existing_user_transaction', {
      p_user_id: TARGET_USER_ID,
      p_tenant_id: TENANT_ID,
      p_invited_by: 'admin-1',
      p_role: 'read',
      p_invited_at: expect.any(String),
      p_expires_at: expect.any(String),
      p_ip_address: null,
      p_user_agent: null,
      p_request_id: null,
    });
    expect(auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendInvite: tenant lookup + rate-limit guard edge cases
// ---------------------------------------------------------------------------

describe('MembershipService.sendInvite() tenant lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseParams = {
    adminUser: makeAdminUser(),
    tenantId: 'tenant-123',
    name: 'Jane Doe',
    email: 'jane@example.com',
    role: MembershipRoleEnum.WRITE,
    origin: 'https://app.example.com',
  };

  it('surfaces the tenant lookup error message when present', async () => {
    const supabaseAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'membership') {
          return {
            select: () => ({
              eq: () => ({ in: () => ({ neq: () => Promise.resolve({ count: 0, data: null, error: null }) }) }),
            }),
          };
        }
        if (table === 'tenant') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: null, error: { message: 'tenant lookup failed' } }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as MembershipServiceConfig['supabaseAdmin'];
    const svc = buildService({ supabaseAdmin });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({ success: false, error: 'tenant lookup failed' });
  });

  it('falls back to "Tenant not found" when the tenant lookup has no error but no data', async () => {
    const supabaseAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'membership') {
          return {
            select: () => ({
              eq: () => ({ in: () => ({ neq: () => Promise.resolve({ count: 0, data: null, error: null }) }) }),
            }),
          };
        }
        if (table === 'tenant') {
          return {
            select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
          };
        }
        return {};
      }),
    } as unknown as MembershipServiceConfig['supabaseAdmin'];
    const svc = buildService({ supabaseAdmin });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({ success: false, error: 'Tenant not found' });
  });
});

describe('MembershipService.resendInviteLink() rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects rate-limited resend requests with the exact throttling message', async () => {
    const svc = buildService({ rateLimitService: stubRateLimitService(false) });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: 'tenant-123',
      email: 'jane@example.com',
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({
      success: false,
      error: 'An email was just recently sent. Please wait longer before trying to send another email',
    });
  });
});

// ---------------------------------------------------------------------------
// sendInvite: per-app role assignment (the post-invite `appRoles` branch)
// ---------------------------------------------------------------------------

describe('MembershipService.sendInvite() app-level role assignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const paramsWithAppRoles = {
    adminUser: makeAdminUser(),
    tenantId: 'tenant-123',
    name: 'Jane Doe',
    email: 'jane@example.com',
    role: MembershipRoleEnum.WRITE,
    origin: 'https://app.example.com',
    appRoles: [{ appId: 'app-1', role: 'write' as const }],
  };

  function buildInvitedService(overrides: Partial<MembershipServiceConfig> = {}) {
    const supabaseAdmin = stubSupabaseAdmin(3);
    wireNewUserInviteFlow(supabaseAdmin, 'membership-id-1', 'abc123');
    return buildService({
      supabaseAdmin,
      supabaseServer: stubSupabaseServerWithNoProfile(),
      emailService: stubEmailService(),
      ...overrides,
    });
  }

  it('denies app-level role assignment when the tenant lacks the entitlement', async () => {
    const canAccess = vi.fn().mockResolvedValue(false);
    const svc = buildInvitedService({ entitlements: stubEntitlements({ canAccess }) });

    const result = await svc.sendInvite(paramsWithAppRoles);

    expect(canAccess).toHaveBeenCalledWith('tenant-123', 'app_level_roles');
    expect(result).toEqual({
      success: false,
      error: 'entitlement_denied',
      entitlement: expect.objectContaining({ featureKey: 'app_level_roles' }),
    });
  });

  it('builds the app_level_roles denial payload with the fixed team-tier shape', async () => {
    const canAccess = vi.fn().mockResolvedValue(false);
    const buildDeniedInfo = vi.fn().mockReturnValue({ featureKey: 'app_level_roles' });
    const svc = buildInvitedService({ entitlements: stubEntitlements({ canAccess, buildDeniedInfo }) });

    await svc.sendInvite(paramsWithAppRoles);

    expect(buildDeniedInfo).toHaveBeenCalledWith('app_level_roles', {
      allowed: false,
      limit: 0,
      currentCount: 0,
      requiredTier: 'team',
    });
  });

  it('reports failure and logs when bulkAssign itself fails', async () => {
    const bulkAssign = vi.fn().mockResolvedValue({ success: false, error: 'assigner offline' });
    const logger = stubLogger();
    const svc = buildInvitedService({
      appRoleAssigner: { bulkAssign } as unknown as MembershipServiceConfig['appRoleAssigner'],
      logger,
    });

    const result = await svc.sendInvite(paramsWithAppRoles);

    expect(bulkAssign).toHaveBeenCalledWith('tenant-123', 'admin-user-id', {
      membershipId: 'membership-id-1',
      assignments: [{ appId: 'app-1', role: 'write' }],
    });
    expect(result).toEqual({
      success: false,
      error:
        'User was invited but app-level role assignments failed. Please assign app roles manually in Settings > App Access.',
      membershipId: 'membership-id-1',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to assign app-level roles during invite' }),
      {
        tenantId: 'tenant-123',
        membershipId: 'membership-id-1',
        appRoles: paramsWithAppRoles.appRoles,
        error: 'assigner offline',
      },
    );
  });

  it('reports partial failure with the failing app ids when some assignments error', async () => {
    const bulkAssign = vi.fn().mockResolvedValue({
      success: true,
      data: { errors: [{ appId: 'app-1' }, { appId: 'app-2' }] },
    });
    const logger = stubLogger();
    const svc = buildInvitedService({
      appRoleAssigner: { bulkAssign } as unknown as MembershipServiceConfig['appRoleAssigner'],
      logger,
    });

    const result = await svc.sendInvite(paramsWithAppRoles);

    expect(result).toEqual({
      success: false,
      error:
        'User was invited but some app role assignments failed (app-1, app-2). Please review in Settings > App Access.',
      membershipId: 'membership-id-1',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Partial failure assigning app-level roles during invite' }),
      {
        tenantId: 'tenant-123',
        membershipId: 'membership-id-1',
        errors: [{ appId: 'app-1' }, { appId: 'app-2' }],
      },
    );
  });

  it('succeeds cleanly when bulkAssign reports no per-app errors', async () => {
    const bulkAssign = vi.fn().mockResolvedValue({ success: true, data: { errors: [] } });
    const svc = buildInvitedService({
      appRoleAssigner: { bulkAssign } as unknown as MembershipServiceConfig['appRoleAssigner'],
    });

    const result = await svc.sendInvite(paramsWithAppRoles);

    expect(result).toEqual({ success: true, membershipId: 'membership-id-1' });
  });

  it('catches a thrown bulkAssign error and returns the generic manual-assignment message', async () => {
    const bulkAssign = vi.fn().mockRejectedValue(new Error('network down'));
    const logger = stubLogger();
    const svc = buildInvitedService({
      appRoleAssigner: { bulkAssign } as unknown as MembershipServiceConfig['appRoleAssigner'],
      logger,
    });

    const result = await svc.sendInvite(paramsWithAppRoles);

    expect(result).toEqual({
      success: false,
      error:
        'User was invited but app-level role assignments failed. Please assign app roles manually in Settings > App Access.',
      membershipId: 'membership-id-1',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to assign app-level roles during invite' }),
      expect.objectContaining({ tenantId: 'tenant-123', membershipId: 'membership-id-1', error: expect.any(Error) }),
    );
  });

  it('skips app-role assignment entirely when appRoles is empty', async () => {
    const bulkAssign = vi.fn();
    const svc = buildInvitedService({
      appRoleAssigner: { bulkAssign } as unknown as MembershipServiceConfig['appRoleAssigner'],
    });

    const result = await svc.sendInvite({ ...paramsWithAppRoles, appRoles: [] });

    expect(bulkAssign).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, membershipId: 'membership-id-1' });
  });
});

// ---------------------------------------------------------------------------
// inviteExistingUser branches (driven through sendInvite, which routes here
// when a profile row already exists for the invited email)
// ---------------------------------------------------------------------------

describe('MembershipService inviteExistingUser branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const EXISTING_USER_ID = 'existing-user-id';

  function stubExistingUserAdmin(opts: {
    existingMembership?: { id: string; role: string } | null;
    userOrgCount?: number;
    txError?: string;
    txMembershipId?: string;
    tenantCompanyName?: string;
  }) {
    const rpc = vi.fn().mockImplementation(() =>
      opts.txError
        ? Promise.resolve({ data: null, error: { message: opts.txError } })
        : Promise.resolve({ data: opts.txMembershipId ?? 'new-membership-id', error: null }),
    );

    // `membership` is queried up to 3 times in strict sequence across
    // sendInvite → inviteExistingUser: (1) the tenant-wide max_users
    // entitlement count (`.eq().in().neq()`), (2) the existing-membership
    // check (`.eq().eq().single()`), (3) — only when (2) is empty — the
    // per-user org-count query (`.eq()`, awaited directly). Track call order
    // rather than the `.eq()` column (shared across stages) or `.from()`
    // call count (a fresh `.select()` chain is built on every `.from()` call).
    let selectCallCount = 0;

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'profile') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: EXISTING_USER_ID }, error: null }),
            }),
          }),
        };
      }
      if (table === 'membership') {
        return {
          select: () => {
            selectCallCount += 1;
            if (selectCallCount === 1) {
              return {
                eq: () => ({
                  in: () => ({
                    neq: () => Promise.resolve({ count: 3, data: null, error: null }),
                  }),
                }),
              };
            }
            if (selectCallCount === 2) {
              return {
                eq: () => ({
                  eq: () => ({
                    single: () =>
                      Promise.resolve(
                        opts.existingMembership
                          ? { data: opts.existingMembership, error: null }
                          : { data: null, error: { message: 'not found' } },
                      ),
                  }),
                }),
              };
            }
            return {
              eq: () => Promise.resolve({ count: opts.userOrgCount ?? 0, data: null, error: null }),
            };
          },
        };
      }
      if (table === 'tenant') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { company_name: opts.tenantCompanyName ?? 'Acme Corp' },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    return { from, rpc } as unknown as MembershipServiceConfig['supabaseAdmin'];
  }

  const baseParams = {
    adminUser: makeAdminUser(),
    tenantId: 'tenant-123',
    name: 'Existing User',
    email: 'existing@example.com',
    role: MembershipRoleEnum.WRITE,
    origin: 'https://app.example.com',
  };

  it('rejects a previously-disabled member with a distinct message', async () => {
    const supabaseAdmin = stubExistingUserAdmin({
      existingMembership: { id: 'm-1', role: MembershipRoleEnum.DISABLED },
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'This user was previously disabled in this organization',
    });
  });

  it('rejects a user who already has an active membership', async () => {
    const supabaseAdmin = stubExistingUserAdmin({
      existingMembership: { id: 'm-1', role: MembershipRoleEnum.WRITE },
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'User is already a member of this organization',
    });
  });

  it('blocks inviting a user already in 10 organizations', async () => {
    const supabaseAdmin = stubExistingUserAdmin({ existingMembership: null, userOrgCount: 10 });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'User has reached the maximum of 10 organizations',
    });
  });

  it('allows inviting a user in exactly 9 organizations (one below the cap)', async () => {
    const supabaseAdmin = stubExistingUserAdmin({ existingMembership: null, userOrgCount: 9 });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.sendInvite(baseParams);

    expect(result.success).toBe(true);
  });

  it('surfaces the transaction error message on RPC failure', async () => {
    const supabaseAdmin = stubExistingUserAdmin({ existingMembership: null, txError: 'db exploded' });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({ success: false, error: 'db exploded' });
  });

  it('reports the created membership but a failed email with an actionable message', async () => {
    const supabaseAdmin = stubExistingUserAdmin({
      existingMembership: null,
      txMembershipId: 'new-membership-99',
    });
    const emailError = new Error('smtp down');
    const emailService = {
      sendEmail: vi.fn().mockResolvedValue({ error: emailError }),
    } as unknown as MembershipServiceConfig['emailService'];
    const logger = stubLogger();
    const svc = buildService({ supabaseAdmin, emailService, logger });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'Invitation created but failed to send email. Please resend the invite.',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to send invitation email' }),
      { email: 'existing@example.com', companyName: 'Acme Corp', emailError },
    );
  });

  it('sends the accept-invite link (not the confirm/new-password link) to existing users', async () => {
    const supabaseAdmin = stubExistingUserAdmin({
      existingMembership: null,
      txMembershipId: 'new-membership-99',
    });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService });

    await svc.sendInvite(baseParams);

    expect(emailService.sendEmail).toHaveBeenCalledWith({
      emailType: 'invite',
      templateParams: {
        inviteLink: 'https://app.example.com/auth/accept-invite?id=new-membership-99',
        appUrl: 'https://app.example.com',
        companyName: 'Acme Corp',
      },
      to: 'existing@example.com',
      subject: "You've been invited to join Acme Corp",
    });
  });

  it('stamps the RPC with an invited_at/expires_at pair exactly 7 days apart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const supabaseAdmin = stubExistingUserAdmin({
      existingMembership: null,
      txMembershipId: 'new-membership-99',
    });
    const svc = buildService({ supabaseAdmin, emailService: stubEmailService() });

    await svc.sendInvite(baseParams);

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith('invite_existing_user_transaction', expect.objectContaining({
      p_invited_at: '2026-03-01T00:00:00.000Z',
      p_expires_at: '2026-03-08T00:00:00.000Z',
    }));
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// inviteNewUser branches (sendInvite when no profile exists for the email)
// ---------------------------------------------------------------------------

describe('MembershipService inviteNewUser branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseParams = {
    adminUser: makeAdminUser(),
    tenantId: 'tenant-123',
    name: 'New User',
    email: 'new@example.com',
    role: MembershipRoleEnum.WRITE,
    origin: 'https://app.example.com',
  };

  it('surfaces the generateLink error message', async () => {
    const supabaseAdmin = stubSupabaseAdmin(1);
    const client = supabaseAdmin as unknown as {
      auth: { admin: { generateLink: ReturnType<typeof vi.fn> } };
    };
    client.auth = {
      admin: {
        generateLink: vi.fn().mockResolvedValue({ data: null, error: { message: 'auth service down' } }),
      },
    };
    const svc = buildService({ supabaseAdmin, supabaseServer: stubSupabaseServerWithNoProfile() });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({ success: false, error: 'auth service down' });
  });

  it('falls back to a generic message when generateLink has no error but no user', async () => {
    const supabaseAdmin = stubSupabaseAdmin(1);
    const client = supabaseAdmin as unknown as {
      auth: { admin: { generateLink: ReturnType<typeof vi.fn> } };
    };
    client.auth = {
      admin: {
        generateLink: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
    };
    const svc = buildService({ supabaseAdmin, supabaseServer: stubSupabaseServerWithNoProfile() });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({ success: false, error: 'Failed to invite user' });
  });

  it('cleans up the orphaned auth user and surfaces the transaction error on txError', async () => {
    const supabaseAdmin = stubSupabaseAdmin(1);
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    const client = supabaseAdmin as unknown as {
      auth: { admin: { generateLink: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } };
      rpc: ReturnType<typeof vi.fn>;
    };
    client.auth = {
      admin: {
        generateLink: vi.fn().mockResolvedValue({
          data: { user: { id: 'orphan-user-id' }, properties: { hashed_token: 'tok' } },
          error: null,
        }),
        deleteUser,
      },
    };
    client.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'txn rolled back' } });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubSupabaseServerWithNoProfile() });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({ success: false, error: 'txn rolled back' });
    expect(deleteUser).toHaveBeenCalledWith('orphan-user-id');
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('retries cleanup on transient deleteUser failures and eventually succeeds', async () => {
    vi.useFakeTimers();
    const supabaseAdmin = stubSupabaseAdmin(1);
    const deleteUser = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    const client = supabaseAdmin as unknown as {
      auth: { admin: { generateLink: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } };
      rpc: ReturnType<typeof vi.fn>;
    };
    client.auth = {
      admin: {
        generateLink: vi.fn().mockResolvedValue({
          data: { user: { id: 'orphan-user-id' }, properties: { hashed_token: 'tok' } },
          error: null,
        }),
        deleteUser,
      },
    };
    client.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'txn rolled back' } });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubSupabaseServerWithNoProfile() });

    const promise = svc.sendInvite(baseParams);
    // First attempt fails synchronously; the retry backs off exactly
    // 100ms (`100 * 2^(attempt-1)` at attempt=1) before attempt 2. Stepping
    // just short of that boundary first pins the exact delay — not merely
    // "eventually retries".
    await vi.advanceTimersByTimeAsync(99);
    expect(deleteUser).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteUser).toHaveBeenCalledTimes(2);
    const result = await promise;

    expect(result).toEqual({ success: false, error: 'txn rolled back' });
    vi.useRealTimers();
  });

  it('exhausts all 3 cleanup retries and logs the failure without throwing', async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabaseAdmin = stubSupabaseAdmin(1);
    const deleteUser = vi.fn().mockRejectedValue(new Error('permanently broken'));
    const client = supabaseAdmin as unknown as {
      auth: { admin: { generateLink: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } };
      rpc: ReturnType<typeof vi.fn>;
    };
    client.auth = {
      admin: {
        generateLink: vi.fn().mockResolvedValue({
          data: { user: { id: 'orphan-user-id' }, properties: { hashed_token: 'tok' } },
          error: null,
        }),
        deleteUser,
      },
    };
    client.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'txn rolled back' } });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubSupabaseServerWithNoProfile() });

    const promise = svc.sendInvite(baseParams);
    // Backoff is `100 * 2^(attempt-1)`: 100ms before attempt 2, then 200ms
    // before attempt 3. Attempt 1's 100ms delay is the same under an
    // accidental `100 / 2^(attempt-1)` swap (both give 100 at attempt=1),
    // so pinning the SECOND gap (200ms, vs. the divide-mutant's 50ms) is
    // what actually distinguishes the two operators.
    await vi.advanceTimersByTimeAsync(100);
    expect(deleteUser).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(deleteUser).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteUser).toHaveBeenCalledTimes(3);
    const result = await promise;

    expect(result).toEqual({ success: false, error: 'txn rolled back' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to cleanup orphaned auth user after 3 attempts:',
      { userId: 'orphan-user-id', error: expect.any(Error) },
    );

    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('reports the created membership but a failed email for new users too', async () => {
    const supabaseAdmin = stubSupabaseAdmin(1);
    wireNewUserInviteFlow(supabaseAdmin, 'new-membership-1', 'tok-abc');
    const emailError = new Error('smtp down');
    const emailService = {
      sendEmail: vi.fn().mockResolvedValue({ error: emailError }),
    } as unknown as MembershipServiceConfig['emailService'];
    const logger = stubLogger();
    const svc = buildService({
      supabaseAdmin,
      supabaseServer: stubSupabaseServerWithNoProfile(),
      emailService,
      logger,
    });

    const result = await svc.sendInvite(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'Invitation created but failed to send email. Please resend the invite.',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Failed to send invitation email' }),
      { email: 'new@example.com', companyName: 'Acme Corp', emailError },
    );
  });

  it('stamps the RPC with an invited_at/expires_at pair exactly 7 days apart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const supabaseAdmin = stubSupabaseAdmin(1);
    wireNewUserInviteFlow(supabaseAdmin, 'new-membership-1', 'tok-abc');
    const svc = buildService({ supabaseAdmin, supabaseServer: stubSupabaseServerWithNoProfile() });

    await svc.sendInvite(baseParams);

    expect(supabaseAdmin.rpc).toHaveBeenCalledWith('invite_new_user_transaction', expect.objectContaining({
      p_invited_at: '2026-03-01T00:00:00.000Z',
      p_expires_at: '2026-03-08T00:00:00.000Z',
    }));
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// changeUserRole guard branches
// ---------------------------------------------------------------------------

describe('MembershipService.changeUserRole() guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TENANT_ID = 'tenant-guard';
  const TARGET_USER_ID = 'target-guard';

  function stubGuardAdmin(opts: {
    actorRole?: string | null;
    prevMembership?: { id: string; role: string; custom_role_id: string | null } | null;
    ownerCount?: number;
  }) {
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'membership') {
        return {
          select: vi.fn().mockImplementation((sel: string) => {
            // actorOrgRole: .select('role').eq(...).eq(...).eq(...).maybeSingle()
            if (sel === 'role') {
              return {
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: opts.actorRole ? { role: opts.actorRole } : null, error: null }),
                    }),
                  }),
                }),
              };
            }
            // prevMembership lookup: .select('id, role, custom_role_id').eq().eq().in().single()
            if (sel === 'id, role, custom_role_id') {
              return {
                eq: () => ({
                  eq: () => ({
                    in: () => ({
                      single: () =>
                        Promise.resolve(
                          opts.prevMembership
                            ? { data: opts.prevMembership, error: null }
                            : { data: null, error: { message: 'not found' } },
                        ),
                    }),
                  }),
                }),
              };
            }
            // owner-count query: .select('*', {count}).eq().eq().eq()
            return {
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ count: opts.ownerCount ?? 5, data: null, error: null }),
                }),
              }),
            };
          }),
        };
      }
      return {};
    });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    return { from, rpc } as unknown as MembershipServiceConfig['supabaseAdmin'];
  }

  it('rejects when the target has no membership in the org', async () => {
    const supabaseAdmin = stubGuardAdmin({ actorRole: 'owner', prevMembership: null });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: false, error: 'User not found in organization' });
  });

  it('rejects promotion to owner by a non-owner actor', async () => {
    const supabaseAdmin = stubGuardAdmin({
      actorRole: 'admin',
      prevMembership: { id: 'm-1', role: 'write', custom_role_id: null },
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.OWNER,
    });

    expect(result).toEqual({ success: false, error: 'Only owners can promote users to owner role' });
  });

  it('blocks demoting the last owner regardless of actor role', async () => {
    const supabaseAdmin = stubGuardAdmin({
      actorRole: 'owner',
      prevMembership: { id: 'm-1', role: 'owner', custom_role_id: null },
      ownerCount: 1,
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({
      success: false,
      error: 'Cannot demote the last owner. Transfer ownership first.',
    });
  });

  it('rejects a non-owner actor demoting another owner even when more than one owner exists', async () => {
    const supabaseAdmin = stubGuardAdmin({
      actorRole: 'admin',
      prevMembership: { id: 'm-1', role: 'owner', custom_role_id: null },
      ownerCount: 3,
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: false, error: "Only owners can change another owner's role" });
  });

  it('allows an owner actor to demote a co-owner when more than one owner exists', async () => {
    const supabaseAdmin = stubGuardAdmin({
      actorRole: 'owner',
      prevMembership: { id: 'm-1', role: 'owner', custom_role_id: null },
      ownerCount: 3,
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: true });
  });

  it('does not apply the last-owner guard when the new role is also owner', async () => {
    const supabaseAdmin = stubGuardAdmin({
      actorRole: 'admin',
      prevMembership: { id: 'm-1', role: 'owner', custom_role_id: null },
      ownerCount: 1,
    });
    const svc = buildService({ supabaseAdmin });

    // newRole === OWNER means the `newRole !== OWNER` guard condition is false,
    // so the last-owner protection is skipped entirely — but the earlier
    // promote-to-owner guard still fires for a non-owner actor.
    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.OWNER,
    });

    expect(result).toEqual({ success: false, error: 'Only owners can promote users to owner role' });
  });
});

// ---------------------------------------------------------------------------
// removeUserFromOrg guard branches + notification email edge cases
// ---------------------------------------------------------------------------

describe('MembershipService.removeUserFromOrg() guards and notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TENANT_ID = 'tenant-remove';
  const TARGET_USER_ID = 'target-remove';

  function stubRemoveAdmin(opts: {
    membership?: { id: string; role: string; status: string } | null;
    ownerCount?: number;
    actorRole?: string | null;
    profileEmail?: string | null;
    orgName?: string | null;
    deleteError?: string;
  }) {
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'membership') {
        return {
          select: vi.fn().mockImplementation((sel: string) => {
            if (sel === 'role') {
              // actorOrgRole
              return {
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: opts.actorRole ? { role: opts.actorRole } : null, error: null }),
                    }),
                  }),
                }),
              };
            }
            if (sel === 'id, role, status') {
              return {
                eq: () => ({
                  eq: () => ({
                    in: () => ({
                      single: () =>
                        Promise.resolve(
                          opts.membership
                            ? { data: opts.membership, error: null }
                            : { data: null, error: { message: 'not found' } },
                        ),
                    }),
                  }),
                }),
              };
            }
            return {
              eq: () => ({
                eq: () => ({ eq: () => Promise.resolve({ count: opts.ownerCount ?? 5, data: null, error: null }) }),
              }),
            };
          }),
        };
      }
      if (table === 'profile') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: opts.profileEmail !== null ? { email: opts.profileEmail ?? 'target@example.com' } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'tenant') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: opts.orgName !== null ? { organization_name: opts.orgName ?? 'Acme Org' } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      return {};
    });
    const rpc = vi.fn().mockImplementation(() =>
      opts.deleteError
        ? Promise.resolve({ data: null, error: { message: opts.deleteError } })
        : Promise.resolve({ data: { membership_id: 'm-1' }, error: null }),
    );
    return { from, rpc } as unknown as MembershipServiceConfig['supabaseAdmin'];
  }

  it('rejects when the target has no membership in the org', async () => {
    const supabaseAdmin = stubRemoveAdmin({ membership: null });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: false, error: 'User not found in organization' });
  });

  it('blocks removing the last owner', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'owner', status: 'active' },
      ownerCount: 1,
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: false, error: 'Cannot remove the last owner from the organization' });
  });

  it('rejects a non-owner actor removing another owner when more than one owner exists', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'owner', status: 'active' },
      ownerCount: 3,
      actorRole: 'admin',
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: false, error: 'Only owners can remove other owners' });
  });

  it('allows an owner actor to remove a co-owner when more than one owner exists', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'owner', status: 'active' },
      ownerCount: 3,
      actorRole: 'owner',
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
  });

  it('surfaces the delete-transaction error message', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'write', status: 'active' },
      deleteError: 'fk violation',
    });
    const svc = buildService({ supabaseAdmin });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: false, error: 'fk violation' });
  });

  it('sends the removal notification with exact template params when both profile and tenant resolve', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'write', status: 'active' },
      profileEmail: 'gone@example.com',
      orgName: 'Wonderland',
    });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService, appUrl: 'https://app.example.com' });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).toHaveBeenCalledWith({
      emailType: 'removed_from_org',
      templateParams: { appUrl: 'https://app.example.com', orgName: 'Wonderland' },
      to: 'gone@example.com',
      subject: 'You have been removed from Wonderland',
    });
  });

  it('skips the removal email when the profile has no email on record', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'write', status: 'active' },
      profileEmail: null,
      orgName: 'Wonderland',
    });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('skips the removal email when the tenant has no organization name on record', async () => {
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'write', status: 'active' },
      profileEmail: 'gone@example.com',
      orgName: null,
    });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('swallows a removal-email send failure and still reports success', async () => {
    const emailService = {
      sendEmail: vi.fn().mockRejectedValue(new Error('smtp down')),
    } as unknown as MembershipServiceConfig['emailService'];
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabaseAdmin = stubRemoveAdmin({
      membership: { id: 'm-1', role: 'write', status: 'active' },
      profileEmail: 'gone@example.com',
      orgName: 'Wonderland',
    });
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.removeUserFromOrg({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
    });

    expect(result).toEqual({ success: true });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to send removal email:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// changeUserRole notification email edge cases (sendRoleChangedEmail)
// ---------------------------------------------------------------------------

describe('MembershipService.changeUserRole() notification email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TENANT_ID = 'tenant-notify';
  const TARGET_USER_ID = 'target-notify';

  function stubRoleChangeAdmin(opts: { profileEmail?: string | null; orgName?: string | null }) {
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'membership') {
        return {
          select: vi.fn().mockImplementation((sel: string) => {
            if (sel === 'role') {
              return {
                eq: () => ({
                  eq: () => ({
                    eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: 'owner' }, error: null }) }),
                  }),
                }),
              };
            }
            return {
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    single: () =>
                      Promise.resolve({ data: { id: 'm-1', role: 'read', custom_role_id: null }, error: null }),
                  }),
                }),
              }),
            };
          }),
        };
      }
      if (table === 'profile') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: opts.profileEmail !== null ? { email: opts.profileEmail ?? 'target@example.com' } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'tenant') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: opts.orgName !== null ? { organization_name: opts.orgName ?? 'Acme Org' } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      return {};
    });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    return { from, rpc } as unknown as MembershipServiceConfig['supabaseAdmin'];
  }

  it('sends the role-changed notification with exact template params on success', async () => {
    const supabaseAdmin = stubRoleChangeAdmin({ profileEmail: 'changed@example.com', orgName: 'Acme Org' });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService, appUrl: 'https://app.example.com' });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).toHaveBeenCalledWith({
      emailType: 'role_changed',
      templateParams: {
        appUrl: 'https://app.example.com',
        orgName: 'Acme Org',
        oldRole: 'read',
        newRole: 'write',
      },
      to: 'changed@example.com',
      subject: 'Your role has been updated in Acme Org',
    });
  });

  it('logs and skips the email when the target profile has no email', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabaseAdmin = stubRoleChangeAdmin({ profileEmail: null, orgName: 'Acme Org' });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to get user email for role change notification');
    consoleErrorSpy.mockRestore();
  });

  it('logs and skips the email when the tenant has no organization name', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabaseAdmin = stubRoleChangeAdmin({ profileEmail: 'changed@example.com', orgName: null });
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to get org name for role change notification');
    consoleErrorSpy.mockRestore();
  });

  it('swallows a role-changed email send failure and still reports success', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emailService = {
      sendEmail: vi.fn().mockRejectedValue(new Error('smtp down')),
    } as unknown as MembershipServiceConfig['emailService'];
    const supabaseAdmin = stubRoleChangeAdmin({ profileEmail: 'changed@example.com', orgName: 'Acme Org' });
    const svc = buildService({ supabaseAdmin, emailService });

    const result = await svc.changeUserRole({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      newRole: MembershipRoleEnum.WRITE,
    });

    expect(result).toEqual({ success: true });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to send role change email:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// resendInviteLink branches
// ---------------------------------------------------------------------------

describe('MembershipService.resendInviteLink()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TENANT_ID = 'tenant-resend';
  const EMAIL = 'resend@example.com';

  function stubResendAdmin(opts: {
    profile?: { id: string } | null;
    membership?: { id: string; status: string } | null;
    authUser?: { confirmed_at: string | null } | null;
    generateLinkError?: string;
    hashedToken?: string;
  }) {
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === 'profile') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve(opts.profile ? { data: opts.profile, error: null } : { data: null, error: null }),
            }),
          }),
        };
      }
      if (table === 'membership') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve(
                    opts.membership ? { data: opts.membership, error: null } : { data: null, error: null },
                  ),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
    (from as unknown as { mockImplementation: (fn: (table: string) => unknown) => void }).mockImplementation(
      (table: string) => {
        if (table === 'membership') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve(
                      opts.membership ? { data: opts.membership, error: null } : { data: null, error: null },
                    ),
                }),
              }),
            }),
            update,
          };
        }
        if (table === 'profile') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve(opts.profile ? { data: opts.profile, error: null } : { data: null, error: null }),
              }),
            }),
          };
        }
        return {};
      },
    );

    const auth = {
      admin: {
        getUserById: vi.fn().mockResolvedValue({ data: { user: opts.authUser ?? null } }),
        generateLink: vi.fn().mockResolvedValue(
          opts.generateLinkError
            ? { data: null, error: { message: opts.generateLinkError } }
            : {
                data: { properties: { hashed_token: opts.hashedToken ?? 'tok-xyz' } },
                error: null,
              },
        ),
      },
    };

    return { from, auth, update } as unknown as MembershipServiceConfig['supabaseAdmin'] & { update: typeof update };
  }

  function stubResendServer(companyName = 'Acme Corp') {
    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { company_name: companyName }, error: null }),
        }),
      }),
    } as unknown as MembershipServiceConfig['supabaseServer'];
  }

  it('returns "User not found" when no profile exists for the email', async () => {
    const supabaseAdmin = stubResendAdmin({ profile: null });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer() });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'User not found' });
  });

  it('returns a not-a-member error when the profile has no membership in this tenant', async () => {
    const supabaseAdmin = stubResendAdmin({ profile: { id: 'p-1' }, membership: null });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer() });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'User is not a member of this organization' });
  });

  it('returns "User not found" when the auth user lookup comes back empty', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: null,
    });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer() });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'User not found' });
  });

  it('rejects a confirmed user whose membership is not pending', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'active' },
      authUser: { confirmed_at: '2026-01-01T00:00:00Z' },
    });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer() });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'No pending invitation found for this user' });
  });

  it('extends the invite, emails the accept-invite link, and writes the audit row for a confirmed pending user', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: { confirmed_at: '2026-01-01T00:00:00Z' },
    }) as unknown as MembershipServiceConfig['supabaseAdmin'] & { update: ReturnType<typeof vi.fn> };
    const emailService = stubEmailService();
    const auditLog = stubAuditLog();
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer('Acme Corp'), emailService, auditLog });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser({ id: 'admin-x' }),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: true });
    expect(supabaseAdmin.update).toHaveBeenCalledWith({ expires_at: '2026-03-08T00:00:00.000Z' });
    vi.useRealTimers();
    expect(emailService.sendEmail).toHaveBeenCalledWith({
      emailType: 'invite',
      templateParams: {
        inviteLink: 'https://app.example.com/auth/accept-invite?id=m-1',
        appUrl: 'https://app.example.com',
        companyName: 'Acme Corp',
      },
      to: EMAIL,
      subject: "You've been invited to join Acme Corp",
    });
    expect(auditLog.create).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      actorId: 'admin-x',
      actionType: 'invite_resent',
      targetType: 'membership',
      targetId: 'm-1',
      targetIdentifier: EMAIL,
      details: { expires_at: '2026-03-08T00:00:00.000Z' },
    });
  });

  it('reports an email failure for a confirmed pending user without writing an audit row', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: { confirmed_at: '2026-01-01T00:00:00Z' },
    });
    const emailService = {
      sendEmail: vi.fn().mockResolvedValue({ error: new Error('smtp down') }),
    } as unknown as MembershipServiceConfig['emailService'];
    const auditLog = stubAuditLog();
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer(), emailService, auditLog });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'Failed to send email' });
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it('surfaces the generateLink error for an unconfirmed user', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: { confirmed_at: null },
      generateLinkError: 'auth down',
    });
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer() });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'auth down' });
  });

  it('reports an email failure for an unconfirmed user without writing an audit row', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: { confirmed_at: null },
      hashedToken: 'fresh-tok',
    });
    const emailService = {
      sendEmail: vi.fn().mockResolvedValue({ error: new Error('smtp down') }),
    } as unknown as MembershipServiceConfig['emailService'];
    const auditLog = stubAuditLog();
    const svc = buildService({ supabaseAdmin, supabaseServer: stubResendServer(), emailService, auditLog });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: false, error: 'Failed to send email' });
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it('emails the confirm/new-password link and writes the audit row (no details) for an unconfirmed user', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: { confirmed_at: null },
      hashedToken: 'fresh-tok',
    });
    const emailService = stubEmailService();
    const auditLog = stubAuditLog();
    const svc = buildService({
      supabaseAdmin,
      supabaseServer: stubResendServer('Acme Corp'),
      emailService,
      auditLog,
    });

    const result = await svc.resendInviteLink({
      adminUser: makeAdminUser({ id: 'admin-y' }),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ success: true });
    expect(emailService.sendEmail).toHaveBeenCalledWith({
      emailType: 'invite',
      templateParams: {
        inviteLink:
          'https://app.example.com/auth/confirm?token_hash=fresh-tok&type=invite&next=%2Fauth%2Fnew-password%3Fflow%3Dinvite',
        appUrl: 'https://app.example.com',
        companyName: 'Acme Corp',
      },
      to: EMAIL,
      subject: "You've been invited",
    });
    expect(auditLog.create).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      actorId: 'admin-y',
      actionType: 'invite_resent',
      targetType: 'membership',
      targetId: 'm-1',
      targetIdentifier: EMAIL,
    });
  });

  it('falls back to "an organization" as the company name when the tenant lookup returns none', async () => {
    const supabaseAdmin = stubResendAdmin({
      profile: { id: 'p-1' },
      membership: { id: 'm-1', status: 'pending' },
      authUser: { confirmed_at: null },
    });
    const supabaseServer = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    } as unknown as MembershipServiceConfig['supabaseServer'];
    const emailService = stubEmailService();
    const svc = buildService({ supabaseAdmin, supabaseServer, emailService });

    await svc.resendInviteLink({
      adminUser: makeAdminUser(),
      tenantId: TENANT_ID,
      email: EMAIL,
      origin: 'https://app.example.com',
    });

    expect(emailService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        templateParams: expect.objectContaining({ companyName: 'an organization' }),
      }),
    );
  });
});
