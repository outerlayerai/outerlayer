/**
 * PlatformAdminGuard — the page-level gate on the INTERNAL admin surface.
 *
 * The deny branch is audit-critical: every authenticated user who reaches a
 * /platform-admin page without platform-admin rights must land in the audit
 * trail (with a denormalized actor_label so the record outlives the actor's
 * profile) before the guard 404s. This was the gap the first live demo
 * exposed — the guard is a separate code path from withPlatformAdminCheck.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from '@supabase/supabase-js';
import {
  seedSupabaseAuth,
  seedSupabaseMswState,
  getInsertedAuditLogRows,
} from '../../../test-helpers/msw-handlers';

// notFound()/redirect() halt rendering by throwing in Next; mimic that so
// the deny path is observable. (The global setup mock only covers hooks.)
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import PlatformAdminGuard from '../platform-admin-guard';

const outsider = {
  id: 'user-outsider',
  email: 'teammate@outerlayer.ai',
  app_metadata: { tenant_id: 'tenant-1', role: 'read' },
} as unknown as User;

describe('PlatformAdminGuard', () => {
  beforeEach(() => {
    seedSupabaseAuth({ user: outsider });
  });

  it('404s a non-admin AND records the denied visit with actor identity', async () => {
    // Authenticated, right email domain, but NO platform_user_role row.
    seedSupabaseMswState({ platformUserRoles: [] });

    await expect(
      PlatformAdminGuard({ children: 'internal-admin-ui' })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        actor_id: 'user-outsider',
        // Denormalized display identity — survives actor profile deletion.
        actor_label: 'teammate@outerlayer.ai',
        actor_type: 'human',
        action_type: 'permission_denied',
        target_type: 'permission',
        target_identifier: 'platform_admin',
        details: {
          scope: 'platform',
          reason: 'not_platform_admin',
          email: 'teammate@outerlayer.ai',
        },
      }),
    ]);
  });

  it('renders children for a platform admin and writes NO audit row', async () => {
    seedSupabaseMswState({
      platformUserRoles: [{ user_id: 'user-outsider', role: 'platform_admin' }],
    });

    const el = await PlatformAdminGuard({ children: 'internal-admin-ui' });

    // The guard renders a fragment wrapping exactly the protected children.
    expect(el.props).toEqual({ children: 'internal-admin-ui' });
    expect(getInsertedAuditLogRows()).toEqual([]);
  });
});
