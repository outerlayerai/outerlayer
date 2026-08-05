/**
 * Unit tests for the email-confirm route — `next` redirect resolution.
 *
 * Regression: invite/signup destinations carry their own query string
 * (`/auth/accept-invite?id=<membershipId>`) or arrive as a full URL from
 * GoTrue's `{{ .RedirectTo }}`. The route must round-trip path + query,
 * refuse off-site URLs, and never leak the inbound OTP params into the
 * destination.
 *
 * OTP verification goes through the real Supabase server client against
 * the shared MSW handlers (`seedSupabaseOtpVerification`).
 */
import { NextRequest } from 'next/server';
import type { User } from '@supabase/supabase-js';
import {
  seedSupabaseOtpVerification,
  seedMembershipMswState,
  seedSupabaseMswState,
  getProfileUpdateCalls,
} from '../../../test-helpers/msw-handlers';
import { serverLogger } from '@/lib/observability/server-logger';
import { GET } from './route';

// Not testing the broadcast-audience side effect — mock the email seam
vi.mock('../../../lib/external-services', () => ({
  createEmailService: vi.fn(() => ({
    addToBroadcastAudience: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

vi.mock('@/lib/observability/server-logger', () => ({
  serverLogger: {
    info: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
}));

const confirmedUser = {
  id: 'user-001',
  email: 'alice@example.com',
  user_metadata: {},
  app_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00.000Z',
} as User;

function buildConfirmRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/auth/confirm');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url.toString());
}

describe('auth confirm route — next redirect resolution', () => {
  it('round-trips a relative next path including its query string', async () => {
    seedSupabaseOtpVerification({ tokenHash: 'otp-token-123', user: confirmedUser });

    const response = await GET(
      buildConfirmRequest({
        token_hash: 'otp-token-123',
        type: 'email',
        next: '/auth/accept-invite?id=abc-123',
      }),
    );

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/accept-invite?id=abc-123',
    );
  });

  it('reduces a same-origin full URL next (GoTrue RedirectTo) to its path and query', async () => {
    seedSupabaseOtpVerification({ tokenHash: 'otp-token-123', user: confirmedUser });

    const response = await GET(
      buildConfirmRequest({
        token_hash: 'otp-token-123',
        type: 'email',
        next: 'http://localhost:3000/auth/accept-invite?id=abc-123',
      }),
    );

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/accept-invite?id=abc-123',
    );
  });

  it('falls back to the root path when next is an off-site URL', async () => {
    seedSupabaseOtpVerification({ tokenHash: 'otp-token-123', user: confirmedUser });

    const response = await GET(
      buildConfirmRequest({
        token_hash: 'otp-token-123',
        type: 'email',
        next: 'https://evil.example.com/auth/accept-invite?id=abc-123',
      }),
    );

    expect(response.headers.get('location')).toBe('http://localhost:3000/');
  });

  it('redirects to the link-expired page when the token is expired or already used', async () => {
    // No seeded verification — the verify handler answers with GoTrue's
    // otp_expired error shape. This is also the path a second click on an
    // invite link takes (the first click consumed the token), so the user
    // must get an explanation rather than a bare login screen.
    const response = await GET(
      buildConfirmRequest({
        token_hash: 'expired-token',
        type: 'invite',
        next: '/auth/new-password?flow=invite',
      }),
    );

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/link-expired',
    );
  });

  it('redirects to a clean login URL when token params are missing entirely', async () => {
    const response = await GET(buildConfirmRequest({ next: '/orgs' }));

    expect(response.headers.get('location')).toBe('http://localhost:3000/auth/login');
  });
});

/**
 * Invite activation records a `last_active_tenant_id` preference, gated on
 * the membership actually being activated first.
 */
describe('auth confirm route — invite activation and last-active preference', () => {
  function seedInviteConfirmRequest(tokenHash: string) {
    seedSupabaseOtpVerification({ tokenHash, user: confirmedUser });
    return buildConfirmRequest({
      token_hash: tokenHash,
      type: 'invite',
      next: '/auth/new-password?flow=invite',
    });
  }

  it('activates the pending membership and records it as the last-active org', async () => {
    seedMembershipMswState({
      memberships: [
        {
          id: 'm-1',
          user_id: confirmedUser.id,
          tenant_id: 'tenant-42',
          role: 'admin',
          status: 'pending',
        },
      ],
    });

    const response = await GET(seedInviteConfirmRequest('otp-token-activate'));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/auth/new-password?flow=invite',
    );
    // The preference comes from the membership row that was actually
    // activated, not from any other source (e.g. the inviter's tenant).
    expect(getProfileUpdateCalls()).toEqual([
      { id: confirmedUser.id, last_active_tenant_id: 'tenant-42' },
    ]);
  });

  it('does not write a preference when membership activation fails', async () => {
    seedMembershipMswState({ forceMembershipUpdateError: 'db unavailable' });

    await GET(seedInviteConfirmRequest('otp-token-activation-error'));

    expect(getProfileUpdateCalls()).toEqual([]);
    expect(serverLogger.error).toHaveBeenCalledWith(
      new Error('Failed to activate membership'),
      { userId: confirmedUser.id, updateError: 'db unavailable' },
    );
  });

  it('does not write a preference when there is no pending membership to activate', async () => {
    // No membership seeded at all — the PATCH matches zero rows, which
    // PostgREST reports as an empty array, not an error. A mutant that
    // flips `activatedMemberships.length > 0` to `>= 0` (or drops the
    // `activatedMemberships &&` guard) would proceed to the preference write
    // anyway, with an undefined tenant_id.
    await GET(seedInviteConfirmRequest('otp-token-no-pending'));

    expect(getProfileUpdateCalls()).toEqual([]);
    expect(serverLogger.error).not.toHaveBeenCalledWith(
      new Error('Failed to activate membership'),
      expect.anything(),
    );
  });

  it('logs the error when the preference write fails', async () => {
    seedMembershipMswState({
      memberships: [
        {
          id: 'm-2',
          user_id: confirmedUser.id,
          tenant_id: 'tenant-42',
          role: 'admin',
          status: 'pending',
        },
      ],
    });
    seedSupabaseMswState({ tableErrors: { profile_update: { message: 'pg: forbidden' } } });

    await GET(seedInviteConfirmRequest('otp-token-preference-error'));

    expect(serverLogger.error).toHaveBeenCalledWith(
      new Error('Failed to record last-active org'),
      { userId: confirmedUser.id, tenantId: 'tenant-42', preferenceError: 'pg: forbidden' },
    );
    expect(serverLogger.info).not.toHaveBeenCalledWith(
      'Auto-activated membership for invited user',
      expect.anything(),
    );
  });
});
