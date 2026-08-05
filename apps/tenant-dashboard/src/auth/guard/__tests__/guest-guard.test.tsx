// @vitest-environment jsdom
/**
 * GuestGuard redirect tests.
 *
 * Regression: after an invite-link bounce (`/auth/login?return_to=…`),
 * the guard must resume the original flow once the session exists instead
 * of dropping the user on the org default — and must never honor an
 * off-site `return_to`.
 */
import React from 'react';
import { render } from '@testing-library/react';

const mockUseAuthContext = vi.fn();
const mockReplace = vi.fn();

vi.mock('../../hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

vi.mock('../../../routes/hooks', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('@/components/loading-screen', () => ({
  SplashScreen: () => <div data-testid="splash" />,
}));

// The global unit-test-setup mocks routes/paths without the `orgs` subtree
// the guard's fallback redirect uses — override with the shapes it needs.
vi.mock('../../../routes/paths', () => ({
  paths: {
    orgs: {
      root: '/orgs',
      org: {
        apps: { root: (orgName: string) => `/orgs/${orgName}/apps` },
      },
    },
  },
}));

// Import after mocks
import GuestGuard from '../guest-guard';

describe('GuestGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resumes the return_to flow once authenticated', () => {
    window.history.replaceState(
      null,
      '',
      `/auth/login?return_to=${encodeURIComponent('/auth/accept-invite?id=abc-123')}`
    );
    mockUseAuthContext.mockReturnValue({
      loading: false,
      authenticated: true,
      user: { memberships: [] },
    });

    render(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/auth/accept-invite?id=abc-123');
  });

  it('ignores an off-site return_to and falls back to the org default', () => {
    window.history.replaceState(
      null,
      '',
      `/auth/login?return_to=${encodeURIComponent('//evil.example.com/')}`
    );
    mockUseAuthContext.mockReturnValue({
      loading: false,
      authenticated: true,
      user: { memberships: [] },
    });

    render(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/orgs');
  });

  it('redirects a single-org user to their org when no return_to is set', () => {
    window.history.replaceState(null, '', '/auth/login');
    mockUseAuthContext.mockReturnValue({
      loading: false,
      authenticated: true,
      user: {
        memberships: [{ tenant: { organization_name: 'acme' } }],
      },
    });

    render(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/orgs/acme/apps');
  });

  it('re-arms the redirect after an intervening unauthenticated phase', () => {
    window.history.replaceState(null, '', '/auth/login');
    const authed = {
      loading: false,
      authenticated: true,
      user: { memberships: [{ tenant: { organization_name: 'acme' } }] },
    };
    mockUseAuthContext.mockReturnValue(authed);

    const { rerender } = render(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenNthCalledWith(1, '/orgs/acme/apps');

    // The session dies server-side while this tree stays mounted; context flips
    // to unauthenticated. No redirect fires, and the one-shot guard must re-arm.
    mockUseAuthContext.mockReturnValue({
      loading: false,
      authenticated: false,
      user: null,
    });
    rerender(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );
    expect(mockReplace).toHaveBeenCalledTimes(1);

    // A real login now authenticates again — the redirect must fire a second
    // time instead of being swallowed by the burnt ref.
    mockUseAuthContext.mockReturnValue(authed);
    rerender(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );

    expect(mockReplace).toHaveBeenCalledTimes(2);
    expect(mockReplace).toHaveBeenNthCalledWith(2, '/orgs/acme/apps');
  });

  it('renders children without redirecting when unauthenticated', () => {
    window.history.replaceState(null, '', '/auth/login');
    mockUseAuthContext.mockReturnValue({
      loading: false,
      authenticated: false,
      user: null,
    });

    const { getByText } = render(
      <GuestGuard>
        <div>Login form</div>
      </GuestGuard>
    );

    expect(getByText('Login form')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
