// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Passthrough the chrome so we render only the picker body.
vi.mock('../../../../layouts/app/app-layout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Stub the create-org dialog — it has its own auth/membership deps; here we
// only care that the picker opens it.
vi.mock('@/features/org-lifecycle', () => ({
  CreateOrgDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-org-dialog" /> : null,
}));

// `useCreateOrg` (real, unstubbed — the empty-state card renders its actual
// form) calls this at submit time.
vi.mock('@/features/org-lifecycle/action-adapters', () => ({
  createOrganizationAction: vi.fn(),
}));

// The global test setup stubs routes/paths down to auth+dashboard; re-expose the
// org path builder this page routes through.
vi.mock('../../../../routes/paths', () => ({
  paths: {
    orgs: { org: { apps: { root: (orgName: string) => `/orgs/${orgName}/apps` } } },
  },
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsState = vi.hoisted(() => ({ picker: null as string | null }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => ({
    get: (key: string) => (key === 'picker' ? searchParamsState.picker : null),
  }),
}));

const translate = vi.hoisted(() => vi.fn((key: string) => key));
vi.mock('@outerlayer/locales', () => ({ useTranslate: () => ({ t: translate }) }));

vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));

const authState = vi.hoisted(() => ({
  loading: false,
  user: { id: 'user-1' } as { id: string } | null,
  refreshMemberships: vi.fn(),
}));
vi.mock('../../../../auth/hooks', () => ({
  useAuthContext: () => authState,
}));

const membershipState = vi.hoisted(() => ({
  memberships: [] as Array<Record<string, unknown>>,
  isAtOrgLimit: false,
}));
vi.mock('../../../../auth/hooks/use-memberships', () => ({
  useMemberships: () => membershipState,
}));

// `useCreateOrg` (via `@/features/org-lifecycle/hooks`) reaches these same
// hooks through the adapter layer, a different module specifier than the
// page's own direct legacy import above — both need mocking.
vi.mock('@/lib/adapters/use-auth-context', () => ({
  useAuthContext: () => authState,
}));
vi.mock('@/lib/adapters/use-memberships', () => ({
  useMemberships: () => membershipState,
}));

import OrgsPage from '../page';

function mkMembership(companyName: string, orgName: string, role = 'member') {
  return {
    tenant_id: `t-${orgName}`,
    role,
    tenant: { organization_name: orgName, company_name: companyName },
  };
}

function visibleTitles(): string[] {
  return screen
    .getAllByTestId('org-card-title')
    .map((el) => el.textContent ?? '');
}

beforeEach(() => {
  authState.loading = false;
  authState.user = { id: 'user-1' };
  membershipState.memberships = [];
  membershipState.isAtOrgLimit = false;
  // Default the picker view ON so single-membership picker tests render the
  // list instead of auto-redirecting; the auto-entry tests opt back out.
  searchParamsState.picker = '1';
  translate.mockClear();
  routerMock.push.mockClear();
  routerMock.replace.mockClear();
  window.localStorage.clear();
});

describe('OrgsPage picker', () => {
  it('renders one row per membership with role chip and slug, title as <p> not <h6>', () => {
    membershipState.memberships = [
      mkMembership('Acme Inc', 'acme', 'owner'),
      mkMembership('Beta LLC', 'beta', 'admin'),
    ];
    render(<OrgsPage />);

    // Row titles are the company names, rendered as <p> (subtitle1 defaults to h6).
    const title = screen.getByText('Acme Inc');
    expect(title.tagName).toBe('P');
    expect(title.tagName).not.toBe('H6');

    // Role chip text + slug caption present per row.
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('shows the org display initial in a letter-avatar', () => {
    membershipState.memberships = [mkMembership('Acme Inc', 'acme', 'owner')];
    render(<OrgsPage />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('routes into the org (and records MRU) on row click', async () => {
    membershipState.memberships = [mkMembership('Acme Inc', 'acme', 'owner')];
    render(<OrgsPage />);

    await userEvent.click(screen.getByText('Acme Inc'));
    expect(routerMock.push).toHaveBeenCalledWith('/orgs/acme/apps');
    expect(JSON.parse(window.localStorage.getItem('org-last-visited:user-1')!)).toEqual([
      'acme',
    ]);
  });

  it('hides the search field below the threshold and filters above it', async () => {
    // 5 orgs → search appears; filter narrows to matching titles/slugs only.
    membershipState.memberships = [
      mkMembership('Acme', 'acme'),
      mkMembership('Beta', 'beta'),
      mkMembership('Gamma', 'gamma'),
      mkMembership('Delta', 'delta'),
      mkMembership('Epsilon', 'epsilon'),
    ];
    render(<OrgsPage />);

    const search = screen.getByPlaceholderText('Search organizations');
    await userEvent.type(search, 'et');
    // "Beta" (title) matches "et"; nothing else does.
    expect(visibleTitles()).toEqual(['Beta']);
  });

  it('omits the search field with fewer than five orgs', () => {
    membershipState.memberships = [
      mkMembership('Acme', 'acme'),
      mkMembership('Beta', 'beta'),
    ];
    render(<OrgsPage />);
    expect(screen.queryByPlaceholderText('Search organizations')).toBeNull();
  });

  it('orders most-recently-used first, then alphabetical', async () => {
    window.localStorage.setItem(
      'org-last-visited:user-1',
      JSON.stringify(['gamma']),
    );
    membershipState.memberships = [
      mkMembership('Acme', 'acme'),
      mkMembership('Beta', 'beta'),
      mkMembership('Gamma', 'gamma'),
    ];
    // The MRU read happens in an effect → wrap so the reorder commits.
    await act(async () => {
      render(<OrgsPage />);
    });
    // gamma is MRU → first; acme/beta alphabetical after.
    expect(visibleTitles()).toEqual(['Gamma', 'Acme', 'Beta']);
  });

  it('opens the create-org dialog from the New organization button', async () => {
    membershipState.memberships = [mkMembership('Acme', 'acme')];
    render(<OrgsPage />);
    expect(screen.queryByTestId('create-org-dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /new organization/i }));
    expect(screen.getByTestId('create-org-dialog')).toBeInTheDocument();
  });

  it('disables the New organization button and wires the limit copy at the org limit', () => {
    membershipState.memberships = [mkMembership('Acme', 'acme')];
    membershipState.isAtOrgLimit = true;
    render(<OrgsPage />);
    expect(screen.getByRole('button', { name: /new organization/i })).toBeDisabled();
    // The tooltip title resolves the limit copy only when at the limit.
    expect(translate).toHaveBeenCalledWith('org.orgLimitReached');
  });

  it('does not resolve the limit copy when below the org limit', () => {
    membershipState.memberships = [mkMembership('Acme', 'acme')];
    membershipState.isAtOrgLimit = false;
    render(<OrgsPage />);
    expect(screen.getByRole('button', { name: /new organization/i })).toBeEnabled();
    expect(translate).not.toHaveBeenCalledWith('org.orgLimitReached');
  });

  it('renders three skeleton rows while loading', () => {
    authState.loading = true;
    render(<OrgsPage />);
    expect(screen.getAllByTestId('org-skeleton')).toHaveLength(3);
  });

  it('empty state shows only Company Name — no URL slug field', () => {
    membershipState.memberships = [];
    render(<OrgsPage />);
    expect(screen.getByLabelText('org.companyName')).toBeInTheDocument();
    expect(screen.queryByLabelText('org.name')).toBeNull();
  });
});

describe('OrgsPage single-org auto-entry', () => {
  it('replace-redirects a single-org user straight into their org (no picker flash)', () => {
    searchParamsState.picker = null;
    membershipState.memberships = [mkMembership('Acme', 'acme')];
    render(<OrgsPage />);
    expect(routerMock.replace).toHaveBeenCalledWith('/orgs/acme/apps');
    // The one-row picker never renders during the redirect.
    expect(screen.queryByTestId('org-card-title')).toBeNull();
  });

  it('does not auto-enter with ?picker=1 (shows the picker instead)', () => {
    searchParamsState.picker = '1';
    membershipState.memberships = [mkMembership('Acme', 'acme')];
    render(<OrgsPage />);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-card-title')).toHaveTextContent('Acme');
  });

  it('does not auto-enter with two or more orgs', () => {
    searchParamsState.picker = null;
    membershipState.memberships = [
      mkMembership('Acme', 'acme'),
      mkMembership('Beta', 'beta'),
    ];
    render(<OrgsPage />);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(visibleTitles()).toEqual(['Acme', 'Beta']);
  });

  it('does not auto-enter with zero orgs (empty state)', () => {
    searchParamsState.picker = null;
    membershipState.memberships = [];
    render(<OrgsPage />);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText('org.companyName')).toBeInTheDocument();
  });
});
