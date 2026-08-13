// @vitest-environment jsdom
/**
 * The org-less device-login entry point — what the CLI's `verification_url`
 * opens. Resolves the caller's sole active membership and hands off to the
 * org-scoped approval page, carrying `user_code` along; anything other than
 * exactly one membership falls back to the org picker.
 */

import { render, waitFor } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => routerMocks.searchParams,
}));

const routerMocks = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

const authMocks = vi.hoisted(() => ({ loading: false, memberships: [] as { tenant?: { organization_name?: string } }[] }));
vi.mock('../../../auth/hooks', () => ({
  useAuthContext: () => ({ loading: authMocks.loading }),
}));
vi.mock('../../../auth/hooks/use-memberships', () => ({
  useMemberships: () => ({ memberships: authMocks.memberships }),
}));
vi.mock('../../../layouts/app/app-layout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import DeviceAuthEntryPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.loading = false;
  authMocks.memberships = [];
  routerMocks.searchParams = new URLSearchParams();
});

describe('DeviceAuthEntryPage — org resolution', () => {
  it('does nothing while auth is still loading', () => {
    authMocks.loading = true;
    authMocks.memberships = [{ tenant: { organization_name: 'acme' } }];
    render(<DeviceAuthEntryPage />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('routes to the org-scoped device page for a single membership, carrying user_code', async () => {
    authMocks.memberships = [{ tenant: { organization_name: 'acme' } }];
    routerMocks.searchParams = new URLSearchParams('user_code=AAAA-BBBB');
    render(<DeviceAuthEntryPage />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/orgs/acme/device?user_code=AAAA-BBBB'),
    );
  });

  it('routes to the org-scoped device page with no query string when there is no user_code', async () => {
    authMocks.memberships = [{ tenant: { organization_name: 'acme' } }];
    render(<DeviceAuthEntryPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/orgs/acme/device'));
  });

  it('falls back to the org picker when the caller has no memberships', async () => {
    authMocks.memberships = [];
    render(<DeviceAuthEntryPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/orgs?picker=1'));
  });

  it('falls back to the org picker when the caller belongs to more than one org', async () => {
    authMocks.memberships = [
      { tenant: { organization_name: 'acme' } },
      { tenant: { organization_name: 'beta' } },
    ];
    render(<DeviceAuthEntryPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/orgs?picker=1'));
  });
});
