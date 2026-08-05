import { getSupabaseAdmin } from '../../lib/test-utils';
import { TermsAgreementService } from 'tenant-dashboard/src/lib/system/terms-agreement';

/**
 * Integration tests for TermsAgreementService
 *
 * Tests the actual service methods against a real database.
 */

const TERMS_VERSION = '2026-01-10';

interface TestContext {
  userIds: string[];
}

describe('TermsAgreementService', () => {
  let supabaseAdmin: ReturnType<typeof getSupabaseAdmin>;
  let service: TermsAgreementService;

  beforeAll(() => {
    supabaseAdmin = getSupabaseAdmin();
    service = new TermsAgreementService({ supabaseAdmin });
  });

  // Helper to create test users
  async function createTestUsers(count: number): Promise<TestContext> {
    const timestamp = Date.now();
    const userIds: string[] = [];

    for (let i = 0; i < count; i++) {
      const email = `terms-svc-test-${timestamp}-${i}@test.com`;
      const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: 'TestPassword123!',
        email_confirm: true,
      });

      if (error || !authUser.user) {
        throw new Error(`Failed to create test user: ${error?.message}`);
      }

      userIds.push(authUser.user.id);

      await supabaseAdmin.from('profile').insert({
        id: authUser.user.id,
        email,
        name: `Test User ${i}`,
      });
    }

    return { userIds };
  }

  async function cleanupTestContext(ctx: TestContext): Promise<void> {
    for (const userId of ctx.userIds) {
      await supabaseAdmin.from('terms_agreement').delete().eq('user_id', userId);
      await supabaseAdmin.from('profile').delete().eq('id', userId);
      try {
        await supabaseAdmin.auth.admin.deleteUser(userId);
      } catch {
        // Ignore
      }
    }
  }

  describe('recordAgreement', () => {
    it('should create agreement record with correct fields', async () => {
      const ctx = await createTestUsers(1);
      const userId = ctx.userIds[0]!;

      try {
        const record = await service.recordAgreement({
          userId,
          termsVersion: TERMS_VERSION,
          ipAddress: '192.168.1.1',
          userAgent: 'Test Agent',
        });

        expect(record.userId).toBe(userId);
        expect(record.termsVersion).toBe(TERMS_VERSION);
        expect(record.ipAddress).toBe('192.168.1.1');
        expect(record.userAgent).toBe('Test Agent');
        expect(record.agreedAt).toBeInstanceOf(Date);
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should throw error when user agrees to same version twice', async () => {
      const ctx = await createTestUsers(1);
      const userId = ctx.userIds[0]!;

      try {
        await service.recordAgreement({
          userId,
          termsVersion: TERMS_VERSION,
        });

        await expect(
          service.recordAgreement({
            userId,
            termsVersion: TERMS_VERSION,
          })
        ).rejects.toThrow(`User has already agreed to terms version ${TERMS_VERSION}`);
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });

  describe('checkTermsStatus', () => {
    it('should return needsCurrentVersion=true when user never agreed', async () => {
      const ctx = await createTestUsers(1);
      const userId = ctx.userIds[0]!;

      try {
        const status = await service.checkTermsStatus(userId, TERMS_VERSION);

        // Assert full expected shape for "no agreement" case
        expect(status).toEqual({
          hasAgreed: false,
          needsCurrentVersion: true,
        });
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should return needsCurrentVersion=false when user agreed to current version', async () => {
      const ctx = await createTestUsers(1);
      const userId = ctx.userIds[0]!;

      try {
        await service.recordAgreement({
          userId,
          termsVersion: TERMS_VERSION,
        });

        const status = await service.checkTermsStatus(userId, TERMS_VERSION);

        expect(status.hasAgreed).toBe(true);
        expect(status.needsCurrentVersion).toBe(false);
        expect(status.agreedVersion).toBe(TERMS_VERSION);
      } finally {
        await cleanupTestContext(ctx);
      }
    });

    it('should return needsCurrentVersion=false when user agreed to old version (non-blocking policy)', async () => {
      // Per 002-terms-update-policy: Users with ANY agreement are never blocked
      // needsCurrentVersion=false means they won't be blocked, even with old version
      const ctx = await createTestUsers(1);
      const userId = ctx.userIds[0]!;

      try {
        await service.recordAgreement({
          userId,
          termsVersion: '2025-01-01',
        });

        const status = await service.checkTermsStatus(userId, TERMS_VERSION);

        expect(status.hasAgreed).toBe(true);
        expect(status.needsCurrentVersion).toBe(false); // Non-blocking: any agreement = not blocked
        expect(status.agreedVersion).toBe('2025-01-01');
      } finally {
        await cleanupTestContext(ctx);
      }
    });
  });
});
