import { createSupabaseAdminClient, SupabaseAdminClient } from '../lib/supabase-admin';
import { cleanupTestUsers } from '../lib/test-utils';
import { createEmailRegistrationService } from '../../../tenant-dashboard/src/lib/system/registration/email-registration';
import { createOAuthRegistrationService } from '../../../tenant-dashboard/src/lib/system/registration/oauth-registration';
import type { EmailRegistrationService } from '../../../tenant-dashboard/src/lib/system/registration/email-registration';
import type { OAuthRegistrationService } from '../../../tenant-dashboard/src/lib/system/registration/oauth-registration';

// Utility: stable unique IDs for mocks and test data.
const uuid = (): string => {
  // Prefer Node's crypto.randomUUID if available; fallback if not.
  // @ts-ignore
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    // @ts-ignore
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// Default local site URL if env not provided, to avoid CI coupling.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

// ---------------
// Environment setup for tests
// ---------------
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_key_for_testing';
process.env.UNKEY_API_KEY = 'unkey_dummy_key_for_testing';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

// ---------------
// External mocks
// ---------------

// Mock Stripe to avoid network/API keys in CI; return unique but deterministic-ish IDs.
vi.mock('stripe', () => {
  const mockStripe = vi.fn().mockImplementation(() => ({
    customers: {
      create: vi.fn().mockImplementation((params?: any) => {
        // Generate a unique ID based on the email to avoid duplicates
        const emailPart = params?.email ? String(params.email).replace(/[@.]/g, '_') : 'unknown';
        const uniquePart = Math.random().toString(36).substring(2, 15);
        return Promise.resolve({ id: `cus_test_${emailPart}_${uniquePart}` });
      }),
      del: vi.fn().mockReturnValue(Promise.resolve({ deleted: true })),
    },
  }));
  // `stripe` is a default-export module — return `{ default }` (not the bare
  // factory) so vitest's mock-shape check passes regardless of ESM/CJS interop.
  return { default: mockStripe };
});

// --------------------
// Types & Test Helpers
// --------------------

// companyName is not required during registration
interface RegistrationData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

interface OAuthUserData {
  email: string;
  name: string;
  provider: 'google' | 'github';
  githubUsername?: string;
}

// Registration does not create tenant/membership/billing.
// Users create organizations later via /orgs page
interface ValidationResult {
  userId: string;
  authUser: any;
  profile: any;
}

// Legacy validation result for tests that still create tenants (e.g., org creation tests)

async function waitFor<T>(
  fn: () => Promise<T | null>,
  {
    timeoutMs = 10_000,
    intervalMs = 200,
    onTick,
  }: { timeoutMs?: number; intervalMs?: number; onTick?: (attempt: number) => void } = {}
): Promise<T> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    onTick?.(++attempt);
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

// Generate unique test emails to avoid collisions.
const uniqueEmail = (prefix: string) => `${prefix}-${crypto.randomUUID()}-${Math.random().toString(36).slice(2, 8)}@testcompany.com`;

// Track created entities per test for precise cleanup.
type CreatedRecord = { userId?: string; tenantId?: string };
const created: CreatedRecord[] = [];

// ------------------
// Test Suite
// ------------------

describe('User Registration Flow (integration)', () => {
  let adminClient: SupabaseAdminClient;
  let registrationService: ReturnType<typeof createEmailRegistrationService>;
  let oauthRegistrationService: ReturnType<typeof createOAuthRegistrationService>;

  beforeAll(() => {
    adminClient = createSupabaseAdminClient(); // requires service_role
    registrationService = createEmailRegistrationService();
    oauthRegistrationService = createOAuthRegistrationService();
  });

  afterEach(async () => {
    // Best-effort cleanup of records created during the test *and* a safety net for any leftover users.
    try {
      for (const rec of created.splice(0)) {
        if (rec.tenantId) {
          // Order matters if you don't have cascades.
          await adminClient.from('billing').delete().eq('tenant_id', rec.tenantId);
          await adminClient.from('membership').delete().eq('tenant_id', rec.tenantId);
          await adminClient.from('tenant').delete().eq('tenant_id', rec.tenantId);
        }
        if (rec.userId) {
          // Delete profile by user_id (profile no longer has tenant_id)
          await adminClient.from('profile').delete().eq('id', rec.userId);
          // Use Admin API to delete auth user (service role required).
          await adminClient.auth.admin.deleteUser(rec.userId);
        }
      }
    } catch {
      // swallow to avoid masking test failures; the safety net below will still run
    } finally {
      // Safety net (legacy helper) in case some users weren't tracked/cascaded.
      await cleanupTestUsers();
      vi.clearAllMocks();
      vi.restoreAllMocks();
    }
  });

  afterAll(async () => {
    // no-op; close sockets if you use real-time channels
  });

  // ------------------------
  // Validation helper
  // ------------------------
  // Registration only creates user + profile, no tenant/membership/billing
  const validateRegistrationResult = async (
    registrationResult: any,
    expectedEmail: string,
    expectedName: string
  ): Promise<ValidationResult> => {
    if (registrationResult && 'error' in registrationResult && registrationResult.error) {
      throw new Error(registrationResult.error);
    }

    // Normalize result shape - only userId returned, no tenantId
    const userId: string | undefined =
      registrationResult?.data?.userId ?? registrationResult?.userId;

    expect(userId).toEqual(expect.any(String));
    // tenantId should NOT be returned during registration
    const tenantId = registrationResult?.data?.tenantId ?? registrationResult?.tenantId;
    expect(tenantId).toBeUndefined();

    // Track for cleanup (no tenantId to track)
    created.push({ userId });

    // Auth user (Admin API)
    const { data: authUser } = await adminClient.auth.admin.getUserById(userId!);
    expect(authUser?.user?.id).toBe(userId);
    expect(authUser?.user?.email).toBe(expectedEmail);

    // Profile (wait in case a trigger populates it)
    const profile = await waitFor(async () => {
      const { data } = await adminClient
        .from('profile')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      return data ?? null;
    });

    expect(profile).not.toBeNull();
    expect(profile.name).toBe(expectedName);
    expect(profile.email).toBe(expectedEmail);

    // No tenant, membership, or billing created during registration.
    // Users create organizations later via /orgs page

    return { userId: userId!, authUser, profile };
  };

  // ------------------------
  // OAuth test helper
  // ------------------------
  const createOAuthUser = async (userData: OAuthUserData) => {
    const { data: createdUser, error } = await adminClient.auth.admin.createUser({
      email: userData.email,
      user_metadata: {
        name: userData.name,
        full_name: userData.name,
        company_name: 'Test OAuth Company',
        avatar_url: 'https://example.com/avatar.jpg',
      },
      app_metadata: {
        // Keep in sync with what your OAuthRegistrationService expects in production.
        // Some implementations may inspect app_metadata or user.identities shape.
        provider: userData.provider,
      },
    });

    if (error) throw new Error(`Failed to create OAuth user: ${error.message}`);

    expect(createdUser.user.id).toEqual(expect.any(String));
    expect(createdUser.user.email).toBe(userData.email);

    // Optionally simulate provider-specific identity. Adjust to match how your
    // OAuthRegistrationService detects provider data in production.
    if (userData.provider === 'github' && userData.githubUsername) {
      await adminClient.auth.admin.updateUserById(createdUser.user.id, {
        app_metadata: {
          ...createdUser.user.app_metadata,
          identities: [
            {
              id: `github-${uuid()}`,
              provider: 'github',
              identity_data: {
                user_name: userData.githubUsername,
                name: userData.name,
              },
            },
          ],
        },
      });
    }

    // Track for cleanup
    created.push({ userId: createdUser.user.id });

    return createdUser.user;
  };

  // ------------------------
  // Tests
  // ------------------------

  // Email registration does not require companyName
  describe('Email-Based Registration', () => {
    // proves AC-064-01
    it('creates user and profile on successful email registration (no tenant)', async () => {
      // Arrange - no companyName required
      const reg: RegistrationData = {
        email: uniqueEmail('test-email'),
        password: 'TestPassword123!',
        firstName: 'Test',
        lastName: 'User',
      };
      const expectedName = `${reg.firstName} ${reg.lastName}`;

      // Act - redirectUrl points to /orgs, not dashboard
      const result = await registrationService.registerUser(
        reg.email,
        reg.password,
        reg.firstName,
        reg.lastName,
        `${SITE_URL}/orgs`
      );

      // Assert - only user + profile created, no tenant
      await validateRegistrationResult(result, reg.email, expectedName);
    });

    // proves AC-064-02
    it('rejects duplicate email registration', async () => {
      // Arrange
      const reg: RegistrationData = {
        email: uniqueEmail('test-duplicate'),
        password: 'TestPassword123!',
        firstName: 'Test',
        lastName: 'User',
      };

      // Act - First registration
      const firstResult = await registrationService.registerUser(
        reg.email,
        reg.password,
        reg.firstName,
        reg.lastName,
        `${SITE_URL}/orgs`
      );

      // Assert - First registration should succeed
      expect(firstResult).toHaveProperty('data');
      expect(firstResult).toHaveProperty('data');

      // Act - Second registration with same email
      const secondResult = await registrationService.registerUser(
        reg.email,
        'DifferentPassword123!',
        'Different',
        'User',
        `${SITE_URL}/orgs`
      );

      // Assert - Second registration should fail with generic error message
      expect(secondResult).toHaveProperty('error');
      expect((secondResult as any).error).toBe('Registration failed. Please try again or contact support if the problem persists.');
    });

    it.each([
      'gmail.com',
      'protonmail.com',
    ])('should succeed when registering with %s email domain', async (domain) => {
      // Arrange
      const uniqueUsername = `test-${crypto.randomUUID()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `${uniqueUsername}@${domain}`;

      // Act
      const result = await registrationService.registerUser(
        email,
        'TestPassword123!',
        'Test',
        'User',
        `${SITE_URL}/orgs`
      );

      // Assert - verify positive outcome: data with userId returned
      expect(result).toHaveProperty('data');
      expect(result.data).toHaveProperty('userId');
      expect(typeof result.data!.userId).toBe('string');
    });
  });

  // OAuth registration does not create a tenant
  describe('Google OAuth Registration', () => {
    it('creates user and profile on successful Google registration (no tenant)', async () => {
      // Arrange
      const userData: OAuthUserData = {
        email: uniqueEmail('test-google'),
        name: 'Test Google User',
        provider: 'google',
      };

      // Act
      const authUser = await createOAuthUser(userData);
      const result = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - only user + profile created
      await validateRegistrationResult(result, userData.email, userData.name);
    });
  });

  // GitHub OAuth registration does not create a tenant
  describe('GitHub OAuth Registration', () => {
    it('creates user and profile on successful GitHub registration (no tenant)', async () => {
      // Arrange
      const userData: OAuthUserData = {
        email: uniqueEmail('test-github'),
        name: 'Test GitHub User',
        provider: 'github',
        githubUsername: 'test-github-user',
      };

      // Act
      const authUser = await createOAuthUser(userData);
      const result = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - only user + profile created
      await validateRegistrationResult(result, userData.email, userData.name);
    });

    // proves AC-064-03
    it('is idempotent for duplicate OAuth registration', async () => {
      // Arrange
      const userData: OAuthUserData = {
        email: uniqueEmail('test-oauth-duplicate'),
        name: 'Test OAuth User',
        provider: 'github',
        githubUsername: 'test-oauth-user',
      };

      // Act - First registration
      const authUser = await createOAuthUser(userData);
      const firstResult = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - First registration should succeed (OAuth returns {userId} directly)
      expect(firstResult).toHaveProperty('userId');
      expect(typeof (firstResult as any).userId).toBe('string');

      // Act - Second registration with same user (should be idempotent)
      const secondResult = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - Second registration should return existing data (idempotent)
      expect(secondResult).toHaveProperty('userId');
      expect(typeof (secondResult as any).userId).toBe('string');
      // tenantId is not returned
      expect((secondResult as any).userId).toBe((firstResult as any).userId);
    });

    it.each([
      'gmail.com',
      'protonmail.com',
    ])('should succeed when OAuth registering with %s email domain', async (domain) => {
      // Arrange
      const uniqueUsername = `test-${crypto.randomUUID()}-${Math.random().toString(36).slice(2, 8)}`;
      const email = `${uniqueUsername}@${domain}`;
      const userData: OAuthUserData = {
        email,
        name: 'Test OAuth User',
        provider: 'google',
      };

      // Act
      const authUser = await createOAuthUser(userData);
      const result = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - verify positive outcome: userId returned
      expect(result).toHaveProperty('userId');
      expect(typeof (result as any).userId).toBe('string');
    });

    // proves AC-064-04
    it('saves GitHub username when user logs in with GitHub after registering with Google', async () => {
      // Arrange - Create user with Google OAuth first
      const email = uniqueEmail('test-github-link');
      const googleUserData: OAuthUserData = {
        email,
        name: 'Test User',
        provider: 'google',
      };

      // Act 1: Register with Google
      const googleAuthUser = await createOAuthUser(googleUserData);
      const googleRegistrationResult = await oauthRegistrationService.processOAuthRegistration(googleAuthUser);

      // Assert - Google registration should succeed (no tenantId)
      expect(googleRegistrationResult).toHaveProperty('userId');
      expect(typeof (googleRegistrationResult as any).userId).toBe('string');

      const userId = (googleRegistrationResult as any).userId;

      // Verify profile has no github_username yet
      const { data: profileBeforeGithub } = await adminClient
        .from('profile')
        .select('github_username')
        .eq('id', userId)
        .single();

      expect(profileBeforeGithub?.github_username).toBeNull();

      // Act 2: Link GitHub identity to the same user
      const githubUsername = `testuser-github-${crypto.randomUUID()}`;
      const { data: updatedUser } = await adminClient.auth.admin.getUserById(userId);

      // Simulate GitHub identity being added to the user (this happens when they link GitHub)
      const existingIdentities = updatedUser?.user?.identities || [];
      await adminClient.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...updatedUser?.user?.app_metadata,
          identities: [
            ...existingIdentities,
            {
              id: `github-${uuid()}`,
              provider: 'github',
              identity_data: {
                user_name: githubUsername,
                name: googleUserData.name,
              },
            },
          ],
        },
      });

      // Get the updated user to pass to processOAuthRegistration
      const { data: userWithGithub } = await adminClient.auth.admin.getUserById(userId);

      // Mock the identities array properly on the user object (Supabase structure)
      (userWithGithub!.user as any).identities = [
        {
          id: `google-${uuid()}`,
          user_id: userId,
          identity_id: uuid(),
          provider: 'google',
          identity_data: {
            email: email,
            name: googleUserData.name,
          },
        },
        {
          id: `github-${uuid()}`,
          user_id: userId,
          identity_id: uuid(),
          provider: 'github',
          identity_data: {
            user_name: githubUsername,
            name: googleUserData.name,
          },
        },
      ];

      // Act 3: Process OAuth registration again (simulates GitHub login)
      const githubLoginResult = await oauthRegistrationService.processOAuthRegistration(userWithGithub!.user!);

      // Assert - Should return existing user (idempotent, no tenantId)
      expect(githubLoginResult).toHaveProperty('userId');
      expect(typeof (githubLoginResult as any).userId).toBe('string');
      expect((githubLoginResult as any).userId).toBe(userId);

      // Verify github_username is now saved in profile
      const profileAfterGithub = await waitFor(async () => {
        const { data } = await adminClient
          .from('profile')
          .select('github_username')
          .eq('id', userId)
          .single();
        return data?.github_username ? data : null;
      });

      expect(profileAfterGithub).not.toBeNull();
      expect(profileAfterGithub.github_username).toBe(githubUsername);
    });

    /**
     * Verifies that OAuth registration is idempotent for users who have a
     * profile but no membership.
     *
     * The /auth/callback route checks for profile existence (not membership)
     * to determine if a user is new or existing.
     *
     * Scenario:
     * 1. User registers via OAuth → profile created, NO membership
     * 2. User logs out without creating an org
     * 3. User logs back in via OAuth
     * 4. System should recognize them as existing user (not redirect to terms-agreement?pending=true)
     */
    it('should treat user with profile but no membership as existing user (idempotent)', async () => {
      // Arrange - Create OAuth user with profile but no membership
      const userData: OAuthUserData = {
        email: uniqueEmail('test-profile-no-membership'),
        name: 'Profile No Membership User',
        provider: 'github',
        githubUsername: 'profile-no-membership-user',
      };

      // Act - First OAuth registration (creates profile, no membership)
      const authUser = await createOAuthUser(userData);
      const firstResult = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - First registration should succeed
      expect(firstResult).toHaveProperty('userId');
      const userId = (firstResult as any).userId;

      // Verify profile exists
      const { data: profile } = await adminClient
        .from('profile')
        .select('id')
        .eq('id', userId)
        .single();
      expect(profile).not.toBeNull();

      // Verify NO membership exists
      const { data: memberships } = await adminClient
        .from('membership')
        .select('id')
        .eq('user_id', userId);
      expect(memberships).toHaveLength(0);

      // Act - Second OAuth registration (simulates user logging back in)
      // This mirrors what /auth/callback does: check if user exists, then call processOAuthRegistration
      const secondResult = await oauthRegistrationService.processOAuthRegistration(authUser);

      // Assert - Should return same user (idempotent), not create new profile or error
      expect(secondResult).toHaveProperty('userId');
      expect((secondResult as any).userId).toBe(userId);

      // Verify still only one profile exists
      const { count: profileCount } = await adminClient
        .from('profile')
        .select('id', { count: 'exact', head: true })
        .eq('id', userId);
      expect(profileCount).toBe(1);
    });

    it('saves GitHub username when user logs in with GitHub after registering with email', async () => {
      // Arrange - Create user with email registration first
      const email = uniqueEmail('test-github-email-link');
      const reg: RegistrationData = {
        email,
        password: 'TestPassword123!',
        firstName: 'Test',
        lastName: 'User',
      };

      // Act 1: Register with email (no companyName)
      const emailRegistrationResult = await registrationService.registerUser(
        reg.email,
        reg.password,
        reg.firstName,
        reg.lastName,
        `${SITE_URL}/orgs`
      );

      // Assert - Email registration should succeed
      expect(emailRegistrationResult).toHaveProperty('data');
      expect(emailRegistrationResult.data).toHaveProperty('userId');

      const userId = emailRegistrationResult.data!.userId;

      // Verify profile has no github_username yet
      const { data: profileBeforeGithub } = await adminClient
        .from('profile')
        .select('github_username')
        .eq('id', userId)
        .single();

      expect(profileBeforeGithub?.github_username).toBeNull();

      // Act 2: Link GitHub identity to the same user
      const githubUsername = `testuser-github-${crypto.randomUUID()}`;
      const { data: updatedUser } = await adminClient.auth.admin.getUserById(userId);

      // Simulate GitHub identity being added to the user
      const existingIdentities = updatedUser?.user?.identities || [];
      await adminClient.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...updatedUser?.user?.app_metadata,
          identities: [
            ...existingIdentities,
            {
              id: `github-${uuid()}`,
              provider: 'github',
              identity_data: {
                user_name: githubUsername,
                name: `${reg.firstName} ${reg.lastName}`,
              },
            },
          ],
        },
      });

      // Get the updated user
      const { data: userWithGithub } = await adminClient.auth.admin.getUserById(userId);

      // Mock the identities array properly on the user object (cast to any to bypass strict typing)
      (userWithGithub!.user as any).identities = [
        {
          id: `email-${uuid()}`,
          user_id: userId,
          identity_id: uuid(),
          provider: 'email',
          identity_data: {
            email: email,
          },
        },
        {
          id: `github-${uuid()}`,
          user_id: userId,
          identity_id: uuid(),
          provider: 'github',
          identity_data: {
            user_name: githubUsername,
            name: `${reg.firstName} ${reg.lastName}`,
          },
        },
      ];

      // Act 3: Process OAuth registration (simulates GitHub login)
      const githubLoginResult = await oauthRegistrationService.processOAuthRegistration(userWithGithub!.user!);

      // Assert - Should return existing user (idempotent, no tenantId)
      expect(githubLoginResult).toHaveProperty('userId');
      expect(typeof (githubLoginResult as any).userId).toBe('string');
      expect((githubLoginResult as any).userId).toBe(userId);

      // Verify github_username is now saved in profile
      const profileAfterGithub = await waitFor(async () => {
        const { data } = await adminClient
          .from('profile')
          .select('github_username')
          .eq('id', userId)
          .single();
        return data?.github_username ? data : null;
      });

      expect(profileAfterGithub).not.toBeNull();
      expect(profileAfterGithub.github_username).toBe(githubUsername);
    });
  });
});
