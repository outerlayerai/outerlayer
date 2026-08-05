// @vitest-environment jsdom
/**
 * Component tests for the General settings page.
 *
 * Default-env-only posture: the multi-env UI (breadcrumb switcher, env detail
 * card, promotion) is removed, so the General page renders ONLY the App section
 * (`<AppId>`) — app identity + git connection. There is no per-environment
 * section on this page any more.
 *
 * Boundaries:
 *  - `@/lib/app-shell/app-context` (`useAppContext`) is a React-context seam —
 *    mocked so `<AppId>` derives a stable app.
 *  - `@/supabaseFrontendClient` is overridden so any `gatewayFetch` inside the
 *    App section resolves a session token.
 */

import { render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

import GeneralSettingsPage from '../general/page';

// `gatewayFetch` attaches a bearer token from
// `createSupabaseFontendClient().auth.getSession()`. The global setup mock
// returns `undefined`; override it with a minimal session stub.
vi.mock('@/supabaseFrontendClient', () => ({
  createSupabaseFontendClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'test-access-token' } },
        error: null,
      }),
    },
  }),
}));

// `useAppContext` is a React-context seam. `<AppId>` reads `git_connection` /
// `git_branch` and `app.id`.
const mockApp = {
  id: 'app-1',
  git_connection: [{ provider: 'github', repository: 'acme/agent' }],
  git_branch: [{ branch_name: 'main' }],
};
vi.mock('@/lib/app-shell/app-context', () => ({
  useAppContext: () => ({ app: mockApp }),
}));

// `<AppId>` reads `useAppPermissions` (via the `lib/adapters` crossing) to
// gate its git-connection controls — a permission-gate seam (a stable
// function signature), so `vi.mock` is the sanctioned tool.
vi.mock('@/lib/adapters/use-app-permissions', () => ({
  useAppPermissions: () => ({
    permissions: [],
    isLoading: false,
    hasPermission: () => true,
  }),
}));

const APP_ID = 'app-1';

async function renderGeneralPage() {
  const tree = await GeneralSettingsPage();
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {tree}
    </SWRConfig>,
  );
}

describe('GeneralSettingsPage — App section only', () => {
  it('renders the App section with the app identifier', async () => {
    await renderGeneralPage();

    const appIdField = await screen.findByLabelText(
      'dashboard.developers.appId',
    );
    expect(appIdField).toHaveValue(APP_ID);
  });

  it('renders the App section heading', async () => {
    await renderGeneralPage();

    expect(
      await screen.findByRole('heading', {
        name: 'dashboard.developers.generalTitle',
      }),
    ).toBeInTheDocument();
  });

  it('does not render an Environment section (multi-env UI removed)', async () => {
    await renderGeneralPage();
    await screen.findByLabelText('dashboard.developers.appId');

    expect(
      screen.queryByRole('heading', { name: 'Environment' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Delete environment')).not.toBeInTheDocument();
  });
});
