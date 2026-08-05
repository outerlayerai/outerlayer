// @vitest-environment node
/**
 * Tests: withPlatformAdminCheck — the server-action half of the platform-admin
 * boundary.
 *
 * Both gates have to be pinned independently, because either one passing alone
 * must still deny:
 *   1. the email is on an allowed platform-admin domain
 *   2. the user has a `platform_user_role` row
 *
 * Supabase is an HTTP boundary → MSW seed helpers, per the app's testing rules.
 * The audit-log service is an internal seam → mocked, and asserted on, since a
 * denial that isn't recorded is a hole in the internal-tool audit trail.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = 'test-service-role-key';

vi.unmock('../../../config-global');

const auditCreate = vi.hoisted(() => vi.fn());
// A class, not an arrow: the wrapper calls `new AuditLogService(...)`.
vi.mock('@/lib/system/audit-log', () => ({
  AuditLogService: class {
    create = auditCreate;
  },
}));

import {
  seedPlatformAdminAccess,
  seedSupabaseAuth,
  resetMswState,
} from '@/test-helpers/msw-handlers';
import { withPlatformAdminCheck } from '../utils/with-platform-admin-check';

const onAllowedDomain = {
  id: 'admin-user-id-123',
  email: 'admin@outerlayer.ai',
  aud: 'authenticated',
  role: 'authenticated',
  app_metadata: {},
  user_metadata: {},
};

/** Holds a platform_user_role row but sits on a domain that is NOT allowed. */
const offAllowedDomain = {
  ...onAllowedDomain,
  id: 'outsider-user-id-456',
  email: 'attacker@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetMswState();
  auditCreate.mockResolvedValue(undefined);
});

describe('withPlatformAdminCheck', () => {
  it('runs the action for a user on an allowed domain WITH a platform role', async () => {
    seedPlatformAdminAccess(onAllowedDomain as never);
    const action = vi.fn().mockResolvedValue({ data: 'ran' });

    const result = await withPlatformAdminCheck(action);

    expect(result).toEqual({ data: 'ran' });
    expect(action).toHaveBeenCalledWith({
      id: onAllowedDomain.id,
      email: onAllowedDomain.email,
      platformRole: 'platform_admin',
    });
  });

  // The mutant this kills: `if (false)` in place of the domain check. This user
  // HAS a platform_user_role row, so only the domain check can deny them —
  // delete it and they get in.
  it('denies a user who has a platform role but is off the allowed domain, and never runs the action', async () => {
    seedPlatformAdminAccess(offAllowedDomain as never);
    const action = vi.fn();

    const result = await withPlatformAdminCheck(action);

    expect(result).toEqual({
      error: 'Access denied. Platform admin requires a @outerlayer.ai email.',
    });
    expect(action).not.toHaveBeenCalled();
  });

  it('records the denial reason as email_domain so the audit trail distinguishes the two gates', async () => {
    seedPlatformAdminAccess(offAllowedDomain as never);

    await withPlatformAdminCheck(vi.fn());

    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: offAllowedDomain.id,
        actionType: 'permission_denied',
        targetIdentifier: 'platform_admin',
        details: expect.objectContaining({ reason: 'email_domain' }),
      }),
    );
  });

  it('denies a user on the allowed domain WITHOUT a platform role', async () => {
    // The other direction: domain alone grants nothing.
    seedSupabaseAuth({ user: onAllowedDomain as never });
    const action = vi.fn();

    const result = await withPlatformAdminCheck(action);

    expect(result).toEqual({ error: 'Access denied. Platform admin role required.' });
    expect(action).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'not_platform_admin' }) }),
    );
  });

  it('denies an unauthenticated caller without auditing (no actor to attribute)', async () => {
    const action = vi.fn();

    const result = await withPlatformAdminCheck(action);

    // Surfaces the auth layer's own reason rather than a generic denial, which
    // is what distinguishes "no session" from the two authorization gates.
    expect(result).toEqual({ error: 'Auth session missing!' });
    expect(action).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
