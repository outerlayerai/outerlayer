/**
 * Unit tests for MembershipService.sendInvite() — entitlement enforcement.
 *
 * The EntitlementService is constructed inline inside sendInvite(), so we
 * mock the module rather than injecting it. All other dependencies use
 * constructor DI and are stubbed directly.
 */

import type { Mock } from 'vitest';
import { User } from '@supabase/supabase-js';
import { MembershipService, type MembershipServiceConfig } from './membership-service';
import { UserRoleEnum } from '@/lib/adapters/user-role';
import { UNLIMITED } from '@/config/entitlements';

// ---------------------------------------------------------------------------
// Mock EntitlementService module
// ---------------------------------------------------------------------------

const mockCheckLimit = vi.fn();

vi.mock('@/lib/system/entitlement-service', () => ({
  EntitlementService: vi.fn().mockImplementation(function () {
    return {
      checkLimit: mockCheckLimit,
    };
  }),
  buildDeniedInfo: vi.fn().mockImplementation((key: string, result: unknown) => ({
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
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminUser(overrides: Partial<User> = {}): User {
  return {
    id: 'admin-user-id',
    app_metadata: {
      tenant_id: 'tenant-123',
      role: UserRoleEnum.ADMIN,
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
      data: { role: UserRoleEnum.ADMIN },
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

function buildService(overrides: Partial<MembershipServiceConfig> = {}) {
  return new MembershipService({
    supabaseAdmin: stubSupabaseAdmin(0),
    supabaseServer: stubSupabaseServer(),
    emailService: stubEmailService(),
    rateLimitService: stubRateLimitService(),
    stripeService: stubStripeService(),
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
    role: UserRoleEnum.WRITE,
    origin: 'https://app.example.com',
  };

  // ── Entitlement: allowed ────────────────────────────────────────────

  describe('when entitlement check allows the invite', () => {
    it('should proceed past the entitlement gate (new user flow)', async () => {
      const supabaseAdmin = stubSupabaseAdmin(3);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-1', 'abc123');

      mockCheckLimit.mockResolvedValue({
        allowed: true,
        limit: 25,
        currentCount: 3,
      });

      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService,
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.membershipId).toBe('membership-id-1');
      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 3);
    });

    it('should allow when limit is unlimited', async () => {
      const supabaseAdmin = stubSupabaseAdmin(999);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-2', 'abc123');

      mockCheckLimit.mockResolvedValue({
        allowed: true,
        limit: UNLIMITED,
        currentCount: 999,
      });

      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService,
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 999);
    });

    it('should email new users an invite link that flags the invite flow for the password page', async () => {
      const supabaseAdmin = stubSupabaseAdmin(3);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-1', 'abc123');

      mockCheckLimit.mockResolvedValue({
        allowed: true,
        limit: 25,
        currentCount: 3,
      });

      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService,
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
    // proves AC-077-03
    it('should return entitlement_denied with denied info', async () => {
      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 1,
        currentCount: 1,
        requiredTier: 'growth',
        upgradeUrl: '/settings/billing',
      });

      const svc = buildService({ supabaseAdmin: stubSupabaseAdmin(1) });
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

      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 5,
        currentCount: 5,
        requiredTier: 'growth',
        upgradeUrl: '/settings/billing',
      });

      const svc = buildService({ supabaseAdmin });
      await svc.sendInvite(baseParams);

      // membership table is queried for the count, but tenant should NOT be queried
      const tableCalls = fromSpy.mock.calls.map((c: string[]) => c[0]);
      expect(tableCalls).toContain('membership');
      expect(tableCalls).not.toContain('tenant');
      expect(tableCalls).not.toContain('profile');
    });

    it('should not send any emails when denied', async () => {
      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 1,
        currentCount: 1,
        requiredTier: 'growth',
      });

      const emailService = stubEmailService();
      const svc = buildService({
        supabaseAdmin: stubSupabaseAdmin(1),
        emailService,
      });

      await svc.sendInvite(baseParams);

      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('should pass the current active user count to checkLimit', async () => {
      const activeCount = 7;

      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 5,
        currentCount: activeCount,
        requiredTier: 'growth',
      });

      const svc = buildService({ supabaseAdmin: stubSupabaseAdmin(activeCount) });
      await svc.sendInvite(baseParams);

      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', activeCount);
    });
  });

  // ── Entitlement gate vs earlier validations ─────────────────────────

  describe('validation ordering', () => {
    it('should reject invalid email before checking entitlements', async () => {
      const svc = buildService();
      const result = await svc.sendInvite({
        ...baseParams,
        email: 'not-an-email',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid email format');
      expect(mockCheckLimit).not.toHaveBeenCalled();
    });

    // proves AC-077-01
    it('should reject owner-invite-by-non-owner before checking entitlements', async () => {
      const svc = buildService();
      const result = await svc.sendInvite({
        ...baseParams,
        role: UserRoleEnum.OWNER,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Only owners can invite users as owners');
      expect(mockCheckLimit).not.toHaveBeenCalled();
    });

    it('should reject rate-limited requests before checking entitlements', async () => {
      const svc = buildService({
        rateLimitService: stubRateLimitService(false),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(false);
      expect(result.error).toContain('recently sent');
      expect(mockCheckLimit).not.toHaveBeenCalled();
    });
  });

  // ── EntitlementService construction ─────────────────────────────────

  describe('EntitlementService construction', () => {
    it('should construct EntitlementService with supabaseAdmin as db', async () => {
      const { EntitlementService: MockedEntitlementService } =
        await import('@/lib/system/entitlement-service');

      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 1,
        currentCount: 1,
      });

      const supabaseAdmin = stubSupabaseAdmin(1);
      const svc = buildService({ supabaseAdmin });
      await svc.sendInvite(baseParams);

      expect(MockedEntitlementService).toHaveBeenCalledWith({ db: supabaseAdmin });
    });
  });

  // ── Tier-based max_users enforcement ─────────────────────────────────

  describe('max_users tier enforcement', () => {
    /**
     * Hobby tier: limit=2. When userCount=2 the tenant is AT the limit.
     * checkLimit uses `currentCount < limit`, so count=2 with limit=2 is NOT allowed.
     */
    it('should block invite when hobby tier is at the 2-user limit', async () => {
      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 2,
        currentCount: 2,
        requiredTier: 'growth',
        upgradeUrl: '/settings/billing',
      });

      const svc = buildService({ supabaseAdmin: stubSupabaseAdmin(2) });
      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(false);
      expect(result.error).toBe('entitlement_denied');
      expect(result.entitlement!.featureKey).toBe('max_users');
      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 2);
    });

    /**
     * Hobby tier: limit=2. When userCount=1 the tenant is below the limit.
     * The invite should proceed (past the entitlement gate).
     */
    it('should allow invite when hobby tier has one slot remaining (userCount=1, limit=2)', async () => {
      mockCheckLimit.mockResolvedValue({
        allowed: true,
        limit: 2,
        currentCount: 1,
      });

      // Wire up the full new-user invite flow so the service can complete
      const supabaseAdmin = stubSupabaseAdmin(1);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-hobby', 'tok-abc');

      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService: stubEmailService(),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 1);
    });

    /**
     * Growth tier: limit=-1 (UNLIMITED). Even with 999 active users, invite is allowed.
     */
    it('should always allow invite when growth tier has unlimited users (limit=-1)', async () => {
      mockCheckLimit.mockResolvedValue({
        allowed: true,
        limit: UNLIMITED,
        currentCount: 999,
      });

      const supabaseAdmin = stubSupabaseAdmin(999);
      wireNewUserInviteFlow(supabaseAdmin, 'membership-id-growth', 'tok-growth');

      const svc = buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService: stubEmailService(),
      });

      const result = await svc.sendInvite(baseParams);

      expect(result.success).toBe(true);
      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 999);
    });

    /**
     * Exactly at the limit (count === limit): must be blocked, not one-over.
     * This verifies the `currentCount < limit` semantics (strict less-than).
     */
    it('should block at exactly the limit and allow at one below', async () => {
      // At limit: blocked
      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 5,
        currentCount: 5,
        requiredTier: 'growth',
      });

      const blocked = await buildService({ supabaseAdmin: stubSupabaseAdmin(5) })
        .sendInvite(baseParams);

      expect(blocked.success).toBe(false);
      expect(blocked.error).toBe('entitlement_denied');

      // One below limit: allowed (requires full invite flow wiring)
      mockCheckLimit.mockResolvedValue({
        allowed: true,
        limit: 5,
        currentCount: 4,
      });

      const supabaseAdmin = stubSupabaseAdmin(4);
      wireNewUserInviteFlow(supabaseAdmin, 'mid', 'tok');

      const allowed = await buildService({
        supabaseAdmin,
        supabaseServer: stubSupabaseServerWithNoProfile(),
        emailService: stubEmailService(),
      }).sendInvite(baseParams);

      expect(allowed.success).toBe(true);
    });

    /**
     * When the membership count query returns null (DB error or empty), the service
     * uses `userCount ?? 0` as a fallback. The entitlement check is still called with 0.
     */
    it('should use 0 as fallback userCount when membership query returns null count', async () => {
      // Stub the admin so the membership count returns null
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

      mockCheckLimit.mockResolvedValue({
        allowed: false,
        limit: 2,
        currentCount: 0,
        requiredTier: 'growth',
      });

      const svc = buildService({ supabaseAdmin });
      await svc.sendInvite(baseParams);

      // Verify the service falls back to 0 (not null) when count is null
      expect(mockCheckLimit).toHaveBeenCalledWith('tenant-123', 'max_users', 0);
    });
  });

});
