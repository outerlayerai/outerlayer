// @vitest-environment jsdom
/**
 * TermsGuard tests.
 *
 * Pins the two allow-access-on-failure branches (error result, thrown error):
 * a terms-check outage must never lock every authenticated user out of the
 * app. Also covers the blocking redirect and the accept-invite exempt path.
 *
 * `checkTermsAgreementAction` (a server action) and `useAuthContext` are the two
 * seams: neither is an HTTP boundary MSW can model, and both have a stable,
 * narrow interface.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { usePathname, useRouter } from 'next/navigation';

import { checkTermsAgreementAction } from '@/features/auth/action-adapters';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
}));

const mockUseAuthContext = vi.fn();
vi.mock('../../hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

vi.mock('@/features/auth/action-adapters', () => ({
  checkTermsAgreementAction: vi.fn(),
}));

vi.mock('@/components/loading-screen', () => ({
  SplashScreen: () => <div data-testid="splash-screen" />,
}));

import TermsGuard from '../terms-guard';

function mockRouter() {
  const replace = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ replace } as any);
  return replace;
}

describe('TermsGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/orgs/acme/apps');
    mockUseAuthContext.mockReturnValue({ authenticated: true, loading: false });
  });

  // proves AC-078-02
  it('renders children when checkTermsAgreementAction returns an error result', async () => {
    mockRouter();
    vi.mocked(checkTermsAgreementAction).mockResolvedValue({ error: 'Service unavailable' } as any);

    const { findByText } = render(
      <TermsGuard>
        <div>protected content</div>
      </TermsGuard>
    );

    await findByText('protected content');
  });

  // proves AC-078-02
  it('renders children when checkTermsAgreementAction throws', async () => {
    mockRouter();
    vi.mocked(checkTermsAgreementAction).mockRejectedValue(new Error('network down'));

    const { findByText } = render(
      <TermsGuard>
        <div>protected content</div>
      </TermsGuard>
    );

    await findByText('protected content');
  });

  // proves AC-078-01
  it('redirects to the blocking terms-agreement URL with both query params and the current pathname when needsCurrentVersion is true', async () => {
    const replace = mockRouter();
    vi.mocked(checkTermsAgreementAction).mockResolvedValue({
      data: { hasAgreed: false, needsCurrentVersion: true },
    } as any);

    render(
      <TermsGuard>
        <div>protected content</div>
      </TermsGuard>
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        'http://localhost:3000/auth/terms-agreement?blocking=true&return_to=%2Forgs%2Facme%2Fapps'
      );
    });
  });

  // Exempt-path regression: accept-invite handles terms inline, so gating it
  // here too would put an invitee into a redirect loop between the two pages.
  it('never calls checkTermsAgreementAction on the accept-invite exempt path', async () => {
    vi.mocked(usePathname).mockReturnValue('/auth/accept-invite');
    mockRouter();

    const { findByText } = render(
      <TermsGuard>
        <div>protected content</div>
      </TermsGuard>
    );

    await findByText('protected content');
    expect(checkTermsAgreementAction).not.toHaveBeenCalled();
  });
});
