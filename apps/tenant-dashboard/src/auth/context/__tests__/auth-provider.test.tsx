// @vitest-environment jsdom
/**
 * AuthProvider reacts to supabase auth-lifecycle events.
 *
 * A session can die server-side (revoked tokens, a tenant-claim flip, another
 * tab signing out) with no explicit logout() call in this React tree.
 * supabase-js surfaces that as a SIGNED_OUT event on onAuthStateChange; the
 * provider must clear context so downstream guards stop treating the user as
 * authenticated.
 */
import React, { useContext, useEffect } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useParams } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import posthog from 'posthog-js';
import * as Sentry from '@/lib/observability/error-reporting/sentry';

import { AuthContext } from '../auth-context';
import { server } from '../../../test-helpers/msw-server';

// login() calls this 'use server' action on success; outside a real Next.js
// request scope next/cache's revalidatePath throws, so this seam is stubbed
// the same way the project's own testing rules call out (revalidatePath is
// an allowed mock target, not an HTTP boundary).
vi.mock('@/utils/actions', () => ({
  revalidateServerPath: vi.fn(),
}));

// onAuthStateChange is a client-side event emitter, not an HTTP boundary, so
// MSW cannot drive it. The frontend client is a dashboard-owned seam: this mock
// returns a real browser client (its `from()` reads still cross MSW) whose auth
// listener is captured so the test can emit lifecycle events directly.
let capturedCallback:
  | ((event: string, session: Session | null) => void)
  | undefined;
let capturedSignInWithPassword: ReturnType<typeof vi.fn> | undefined;

vi.mock('@/supabaseFrontendClient', async () => {
  const { createBrowserClient } = await import('@supabase/ssr');
  return {
    createSupabaseFontendClient: () => {
      const client = createBrowserClient('http://localhost:54321', 'test-anon-key', {
        isSingleton: false,
      });
      vi.spyOn(client.auth, 'onAuthStateChange').mockImplementation(((cb: unknown) => {
        capturedCallback = cb as typeof capturedCallback;
        return {
          data: { subscription: { id: 'test', callback: cb, unsubscribe: vi.fn() } },
        };
      }) as never);
      capturedSignInWithPassword = vi.spyOn(client.auth, 'signInWithPassword') as unknown as ReturnType<typeof vi.fn>;
      return client;
    },
  };
});

vi.mock('posthog-js', () => ({
  default: {
    __loaded: false,
    init: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('@/lib/observability/error-reporting/sentry', () => ({
  setUser: vi.fn(),
  setTag: vi.fn(),
}));

// Import after mocks so the provider picks up the mocked frontend client.
import { AuthProvider } from '../auth-provider';

let capturedLogin: ((email: string, password: string) => Promise<void>) | undefined;

function AuthProbe() {
  const ctx = useContext(AuthContext);
  useEffect(() => {
    capturedLogin = ctx.login;
  });
  const status = ctx.loading
    ? 'loading'
    : ctx.authenticated
      ? 'authenticated'
      : 'unauthenticated';
  return (
    <>
      <span data-testid="status">{status}</span>
      <span data-testid="role">{String(ctx.user?.role)}</span>
      <span data-testid="active-tenant">{String(ctx.user?.activeTenant?.tenant_id)}</span>
    </>
  );
}

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: 9999999999,
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'user@example.com',
    app_metadata: { tenant_id: 'tenant-1' },
    user_metadata: { display_name: 'Test User' },
  },
} as unknown as Session;

beforeEach(() => {
  capturedCallback = undefined;
});

describe('AuthProvider auth-state lifecycle', () => {
  it('drops from authenticated to unauthenticated when supabase emits SIGNED_OUT', async () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    // The provider subscribes on mount; drive an authenticated session through
    // the captured listener.
    expect(capturedCallback).toBeInstanceOf(Function);
    capturedCallback!('INITIAL_SESSION', session);
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    // The session dies server-side and supabase-js reports SIGNED_OUT with no
    // session. Context must reflect the death — the redirect-loop bug this
    // guards against starts with context that stays `authenticated: true` here.
    capturedCallback!('SIGNED_OUT', null);
    await waitFor(
      () => {
        expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
      },
      { timeout: 3000 },
    );

    // Session death must tear down analytics + error-tracking identity the same
    // way an explicit logout does — reset() is only reached on SIGNED_OUT here,
    // never on the INITIAL_SESSION identify path.
    expect(posthog.reset).toHaveBeenCalledTimes(1);
    expect(Sentry.setUser).toHaveBeenLastCalledWith(null);
  });

  it('does not query the tenant table when the session has no tenant_id claim yet', async () => {
    // A freshly-created user (mid-registration, before creating/joining an
    // org) has no app_metadata.tenant_id. Regression guard for a bug where
    // the tenant fetch ran unconditionally and sent the literal string
    // "undefined" as tenant_id, 22P02-ing on Postgres on every session event.
    const preOnboardingSession = {
      ...session,
      user: { ...session.user, app_metadata: {} },
    } as unknown as Session;

    let tenantRequestCount = 0;
    server.use(
      http.get('http://localhost:54321/rest/v1/tenant', () => {
        tenantRequestCount += 1;
        return HttpResponse.json([]);
      }),
    );

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(capturedCallback).toBeInstanceOf(Function);
    capturedCallback!('INITIAL_SESSION', preOnboardingSession);
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    expect(tenantRequestCount).toBe(0);
  });

  it('does not query the tenant table on TOKEN_REFRESHED when the session still has no tenant_id claim', async () => {
    // Token refresh happens automatically in the background for as long as a
    // tab stays open — this is the highest-volume real-world trigger for the
    // undefined-tenant_id bug, since a user mid-onboarding can sit on the
    // /orgs page for a while before creating or joining an org.
    const preOnboardingSession = {
      ...session,
      user: { ...session.user, app_metadata: {} },
    } as unknown as Session;

    let tenantRequestCount = 0;
    let membershipRequestCount = 0;
    server.use(
      http.get('http://localhost:54321/rest/v1/tenant', () => {
        tenantRequestCount += 1;
        return HttpResponse.json([]);
      }),
      http.get('http://localhost:54321/rest/v1/membership', () => {
        membershipRequestCount += 1;
        return HttpResponse.json([]);
      }),
    );

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(capturedCallback).toBeInstanceOf(Function);
    capturedCallback!('INITIAL_SESSION', preOnboardingSession);
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    // fetchUserMemberships always runs on TOKEN_REFRESHED regardless of
    // tenant_id, so its call count is a reliable signal that the handler's
    // async work has finished — unlike the tenant fetch, which should never
    // fire at all here.
    const membershipCallsBeforeRefresh = membershipRequestCount;
    capturedCallback!('TOKEN_REFRESHED', preOnboardingSession);
    await waitFor(() => {
      expect(membershipRequestCount).toBeGreaterThan(membershipCallsBeforeRefresh);
    });

    expect(tenantRequestCount).toBe(0);
  });

  it('does not query the tenant table on login when the account has no tenant_id claim yet', async () => {
    // A brand-new account can log in before it has created or joined an
    // org — same undefined-tenant_id window as the other lifecycle events,
    // reached through login() instead of onAuthStateChange.
    const preOnboardingUser = { ...session.user, app_metadata: {} };

    let tenantRequestCount = 0;
    server.use(
      http.get('http://localhost:54321/rest/v1/tenant', () => {
        tenantRequestCount += 1;
        return HttpResponse.json([]);
      }),
    );

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(capturedSignInWithPassword).toBeInstanceOf(Function);
    capturedSignInWithPassword!.mockResolvedValueOnce({
      data: {
        user: preOnboardingUser,
        session: { ...session, user: preOnboardingUser },
      },
      error: null,
    });

    expect(capturedLogin).toBeInstanceOf(Function);
    await act(async () => {
      await capturedLogin!('user@example.com', 'password');
    });

    expect(tenantRequestCount).toBe(0);
  });
});

describe('AuthProvider — activeTenant/role follow the URL org, never the JWT claim', () => {
  const membershipRows = [
    {
      id: 'm-a',
      user_id: 'user-1',
      tenant_id: 'tenant-a',
      role: 'owner',
      status: 'active',
      invited_at: null,
      invited_by: null,
      expires_at: null,
      created_at: '2026-01-01T00:00:00Z',
      tenant: { tenant_id: 'tenant-a', organization_name: 'org-a', company_name: 'Org A' },
    },
    {
      id: 'm-b',
      user_id: 'user-1',
      tenant_id: 'tenant-b',
      role: 'read',
      status: 'active',
      invited_at: null,
      invited_by: null,
      expires_at: null,
      created_at: '2026-01-01T00:00:00Z',
      tenant: { tenant_id: 'tenant-b', organization_name: 'org-b', company_name: 'Org B' },
    },
  ];

  // The claim names tenant-b (role 'read'); the URL is org-a. Only the URL
  // org may ever answer for role/activeTenant.
  const sessionWithClaimOnOrgB = {
    ...session,
    user: { ...session.user, app_metadata: { tenant_id: 'tenant-b' } },
  } as unknown as Session;

  beforeEach(() => {
    server.use(
      http.get('http://localhost:54321/rest/v1/membership', () =>
        HttpResponse.json(membershipRows),
      ),
    );
  });

  it('resolves role/activeTenant from the URL org, ignoring a claim naming a different org', async () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'org-a' });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    capturedCallback!('INITIAL_SESSION', sessionWithClaimOnOrgB);

    await waitFor(() => {
      expect(screen.getByTestId('active-tenant').textContent).toBe('tenant-a');
    });
    expect(screen.getByTestId('role').textContent).toBe('owner');
  });

  it('resolves no active tenant or role when the URL carries no org, even though the claim names one', async () => {
    vi.mocked(useParams).mockReturnValue({});

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    capturedCallback!('INITIAL_SESSION', sessionWithClaimOnOrgB);

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('active-tenant').textContent).toBe('undefined');
    expect(screen.getByTestId('role').textContent).toBe('undefined');
  });
});
