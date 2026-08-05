// @vitest-environment jsdom
/**
 * AuthGuard redirect tests.
 *
 * Regression: an invite link lands an unauthenticated user on
 * `/auth/accept-invite?id=<membershipId>`. The guard must send them to
 * login with the FULL original URL (path + query) in `return_to` — the
 * param name the login page reads — or the membership id is lost and the
 * accept page renders "Invalid Link" after sign-in.
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

vi.mock('../../../hooks/use-posthog-pageview', () => ({
  usePostHogPageview: () => undefined,
}));

vi.mock('@/components/loading-screen', () => ({
  SplashScreen: () => <div data-testid="splash" />,
}));

// Import after mocks
import AuthGuard from '../auth-guard';

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to login with the full original URL (path + query) in return_to', () => {
    window.history.replaceState(null, '', '/auth/accept-invite?id=abc-123');
    mockUseAuthContext.mockReturnValue({ loading: false, authenticated: false });

    render(
      <AuthGuard>
        <div>Protected</div>
      </AuthGuard>
    );

    expect(mockReplace).toHaveBeenCalledTimes(1);
    const href = mockReplace.mock.calls[0]![0] as string;
    const [pathname, query] = href.split('?');
    expect(pathname).toBe('/auth/login');
    expect(new URLSearchParams(query).get('return_to')).toBe(
      '/auth/accept-invite?id=abc-123'
    );
  });

  it('renders children without redirecting when authenticated', () => {
    window.history.replaceState(null, '', '/auth/accept-invite?id=abc-123');
    mockUseAuthContext.mockReturnValue({ loading: false, authenticated: true });

    const { getByText } = render(
      <AuthGuard>
        <div>Protected</div>
      </AuthGuard>
    );

    expect(getByText('Protected')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
