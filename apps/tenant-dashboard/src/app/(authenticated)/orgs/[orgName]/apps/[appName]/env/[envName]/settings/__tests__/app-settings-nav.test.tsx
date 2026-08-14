// @vitest-environment jsdom
/**
 * Component tests for `<AppSettingsNav>`.
 *
 * The settings nav carries four tabs. There is no standalone "Environments"
 * tab — the breadcrumb and the General page's Environment section cover that
 * job — and the env-vars tab is labeled "Environment Variables" so it does
 * not collide with the breadcrumb's environment language. "Connected Apps"
 * (OAuth connector grants) is unconditional like General — it lists a
 * user-scoped resource, not an app-scoped one, so there's no app permission
 * to gate it on.
 *
 * These tests pin the tab set and the absence of label collisions.
 *
 * Boundaries:
 *  - `<AppSettingsNav>` crosses NO HTTP boundary — it renders a static list
 *    from `next/link`. The only seam is `usePathname` (the active-tab
 *    highlight), already stubbed by the global unit-test setup. No MSW or
 *    `vi.mock` is needed here.
 */

import { render, screen } from '@testing-library/react';
import { useParams } from 'next/navigation';

import { AppSettingsNav } from '../app-settings-nav';
import type { Permission } from '@/utils/permissions';

// The env is a path segment; the nav reads it from `useParams().envName` to
// build env-scoped tab hrefs. The global setup stubs `useParams` empty.
beforeEach(() => {
  vi.mocked(useParams).mockReturnValue({ envName: 'prod' });
});

/** The tabs the settings nav settles on. */
const EXPECTED_TABS = [
  'General',
  'API Keys',
  'Environment Variables',
  'Connected Apps',
];

/** The permission set that makes every gated tab eligible to show. */
const ALL_PERMISSIONS: Permission[] = [
  'api_key.read',
  'env_var.read',
];

/**
 * Render the nav with the given effective permission set. Tabs are gated on the
 * permissions the user holds; omit a permission to drive its hidden branch.
 * Defaults to the full set so every tab is eligible.
 */
function renderNav(permissions: Permission[] = ALL_PERMISSIONS) {
  return render(
    <AppSettingsNav
      orgName="tenant-1"
      appName="app-1"
      permissions={permissions}
    />,
  );
}

describe('AppSettingsNav — tab set', () => {
  it('should render exactly four tabs when every settings surface is available', () => {
    renderNav();

    const tabs = screen.getAllByRole('link');
    expect(tabs).toHaveLength(4);
  });

  it('should render the General, API Keys, Environment Variables, and Connected Apps tabs', () => {
    renderNav();

    for (const label of EXPECTED_TABS) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});

describe('AppSettingsNav — no Environments tab', () => {
  it('should not render a standalone "Environments" tab', () => {
    renderNav();

    // Env management lives in the breadcrumb and the General page's
    // Environment section.
    expect(
      screen.queryByRole('link', { name: 'Environments' }),
    ).not.toBeInTheDocument();
  });
});

describe('AppSettingsNav — label collision', () => {
  it('should label the env-vars tab "Environment Variables" rather than "Environment"', () => {
    renderNav();

    // The env-vars tab carries the disambiguated label.
    expect(
      screen.getByRole('link', { name: 'Environment Variables' }),
    ).toBeInTheDocument();
  });

  it('should not render a tab labeled exactly "Environment"', () => {
    renderNav();

    // No bare "Environment" label exists, so there is no
    // Environments/Environment ambiguity.
    expect(
      screen.queryByRole('link', { name: 'Environment' }),
    ).not.toBeInTheDocument();
  });
});

describe('AppSettingsNav — tab hrefs', () => {
  it('should point the Environment Variables tab at the env-vars route', () => {
    renderNav();

    // The relabel kept the underlying `env-vars` path (the label
    // changed, the route did not).
    expect(
      screen.getByRole('link', { name: 'Environment Variables' }),
    ).toHaveAttribute(
      'href',
      '/orgs/tenant-1/apps/app-1/env/prod/settings/env-vars',
    );
  });

  it('should point the General tab at the general route under the env segment', () => {
    renderNav();

    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute(
      'href',
      '/orgs/tenant-1/apps/app-1/env/prod/settings/general',
    );
  });
});

describe('AppSettingsNav — conditional tab visibility', () => {
  it('should hide the API Keys tab when the user lacks api_key.read', () => {
    // Every gated permission except api_key.read.
    renderNav(['env_var.read']);

    // The tab is absent (hidden, not disabled).
    expect(
      screen.queryByRole('link', { name: 'API Keys' }),
    ).not.toBeInTheDocument();
  });

  it('should always render the General tab even with no permissions', () => {
    // Empty permission set.
    renderNav([]);

    // General is unconditional; it is the settings landing tab.
    expect(
      screen.getByRole('link', { name: 'General' }),
    ).toBeInTheDocument();
  });

  it('should render only the unconditional tabs when the user has no app permissions', () => {
    // The app-scoped-no-access / blank-permission case.
    renderNav([]);

    // General and Connected Apps are unconditional; every gated tab is
    // hidden. Connected Apps lists a user-scoped resource, not an
    // app-scoped one, so no app permission gates it.
    const tabs = screen.getAllByRole('link');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General', 'Connected Apps']);
  });

  it('should hide the Environment Variables tab when the user lacks env_var.read', () => {
    // Env-var read is gated off. Env var values are sensitive
    // (loaded via the admin client server-side), so the tab must be gated on
    // env_var.read, not shown unconditionally.
    renderNav(['api_key.read']);

    // The tab is absent (hidden, not disabled).
    expect(
      screen.queryByRole('link', { name: 'Environment Variables' }),
    ).not.toBeInTheDocument();
  });

  it('should render the Environment Variables tab when the user has env_var.read', () => {
    // Only the env-var read perm.
    renderNav(['env_var.read']);

    expect(
      screen.getByRole('link', { name: 'Environment Variables' }),
    ).toBeInTheDocument();
  });
});
