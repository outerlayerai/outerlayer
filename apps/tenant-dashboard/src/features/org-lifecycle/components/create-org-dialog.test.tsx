// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const createOrganizationAction = vi.hoisted(() =>
  vi.fn(async () => ({ data: { organizationName: 'acme-blue-swift' } })),
);
vi.mock('../action-adapters', () => ({ createOrganizationAction }));

vi.mock('../../../routes/paths', () => ({
  paths: {
    orgs: { org: { apps: { root: (orgName: string) => `/orgs/${orgName}/apps` } } },
  },
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({ t: (key: string) => key }),
}));

vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));

const membershipState = vi.hoisted(() => ({ isAtOrgLimit: false }));
vi.mock('../../../auth/hooks/use-memberships', () => ({
  useMemberships: () => membershipState,
}));

vi.mock('../../../auth/hooks', () => ({
  useAuthContext: () => ({ refreshMemberships: vi.fn() }),
}));

import CreateOrgDialog from './create-org-dialog';

beforeEach(() => {
  membershipState.isAtOrgLimit = false;
  createOrganizationAction.mockClear();
  routerMock.push.mockClear();
});

describe('CreateOrgDialog', () => {
  it('shows only Company Name — no URL slug field', () => {
    render(<CreateOrgDialog open onClose={vi.fn()} />);
    // Company Name is the sole field; no disabled organizationName ("name")
    // field may render.
    expect(screen.getByLabelText('org.companyName')).toBeInTheDocument();
    expect(screen.queryByLabelText('org.name')).toBeNull();
  });

  it('disables submit at the org limit', () => {
    membershipState.isAtOrgLimit = true;
    render(<CreateOrgDialog open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'org.saveButton' })).toBeDisabled();
  });

  it('does not create past the org limit even if submit is forced', async () => {
    membershipState.isAtOrgLimit = true;
    render(<CreateOrgDialog open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('org.companyName'), {
      target: { value: 'My Co' },
    });
    // Force the submit event (the button is disabled) — the hook guard still
    // blocks the create call at the limit.
    const form = screen.getByLabelText('org.companyName').closest('form')!;
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 30));
    expect(createOrganizationAction).not.toHaveBeenCalled();
  });
});
