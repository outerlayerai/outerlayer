/**
 * @vitest-environment node
 *
 * Integration tests for PlatformAdminGuard and isPlatformAdmin
 * Tests guard logic, email domain check, and platform_user_role lookup
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = 'test-service-role-key';

vi.unmock('../../../config-global');

vi.mock('../../../sections/error/403-view', () => ({
  __esModule: true,
  default: () => null,
}));

import {
  seedPlatformAdminAccess,
  seedSupabaseAuth,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';
import { isPlatformAdmin, getPlatformRole } from '../../../auth/guard/platform-admin-guard';

const mockPlatformAdminUser = {
  id: 'admin-user-id-123',
  email: 'admin@outerlayer.ai',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
};

const mockNonAgentmarkUser = {
  id: 'user-id-456',
  email: 'user@example.com',
};

const mockAgentmarkUserWithoutRole = {
  id: 'user-id-789',
  email: 'norole@outerlayer.ai',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
};

describe('Platform Admin Guard (MSW)', () => {
  describe('isPlatformAdmin', () => {
    it('should return false for non-@outerlayer.ai email', async () => {
      const result = await isPlatformAdmin(
        mockNonAgentmarkUser.id,
        mockNonAgentmarkUser.email,
      );

      expect(result).toBe(false);
    });

    it('should return false for @outerlayer.ai user without platform role', async () => {
      seedSupabaseAuth({ user: mockAgentmarkUserWithoutRole as any });
      seedSupabaseMswState({
        profiles: [
          {
            id: mockAgentmarkUserWithoutRole.id,
            email: mockAgentmarkUserWithoutRole.email,
          },
        ],
      });

      const result = await isPlatformAdmin(
        mockAgentmarkUserWithoutRole.id,
        mockAgentmarkUserWithoutRole.email,
      );

      expect(result).toBe(false);
    });

    it('should return true for @outerlayer.ai user with platform_admin role', async () => {
      seedPlatformAdminAccess(mockPlatformAdminUser as any);

      const result = await isPlatformAdmin(
        mockPlatformAdminUser.id,
        mockPlatformAdminUser.email,
      );

      expect(result).toBe(true);
    });

    it('should handle case-insensitive email domain check', async () => {
      const result = await isPlatformAdmin('user-id', 'user@AGENTMARK.CO');

      expect(result).toBe(false);
    });
  });

  describe('getPlatformRole', () => {
    it('should return platform_admin role for valid platform admin', async () => {
      seedPlatformAdminAccess(mockPlatformAdminUser as any);

      const result = await getPlatformRole(mockPlatformAdminUser.id);

      expect(result).toBe('platform_admin');
    });

    it('should return null for user without platform role', async () => {
      const result = await getPlatformRole(mockAgentmarkUserWithoutRole.id);

      expect(result).toBeNull();
    });
  });
});

describe('Platform Admin Guard - Email Domain Validation (MSW)', () => {
  it('should only allow @outerlayer.ai emails', async () => {
    const testCases = [
      { email: 'user@outerlayer.ai', userId: 'user-1', shouldCheckDb: true },
      { email: 'user@gmail.com', userId: 'user-2', shouldCheckDb: false },
      { email: 'user@outerlayer.com', userId: 'user-3', shouldCheckDb: false },
      { email: 'user@subdomain.outerlayer.ai', userId: 'user-4', shouldCheckDb: false },
      { email: 'outerlayer.ai@gmail.com', userId: 'user-5', shouldCheckDb: false },
      { email: '', userId: 'user-6', shouldCheckDb: false },
    ];

    for (const { email, userId, shouldCheckDb } of testCases) {
      if (shouldCheckDb) {
        seedSupabaseMswState({
          platformUserRoles: [{ user_id: userId, role: 'platform_admin' }],
        });
      }

      const result = await isPlatformAdmin(userId, email);
      expect(result).toBe(shouldCheckDb);
    }
  });
});
