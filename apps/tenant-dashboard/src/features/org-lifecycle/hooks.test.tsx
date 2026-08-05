// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const createOrganizationAction = vi.hoisted(() =>
  vi.fn(async (_slug: string, _companyName: string) => ({
    data: { organizationName: 'acme-blue-swift' },
  })),
);
vi.mock('./action-adapters', () => ({ createOrganizationAction }));

vi.mock('../../routes/paths', () => ({
  paths: {
    orgs: { org: { apps: { root: (orgName: string) => `/orgs/${orgName}/apps` } } },
  },
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

const enqueueSnackbar = vi.hoisted(() => vi.fn());
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar }) }));

const membershipState = vi.hoisted(() => ({ isAtOrgLimit: false }));
vi.mock('../../auth/hooks/use-memberships', () => ({
  useMemberships: () => membershipState,
}));

const refreshMemberships = vi.hoisted(() => vi.fn());
vi.mock('../../auth/hooks', () => ({
  useAuthContext: () => ({ refreshMemberships }),
}));

import { useCreateOrg } from './hooks';

// Drive the hook directly — the create logic (silent slug, submit, navigate,
// limit guard) is what commit 6 introduces; the DOM wrappers are tested
// structurally elsewhere.
const apiRef: { current: ReturnType<typeof useCreateOrg> | null } = { current: null };
function Harness() {
  const api = useCreateOrg();
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  return null;
}

beforeEach(() => {
  membershipState.isAtOrgLimit = false;
  createOrganizationAction.mockClear();
  routerMock.push.mockClear();
  refreshMemberships.mockClear();
  enqueueSnackbar.mockClear();
});

describe('useCreateOrg', () => {
  it('submits the company name with a silently generated non-empty slug, then navigates', async () => {
    render(<Harness />);
    apiRef.current!.methods.setValue('companyName', 'My Co');
    await apiRef.current!.onSubmit();

    await waitFor(() => expect(createOrganizationAction).toHaveBeenCalledTimes(1));
    const [slug, companyName] = createOrganizationAction.mock.calls[0]!;
    expect(companyName).toBe('My Co');
    expect(typeof slug).toBe('string');
    expect(slug.length).toBeGreaterThan(0);

    await waitFor(() => expect(refreshMemberships).toHaveBeenCalledTimes(1));
    expect(routerMock.push).toHaveBeenCalledWith('/orgs/acme-blue-swift/apps');
  });

  it('blocks the create call at the org limit', async () => {
    membershipState.isAtOrgLimit = true;
    render(<Harness />);
    apiRef.current!.methods.setValue('companyName', 'My Co');
    await apiRef.current!.onSubmit();

    expect(createOrganizationAction).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(enqueueSnackbar).toHaveBeenCalledWith('org.orgLimitReached', {
      variant: 'error',
    });
  });

  it('surfaces a server error without navigating', async () => {
    createOrganizationAction.mockResolvedValueOnce({ error: 'Name taken' } as never);
    render(<Harness />);
    apiRef.current!.methods.setValue('companyName', 'My Co');
    await apiRef.current!.onSubmit();

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Name taken', { variant: 'error' }),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
