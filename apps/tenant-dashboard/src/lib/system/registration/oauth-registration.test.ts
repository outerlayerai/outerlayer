/**
 * Unit tests for OAuthRegistrationService — display name resolution logic.
 *
 * The display name resolution chain (lines 82-90 of oauth-registration.ts)
 * determines how a user's name is derived during new-user registration:
 *
 *   meta.full_name
 *   || custom_claims.full_name
 *   || meta.name
 *   || custom_claims.name
 *   || [meta.first_name ?? custom.first_name, meta.last_name ?? custom.last_name].join(' ')
 *   || user.email
 *
 * These tests verify every branch of this fallback chain plus edge cases
 * like empty strings and mixed sources.
 *
 * One behavior per test, named `should [outcome] when [condition]`.
 */

import type { User } from '@supabase/supabase-js';
import * as adminClientModule from '../admin-client';
import { OAuthRegistrationService } from './oauth-registration';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockInsert = vi.fn();
const mockMaybeSingle = vi.fn();

const mockChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: mockMaybeSingle,
  insert: mockInsert,
  update: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
};

vi.mock('../../adapters/server-error-log', () => ({
  logServerInfo: vi.fn().mockResolvedValue(undefined),
  logServerError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../utils/scrub-email', () => ({
  scrubEmail: vi.fn((email: string) => email),
}));


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<User> & { user_metadata?: Record<string, unknown> } = {}): User {
  return {
    id: 'user-uuid-001',
    email: 'alice@example.com',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as User;
}

/**
 * Configure the mock chain so the profile lookup returns null (new user path)
 * and the profile insert succeeds.
 */
function setupNewUserMocks() {
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockInsert.mockResolvedValue({ error: null });
}

/**
 * Extracts the `name` value passed to `.insert()` after calling processOAuthRegistration.
 */
async function getInsertedDisplayName(user: User): Promise<string> {
  const service = new OAuthRegistrationService();
  await service.processOAuthRegistration(user);

  const insertCall = mockInsert.mock.calls[0]!;
  return insertCall[0].name;
}

// ---------------------------------------------------------------------------
// Tests: display name resolution chain
// ---------------------------------------------------------------------------

describe('OAuthRegistrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupNewUserMocks();
    vi.spyOn(adminClientModule, 'getAdminDataClient').mockReturnValue({
      from: vi.fn().mockReturnValue(mockChain),
    } as any);
  });

  describe('display name resolution', () => {
    it('should use meta.full_name when present', async () => {
      const user = makeUser({
        user_metadata: { full_name: 'Alice Wonderland' },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Alice Wonderland');
    });

    it('should use custom_claims.full_name when meta.full_name is missing', async () => {
      const user = makeUser({
        user_metadata: {
          custom_claims: { full_name: 'Bob Builder' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Bob Builder');
    });

    it('should prefer meta.full_name over custom_claims.full_name when both present', async () => {
      const user = makeUser({
        user_metadata: {
          full_name: 'Alice Meta',
          custom_claims: { full_name: 'Alice Custom' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Alice Meta');
    });

    it('should use meta.name when full_name fields are missing', async () => {
      const user = makeUser({
        user_metadata: { name: 'Charlie Chrome' },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Charlie Chrome');
    });

    it('should use custom_claims.name when meta.name and full_name fields are missing', async () => {
      const user = makeUser({
        user_metadata: {
          custom_claims: { name: 'Diana Debug' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Diana Debug');
    });

    it('should prefer custom_claims.full_name over meta.name', async () => {
      const user = makeUser({
        user_metadata: {
          name: 'Meta Name',
          custom_claims: { full_name: 'Custom Full Name' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Custom Full Name');
    });

    it('should join meta.first_name and meta.last_name when name fields are missing', async () => {
      const user = makeUser({
        user_metadata: {
          first_name: 'Eve',
          last_name: 'Engineer',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Eve Engineer');
    });

    it('should join custom_claims.first_name and custom_claims.last_name for SAML users', async () => {
      const user = makeUser({
        user_metadata: {
          custom_claims: {
            first_name: 'jackson',
            last_name: 'jackson',
          },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('jackson jackson');
    });

    it('should merge meta.first_name with custom_claims.last_name when mixed', async () => {
      const user = makeUser({
        user_metadata: {
          first_name: 'Frank',
          custom_claims: { last_name: 'Firmware' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Frank Firmware');
    });

    it('should merge custom_claims.first_name with meta.last_name when mixed', async () => {
      const user = makeUser({
        user_metadata: {
          last_name: 'Garcia',
          custom_claims: { first_name: 'Grace' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Grace Garcia');
    });

    it('should use only first_name when last_name is missing', async () => {
      const user = makeUser({
        user_metadata: {
          first_name: 'Hank',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Hank');
    });

    it('should use only last_name when first_name is missing', async () => {
      const user = makeUser({
        user_metadata: {
          last_name: 'Harbor',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Harbor');
    });

    it('should fall back to user.email when no name metadata is set', async () => {
      const user = makeUser({
        email: 'fallback@example.com',
        user_metadata: {},
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('fallback@example.com');
    });

    it('should fall back to user.email when user_metadata is undefined', async () => {
      const user = makeUser({
        email: 'nometadata@example.com',
      });
      // Simulate GoTrue returning undefined user_metadata
      (user as any).user_metadata = undefined;

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('nometadata@example.com');
    });

    it('should skip meta.full_name when it is an empty string', async () => {
      const user = makeUser({
        user_metadata: {
          full_name: '',
          name: 'Fallback Name',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Fallback Name');
    });

    it('should skip custom_claims.full_name when it is an empty string', async () => {
      const user = makeUser({
        user_metadata: {
          custom_claims: { full_name: '', name: 'Custom Name' },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Custom Name');
    });

    it('should skip meta.name when it is an empty string', async () => {
      const user = makeUser({
        user_metadata: {
          name: '',
          first_name: 'Iris',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Iris');
    });

    it('should skip custom_claims.name when it is an empty string', async () => {
      const user = makeUser({
        user_metadata: {
          custom_claims: { name: '' },
          first_name: 'Jake',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Jake');
    });

    it('should fall back to email when all name fields are empty strings', async () => {
      const user = makeUser({
        email: 'empty@example.com',
        user_metadata: {
          full_name: '',
          name: '',
          first_name: '',
          last_name: '',
          custom_claims: {
            full_name: '',
            name: '',
            first_name: '',
            last_name: '',
          },
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('empty@example.com');
    });

    it('should prefer meta.first_name over custom_claims.first_name in the join', async () => {
      const user = makeUser({
        user_metadata: {
          first_name: 'MetaFirst',
          custom_claims: {
            first_name: 'CustomFirst',
            last_name: 'SharedLast',
          },
        },
      });

      const name = await getInsertedDisplayName(user);

      // meta.first_name ?? custom.first_name => 'MetaFirst'
      // meta.last_name ?? custom.last_name => 'SharedLast' (meta.last_name is undefined)
      expect(name).toBe('MetaFirst SharedLast');
    });

    it('should prefer meta.last_name over custom_claims.last_name in the join', async () => {
      const user = makeUser({
        user_metadata: {
          last_name: 'MetaLast',
          custom_claims: {
            first_name: 'CustomFirst',
            last_name: 'CustomLast',
          },
        },
      });

      const name = await getInsertedDisplayName(user);

      // meta.first_name ?? custom.first_name => 'CustomFirst' (meta is undefined)
      // meta.last_name ?? custom.last_name => 'MetaLast'
      expect(name).toBe('CustomFirst MetaLast');
    });

    it('should handle custom_claims being absent entirely', async () => {
      const user = makeUser({
        user_metadata: {
          // no custom_claims key at all
          first_name: 'Karen',
          last_name: 'Kernel',
        },
      });

      const name = await getInsertedDisplayName(user);

      expect(name).toBe('Karen Kernel');
    });
  });

  describe('processOAuthRegistration return value', () => {
    it('should return userId without tenantId for new user registration', async () => {
      const user = makeUser({ user_metadata: { full_name: 'Test User' } });

      const service = new OAuthRegistrationService();
      const result = await service.processOAuthRegistration(user);

      expect(result).toEqual({ userId: 'user-uuid-001' });
    });

    it('should return error when email is missing', async () => {
      const user = makeUser();
      (user as any).email = undefined;

      const service = new OAuthRegistrationService();
      const result = await service.processOAuthRegistration(user);

      expect(result).toEqual({ error: 'Email is required for registration.' });
    });
  });
});
