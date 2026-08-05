/**
 * Unit tests for the auth callback route — SSO-specific behaviour.
 *
 * The route handles OAuth code exchange and, when the authenticated method
 * is "sso/saml", records the login in the sso_identity table.
 *
 * Only SSO-specific branches are tested here. Git provider identity linking
 * and the general registration flow are tested elsewhere.
 *
 * One behavior per test, named `should [outcome] when [condition]`.
 */

import { NextResponse } from 'next/server';
import * as supabaseServerClientModule from '../../../supabaseServerClient';
import * as supabaseAdminClientModule from '../../../supabaseAdminClient';
import { GET } from './route';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: vi.fn().mockImplementation((url: string) => ({ type: 'redirect', url })),
  },
}));

// Not testing git identity logic — mock to no-ops
vi.mock('../../../lib/system/git/github/oauth', () => ({
  saveGitHubIdentity: vi.fn().mockResolvedValue(undefined),
}));

// Provide real path shapes the route uses
vi.mock('../../../routes/paths', () => ({
  paths: {
    orgs: { root: '/orgs' },
    profile: { root: '/profile' },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an admin client mock where each table can have custom behaviour.
 * Unregistered tables fall back to a chainable no-op that resolves to null.
 */
function createAdminMock(tableMocks: Record<string, object> = {}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (tableMocks[table]) {
        return tableMocks[table];
      }
      // Default: chainable no-op terminating at maybeSingle / upsert
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        contains: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
  };
}

/**
 * Build a server Supabase client mock that successfully exchanges a code
 * and returns the given user.
 */
function createServerClientMock(user: object | null, profileExists = true) {
  const adminMockForProfile = createAdminMock({
    profile: {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: profileExists ? { id: (user as any)?.id ?? 'user-001' } : null,
        error: null,
      }),
    },
  });

  return {
    auth: {
      exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      getSession: vi.fn().mockResolvedValue({
        data: { session: { provider_token: null, provider_refresh_token: null } },
      }),
      getUserIdentities: vi.fn().mockResolvedValue({ data: { identities: [] } }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    _adminMockForProfile: adminMockForProfile,
  };
}

/** Build a Request for the callback route with a code query param. */
function buildCallbackRequest(params: Record<string, string> = { code: 'test-auth-code' }): Request {
  const url = new URL('http://localhost:3000/auth/callback');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new Request(url.toString());
}

/** User fixture with sso/saml AMR. */
function makeSSOUser(overrides: object = {}) {
  return {
    id: 'user-sso-001',
    email: 'alice@example.com',
    app_metadata: {
      amr: [{ method: 'sso/saml', timestamp: 1700000000 }],
      provider_id: 'saml-ext-subject-1',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth callback route — SSO identity upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient');
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient');
  });

  it('should upsert SSO identity when AMR contains sso/saml', async () => {
    const user = makeSSOUser({ email: 'alice@example.com' });
    const ssoUpsertMock = vi.fn().mockResolvedValue({ data: null, error: null });

    const ssoConfigChain = {
      select: vi.fn().mockReturnThis(),
      contains: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'sso-cfg-1', tenant_id: 'tenant-001' },
        error: null,
      }),
    };

    const adminMock = createAdminMock({
      sso_config: ssoConfigChain,
      sso_identity: {
        upsert: ssoUpsertMock,
      },
      profile: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: user.id }, error: null }),
      },
    });

    const serverClient = createServerClientMock(user);
    vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue(serverClient as any);
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue(adminMock as any);

    await GET(buildCallbackRequest());

    expect(ssoUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: user.id }),
      { onConflict: 'tenant_id,user_id' },
    );
  });

  it('should skip SSO identity upsert when no sso_config matches domain', async () => {
    const user = makeSSOUser({ email: 'alice@unknown-domain.com' });
    const ssoUpsertMock = vi.fn();

    const ssoConfigChain = {
      select: vi.fn().mockReturnThis(),
      contains: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const adminMock = createAdminMock({
      sso_config: ssoConfigChain,
      sso_identity: { upsert: ssoUpsertMock },
      profile: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: user.id }, error: null }),
      },
    });

    const serverClient = createServerClientMock(user);
    vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue(serverClient as any);
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue(adminMock as any);

    await GET(buildCallbackRequest());

    expect(ssoUpsertMock).not.toHaveBeenCalled();
  });

  it('should not block login when SSO identity upsert fails', async () => {
    const user = makeSSOUser();
    const ssoUpsertMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'conflict' },
    });

    const ssoConfigChain = {
      select: vi.fn().mockReturnThis(),
      contains: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'sso-cfg-1', tenant_id: 'tenant-001' },
        error: null,
      }),
    };

    const adminMock = createAdminMock({
      sso_config: ssoConfigChain,
      sso_identity: { upsert: ssoUpsertMock },
      profile: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: user.id }, error: null }),
      },
    });

    const serverClient = createServerClientMock(user);
    vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue(serverClient as any);
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue(adminMock as any);

    // A failed SSO identity upsert must NOT block login: the route still
    // resolves to a redirect response (the mock returns { type, url }) rather
    // than throwing or returning null.
    const response = await GET(buildCallbackRequest());
    expect(response).toMatchObject({ type: 'redirect' });
    expect(NextResponse.redirect).toHaveBeenCalledWith(expect.any(String));
  });

  it('should skip SSO upsert when AMR does not contain sso/saml', async () => {
    const user = {
      id: 'user-pwd-001',
      email: 'bob@example.com',
      app_metadata: {
        amr: [{ method: 'password', timestamp: 1700000000 }],
      },
    };

    const ssoUpsertMock = vi.fn();

    const adminMock = createAdminMock({
      sso_identity: { upsert: ssoUpsertMock },
      profile: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: user.id }, error: null }),
      },
    });

    const serverClient = createServerClientMock(user);
    vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue(serverClient as any);
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue(adminMock as any);

    await GET(buildCallbackRequest());

    expect(ssoUpsertMock).not.toHaveBeenCalled();
  });

  it('should skip SSO upsert when user has no email', async () => {
    const user = makeSSOUser({ email: undefined });
    const ssoUpsertMock = vi.fn();

    const adminMock = createAdminMock({
      sso_identity: { upsert: ssoUpsertMock },
      profile: {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: user.id }, error: null }),
      },
    });

    const serverClient = createServerClientMock(user);
    vi.spyOn(supabaseServerClientModule, 'createSupabaseServerClient').mockResolvedValue(serverClient as any);
    vi.spyOn(supabaseAdminClientModule, 'createSupabaseAdminClient').mockReturnValue(adminMock as any);

    await GET(buildCallbackRequest());

    expect(ssoUpsertMock).not.toHaveBeenCalled();
  });
});
