// @vitest-environment jsdom
/**
 * TenantGuard component tests.
 *
 * Users with no organizations should be redirected to /orgs.
 *
 * TenantGuard's only job is the membership check: the URL org is resolved
 * to a tenant by the middleware before this component ever renders.
 *
 * Boundaries: `useAuthContext` / `useMemberships` are React-context seams,
 * not HTTP boundaries — the same pattern `permission-guard.test.tsx` uses to
 * isolate guards from the real `AuthProvider`.
 */
import { render } from '@testing-library/react';
import { useParams, useRouter } from 'next/navigation';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useParams: vi.fn(),
}));

const mockUseAuthContext = vi.fn();
const mockUseMemberships = vi.fn();

vi.mock('../../hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

vi.mock('../../hooks/use-memberships', () => ({
  useMemberships: () => mockUseMemberships(),
}));

vi.mock('../../../routes/paths', () => ({
  paths: {
    orgs: {
      root: '/orgs',
    },
  },
}));

vi.mock('../../../sections/error/403-view', () => ({
  __esModule: true,
  default: () => <div data-testid="forbidden-view">403 Forbidden</div>,
}));

vi.mock('@/components/loading-screen', () => ({
  SplashScreen: () => <div data-testid="splash-screen">Loading...</div>,
}));

import TenantGuard from '../tenant-guard';

const mockRouterReplace = vi.fn();

const membershipA = {
  tenant_id: 'tenant-a',
  tenant: { organization_name: 'org-a', company_name: 'Org A' },
};
const membershipB = {
  tenant_id: 'tenant-b',
  tenant: { organization_name: 'org-b', company_name: 'Org B' },
};

function membershipsHook(memberships: Array<typeof membershipA>) {
  return {
    getMembershipByOrgName: (orgName: string) =>
      memberships.find((m) => m.tenant.organization_name === orgName) ?? null,
    memberships,
  };
}

const protectedChild = <div data-testid="protected">Protected Content</div>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({
    replace: mockRouterReplace,
    push: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});

describe('TenantGuard', () => {
  it('renders children on first commit for a member of the URL org, with no splash', () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'org-a' });
    mockUseAuthContext.mockReturnValue({
      user: { id: 'user-123', memberships: [membershipA, membershipB] },
      loading: false,
      authenticated: true,
    });
    mockUseMemberships.mockReturnValue(membershipsHook([membershipA, membershipB]));

    const { getByText, queryByTestId } = render(<TenantGuard>{protectedChild}</TenantGuard>);

    expect(getByText('Protected Content')).toBeInTheDocument();
    expect(queryByTestId('splash-screen')).not.toBeInTheDocument();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('denies with ForbiddenView when the user has orgs but not the one in the URL', () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'org-c' });
    mockUseAuthContext.mockReturnValue({
      user: { id: 'user-123', memberships: [membershipA] },
      loading: false,
      authenticated: true,
    });
    mockUseMemberships.mockReturnValue(membershipsHook([membershipA]));

    const { getByTestId, queryByTestId } = render(<TenantGuard>{protectedChild}</TenantGuard>);

    expect(getByTestId('forbidden-view')).toBeInTheDocument();
    expect(queryByTestId('protected')).not.toBeInTheDocument();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('redirects to /orgs when the authenticated user has no memberships at all', () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'test-org' });
    mockUseAuthContext.mockReturnValue({
      user: { id: 'user-123', memberships: [] },
      loading: false,
      authenticated: true,
    });
    mockUseMemberships.mockReturnValue({ getMembershipByOrgName: () => null, memberships: [] });

    render(<TenantGuard>{protectedChild}</TenantGuard>);

    expect(mockRouterReplace).toHaveBeenCalledWith('/orgs');
  });

  it('shows the splash screen while auth is loading', () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'test-org' });
    mockUseAuthContext.mockReturnValue({ user: null, loading: true, authenticated: false });
    mockUseMemberships.mockReturnValue({ getMembershipByOrgName: () => null, memberships: [] });

    const { getByTestId, queryByTestId } = render(<TenantGuard>{protectedChild}</TenantGuard>);

    expect(getByTestId('splash-screen')).toBeInTheDocument();
    expect(queryByTestId('protected')).not.toBeInTheDocument();
  });
});
