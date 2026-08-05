// @vitest-environment jsdom
/**
 * Behavior-pinning for AccountPopover's menu, written BEFORE the
 * restyle. The restyle changes ink/weight/glyphs/width but must not touch the
 * gates or navigation, so this pins:
 *   - the Profile + Logout items are always present;
 *   - Organization settings is gated to admin/owner and routes to org settings
 *     (its removal from the header gear makes this the only persistent path);
 *   - Platform Admin is gated to platform admins and routes to the admin root;
 *   - Logout calls logout() then redirects to /auth/login.
 *
 * CustomPopover is mocked to a MenuList wrapper (as the realtime-subscribe test
 * does) so the menu contents render without a live popover anchor; usePopover is
 * given a truthy open element per the element-not-boolean contract.
 */

import React from 'react';
import '@testing-library/jest-dom';
import MenuList from '@mui/material/MenuList';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const state = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  isPlatformAdmin: false,
}));

const spies = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  logout: vi.fn(async () => {}),
}));

function makeQuery(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'match', 'order', 'single', 'update']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (onF: (v: unknown) => unknown) => Promise.resolve(result).then(onF);
  return chain;
}

vi.mock('../../../supabaseFrontendClient', () => ({
  createSupabaseFontendClient: () => ({
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = vi.fn(() => ch);
      ch.subscribe = vi.fn(() => ch);
      return ch;
    }),
    removeChannel: vi.fn(),
    from: vi.fn(() =>
      makeQuery({
        data: { id: 'u1', name: 'Ada Lovelace', email: 'ada@x.io', avatar_url: null },
        error: null,
      }),
    ),
  }),
}));

vi.mock('../../../auth/hooks', () => ({
  useAuthContext: () => ({ user: state.user, logout: spies.logout }),
}));

vi.mock('../../../auth/hooks/use-platform-admin', () => ({
  usePlatformAdmin: () => ({ isPlatformAdmin: state.isPlatformAdmin }),
}));

vi.mock('../../../routes/hooks', () => ({
  useRouter: () => ({ push: spies.push, replace: spies.replace }),
}));

vi.mock('../../../routes/paths', () => ({
  paths: {
    profile: { root: '/profile' },
    platformAdmin: { root: '/platform-admin' },
    orgs: { org: { settings: { root: (org: string) => `/orgs/${org}/settings` } } },
  },
}));

vi.mock('../../../utils/storage', () => ({
  getAvatarUrl: vi.fn(async () => ''),
}));

vi.mock('@/components/custom-popover', () => ({
  __esModule: true,
  // Always-open MenuList wrapper — the menu contents render regardless of the
  // popover open state, so the gate/nav assertions don't depend on portals.
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement(MenuList, null, children),
  usePopover: () => ({ open: document.createElement('div'), onOpen: vi.fn(), onClose: vi.fn() }),
}));

// The global setup stubs Iconify to null; here render the glyph name into a
// data attribute so the "every row has a leading icon" contract is observable
// (user feedback: a mixed iconed/bare menu misaligns labels).
vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({ icon }: { icon: string }) =>
    React.createElement('span', { 'data-icon': icon }),
}));

import AccountPopover from '../account-popover';

const PROFILE_LABEL = 'dashboard.headerAccountPopup.profileMenuItem';

async function renderPopover() {
  await act(async () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <AccountPopover />
      </ThemeProvider>,
    );
  });
}

beforeEach(() => {
  spies.push.mockClear();
  spies.replace.mockClear();
  spies.logout.mockClear();
  state.user = null;
  state.isPlatformAdmin = false;
});

describe('AccountPopover menu gates', () => {
  it('a plain member sees Profile + Logout but neither Organization settings nor Platform Admin', async () => {
    state.user = { id: 'u1', role: 'member', tenant: { organization_name: 'acme' }, activeTenant: { organization_name: 'acme' } };
    await renderPopover();

    expect(screen.getByText(PROFILE_LABEL)).toBeInTheDocument();
    expect(screen.getByText('Logout')).toBeInTheDocument();
    expect(screen.queryByText('Organization settings')).toBeNull();
    expect(screen.queryByText('Platform Admin')).toBeNull();
  });

  it('an admin sees Organization settings and it routes to the org settings page', async () => {
    state.user = { id: 'u1', role: 'admin', tenant: { organization_name: 'acme' }, activeTenant: { organization_name: 'acme' } };
    await renderPopover();

    const item = screen.getByText('Organization settings');
    fireEvent.click(item);

    expect(spies.push).toHaveBeenCalledWith('/orgs/acme/settings');
  });

  it('a platform admin sees Platform Admin and it routes to the admin root', async () => {
    state.user = { id: 'u1', role: 'member', tenant: { organization_name: 'acme' }, activeTenant: { organization_name: 'acme' } };
    state.isPlatformAdmin = true;
    await renderPopover();

    const item = screen.getByText('Platform Admin');
    fireEvent.click(item);

    expect(spies.push).toHaveBeenCalledWith('/platform-admin');
  });

  it('every menu row carries a leading icon so labels align on one grid', async () => {
    state.user = { id: 'u1', role: 'admin', tenant: { organization_name: 'acme' }, activeTenant: { organization_name: 'acme' } };
    state.isPlatformAdmin = true;
    await renderPopover();

    for (const label of [PROFILE_LABEL, 'Organization settings', 'Platform Admin', 'Logout']) {
      const row = screen.getByText(label).closest('.MuiMenuItem-root');
      expect(row).not.toBeNull();
      expect(row?.querySelector('[data-icon]')).not.toBeNull();
    }
  });
});

describe('AccountPopover logout', () => {
  it('logs out then redirects to /auth/login', async () => {
    state.user = { id: 'u1', role: 'member', tenant: { organization_name: 'acme' }, activeTenant: { organization_name: 'acme' } };
    await renderPopover();

    fireEvent.click(screen.getByText('Logout'));

    await waitFor(() => expect(spies.logout).toHaveBeenCalledTimes(1));
    expect(spies.replace).toHaveBeenCalledWith('/auth/login');
  });
});
