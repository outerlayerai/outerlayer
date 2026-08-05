/**
 * Tests: resolveAgentSessionScope — the actor-privacy policy seam.
 *
 * Boundary choice per the testing rules: MSW seeds the underlying Supabase
 * HTTP traffic (auth user, `app_authorize` RPC, the `membership` table read),
 * so the resolver's real permission checks and membership lookup execute
 * end-to-end. The route tests mock THIS module as a seam; this file is where
 * its own behavior is pinned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { ForbiddenError } from '@repo/observability-service';
import {
  seedSupabaseAuth,
  seedPermissionsMswState,
  seedMembershipMswState,
} from '@/test-helpers/msw-handlers';
import { resolveAgentSessionScope, scopedActorId, NO_ACTOR_SENTINEL } from './scope';
import type { TenantContext } from '@/lib/analytics/tenant-context';

vi.mock('server-only', () => ({}));

const mockUser: User = {
  id: 'user-1',
  email: 'dev@example.com',
  app_metadata: { tenant_id: 'tenant-1', role: 'write' },
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};

const context = Object.freeze({
  userId: 'user-1',
  tenantId: 'tenant-1',
  appId: 'app-1',
  dataRetentionDays: -1,
}) as unknown as TenantContext;

const SELF = 'agents.sessions.self.read';
const TEAM = 'agents.sessions.team.read';

beforeEach(() => {
  vi.clearAllMocks();
  seedSupabaseAuth({ user: mockUser });
});

describe('resolveAgentSessionScope', () => {
  it('team.read wins: returns team scope (no actor pin)', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'app-1': [SELF, TEAM] } });
    const scope = await resolveAgentSessionScope(context);
    expect(scope).toEqual({ kind: 'team' });
    expect(scopedActorId(scope)).toBeNull();
  });

  it('self.read only: resolves the caller membership as the pinned actor', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'app-1': [SELF] } });
    seedMembershipMswState({
      memberships: [
        { id: 'mem-me', user_id: 'user-1', tenant_id: 'tenant-1', role: 'write', status: 'active' },
        { id: 'mem-other', user_id: 'user-2', tenant_id: 'tenant-1', role: 'write', status: 'active' },
      ],
    });
    const scope = await resolveAgentSessionScope(context);
    expect(scope).toEqual({ kind: 'self', actorId: 'mem-me' });
    expect(scopedActorId(scope)).toBe('mem-me');
  });

  it('neither permission: throws ForbiddenError (no silent fallback to anything)', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'app-1': [] } });
    await expect(resolveAgentSessionScope(context)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('self.read with no membership row: pins to the impossible sentinel (fail closed, never team-wide)', async () => {
    seedPermissionsMswState({ allowedAppPermissions: { 'app-1': [SELF] } });
    seedMembershipMswState({ memberships: [] });
    const scope = await resolveAgentSessionScope(context);
    expect(scope).toEqual({ kind: 'self', actorId: null });
    expect(scopedActorId(scope)).toBe(NO_ACTOR_SENTINEL);
  });
});
