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
