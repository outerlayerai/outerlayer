// @vitest-environment jsdom
/**
 * OrgSwitcher lives in persistent header chrome (outside TenantGuard's
 * children), so it survives every navigation `handleOrgSelect` triggers —
 * nothing unmounts it to reset `isLoading` on its own. These pin the two
 * release valves that replace the missing reset: a pathname change (the
 * common, successful-switch case) and a `popstate` event (Back/Forward,
 * including the case where the browser settles back on the exact URL the
 * spinner was set from, so the pathname itself never observably changes).
 *
 * Boundaries: `next/navigation` and `useMemberships` are the two hook seams
 * this component reads — both are React-context/hook seams (not HTTP), so
 * `vi.mock` is the right tool per this app's testing rules, matching the
 * established pattern in `auth/guard/__tests__/tenant-guard.test.tsx`.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { useRouter, useParams, usePathname } from 'next/navigation';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useParams: vi.fn(),
  usePathname: vi.fn(),
}));

const mockUseMemberships = vi.fn();
vi.mock('../../auth/hooks/use-memberships', () => ({
  useMemberships: () => mockUseMemberships(),
}));

vi.mock('@/features/org-lifecycle', () => ({
  CreateOrgDialog: () => null,
}));

const mockSetLastActiveOrg = vi.fn().mockResolvedValue({ data: { tenantId: 'tenant-b' } });
vi.mock('@/features/org-lifecycle/action-adapters', () => ({
  setLastActiveOrgAction: (tenantId: string) => mockSetLastActiveOrg(tenantId),
}));

// The global unit-test setup replaces `../routes/paths` with a thin stub that
// only carries `auth` + `dashboard`. OrgSwitcher navigates through
// `paths.orgs.org.apps.root`, so restore the REAL path builders here —
// otherwise the very URL under test would throw on an undefined `orgs`.
vi.mock('../../routes/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/paths')>();
  return { paths: actual.paths };
});

import OrgSwitcher from './org-switcher';

const membershipA = {
  tenant_id: 'tenant-a',
  tenant: { organization_name: 'org-a', company_name: 'Org A' },
};
const membershipB = {
  tenant_id: 'tenant-b',
  tenant: { organization_name: 'org-b', company_name: 'Org B' },
};

// Zero MUI transition durations so the menu open/close resolves on the next
// tick rather than depending on real Grow/Fade timers (flake source under CI).
const noTransitionTheme = createTheme({
  transitions: {
    create: () => 'none',
    duration: {
      shortest: 0,
      shorter: 0,
      short: 0,
      standard: 0,
      complex: 0,
      enteringScreen: 0,
      leavingScreen: 0,
    },
  },
});

function renderSwitcher() {
  return render(
    <ThemeProvider theme={noTransitionTheme}>
      <OrgSwitcher />
    </ThemeProvider>,
  );
}

/** Sets up the router mock and returns the captured `push` spy. */
function setupRouter() {
  const push = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  return push;
}

beforeEach(() => {
  vi.mocked(useParams).mockReturnValue({ orgName: 'org-a' });
  vi.mocked(usePathname).mockReturnValue('/orgs/org-a/apps');
  mockUseMemberships.mockReturnValue({
    memberships: [membershipA, membershipB],
    isAtOrgLimit: false,
  });
  mockSetLastActiveOrg.mockClear();
});

describe('OrgSwitcher — switching is a navigation', () => {
  it('records the selected tenant as last-active and navigates to its URL', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'org-a' }));
    await user.click(await screen.findByRole('menuitem', { name: /Org B/ }));

    expect(mockSetLastActiveOrg).toHaveBeenCalledWith('tenant-b');
    expect(push).toHaveBeenCalledWith('/orgs/org-b/apps');
  });

  it('does not record a preference or navigate when re-selecting the current org', async () => {
    setupRouter();
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'org-a' }));
    await user.click(await screen.findByRole('menuitem', { name: /Org A/ }));

    expect(mockSetLastActiveOrg).not.toHaveBeenCalled();
  });
});

describe('OrgSwitcher — stuck-spinner regression', () => {
  it('re-enables the trigger once the pathname changes after a switch (successful navigation)', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    const { rerender } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'org-a' }));
    await user.click(await screen.findByRole('menuitem', { name: /Org B/ }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/org-b/apps');
    });
    const trigger = screen.getByRole('button', { name: 'org-a' });
    expect(trigger).toBeDisabled();
    expect(trigger.querySelector('.MuiCircularProgress-root')).not.toBeNull();

    // The destination lands — pathname changes to reflect it.
    vi.mocked(usePathname).mockReturnValue('/orgs/org-b/apps');
    rerender(
      <ThemeProvider theme={noTransitionTheme}>
        <OrgSwitcher />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'org-a' })).not.toBeDisabled();
    });
    expect(
      screen.getByRole('button', { name: 'org-a' }).querySelector('.MuiCircularProgress-root'),
    ).toBeNull();
  });

  it('re-enables the trigger on a popstate even when the URL settles back to where it started (interrupted back-nav)', async () => {
    setupRouter();
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'org-a' }));
    await user.click(await screen.findByRole('menuitem', { name: /Org B/ }));

    const trigger = screen.getByRole('button', { name: 'org-a' });
    expect(trigger).toBeDisabled();

    // User hits Back before the destination ever renders — the browser
    // settles back on the EXACT pathname the click started from (unchanged
    // mock). A pathname-keyed effect alone cannot observe this (no
    // dependency change across renders), so only the popstate listener can
    // recover it.
    fireEvent(window, new PopStateEvent('popstate'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'org-a' })).not.toBeDisabled();
    });
    expect(
      screen.getByRole('button', { name: 'org-a' }).querySelector('.MuiCircularProgress-root'),
    ).toBeNull();
  });

  it('keeps the trigger disabled with a spinner while the switch is still genuinely in flight', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'org-a' }));
    await user.click(await screen.findByRole('menuitem', { name: /Org B/ }));

    const trigger = screen.getByRole('button', { name: 'org-a' });
    expect(trigger).toBeDisabled();
    expect(trigger.querySelector('.MuiCircularProgress-root')).not.toBeNull();
    expect(push).toHaveBeenCalledTimes(1);
  });
});
