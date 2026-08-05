// @vitest-environment jsdom
/**
 * Component tests for `<AppBreadcrumb.AppSelect>`.
 *
 * AppSelect is the App segment of the breadcrumb spine — an app switcher scoped
 * to the current org. The regression under test: the apps LIST page must be
 * reachable directly, not only by stepping out to the org page first.
 * AppSelect carries a "View all apps" action that routes straight to the apps list.
 *
 * The app list arrives seeded from `AppListContext` (the `[appName]` React Server Component (RSC) layout
 * pushes it up via `<AppSeeder>`) — the component itself fetches nothing, so
 * these tests drive it by wrapping `<AppSelect>` in a fake `AppListContext.Provider`
 * rather than mocking a Supabase client or SWR.
 *
 * Boundaries:
 *  - `next/navigation` (`useParams`/`useRouter`) is the URL seam — globally
 *    stubbed by `unit-test-setup`; this file points `useParams` at a concrete
 *    org/app and captures `router.push` to assert the navigation target.
 *  - `@/components/custom-popover` (`usePopover`) is the REAL hook so the menu
 *    open/close path runs end-to-end.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { useParams, useRouter } from 'next/navigation';

import { AppListContext, type OrgAppRow } from '@/lib/app-shell/app-context/app-list-context';

// The global unit-test setup replaces `@/routes/paths` with a thin stub that
// only carries `auth` + `dashboard`. AppSelect navigates through
// `paths.orgs.org.apps.*`, so restore the REAL path builders here — otherwise
// the very URLs under test would be undefined.
vi.mock('@/routes/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/routes/paths')>();
  return { paths: actual.paths, appPaths: actual.appPaths };
});

// The global setup renders Iconify as null; re-mock it to expose `data-icon`
// (which glyph) and `data-sx` (state-driven styling, e.g. the open-menu
// chevron rotation) so icon-driven affordances are observable.
vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({ icon, sx, ...props }: { icon: string; sx?: unknown }) => (
    <span data-icon={icon} data-sx={JSON.stringify(sx)} {...props} />
  ),
}));

import { AppSelect } from './app-select';

/** Capture `router.push` so the navigation target can be asserted. */
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

function renderAppSelect(apps: OrgAppRow[] = []) {
  return render(
    <ThemeProvider theme={noTransitionTheme}>
      <AppListContext.Provider value={apps}>
        <AppSelect />
      </AppListContext.Provider>
    </ThemeProvider>,
  );
}

/** Re-render with a (possibly different) seeded app list — simulates the seed updating. */
function rerenderAppSelect(
  view: ReturnType<typeof renderAppSelect>,
  apps: OrgAppRow[],
) {
  view.rerender(
    <ThemeProvider theme={noTransitionTheme}>
      <AppListContext.Provider value={apps}>
        <AppSelect />
      </AppListContext.Provider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useParams).mockReturnValue({ orgName: 'tenant-1', appName: 'app-a' });
  setupRouter();
});

const TWO_APPS: OrgAppRow[] = [
  { id: 'id-a', name: 'app-a', display_name: null },
  { id: 'id-b', name: 'app-b', display_name: null },
];

describe('AppSelect — "View all apps" escape hatch', () => {
  it('should route to the apps LIST page (not an app detail) when "View all apps" is clicked', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await user.click(
      await screen.findByRole('menuitem', { name: /View all apps/ }),
    );

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/tenant-1/apps');
    });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('should keep per-app switching working alongside the new action', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await user.click(await screen.findByRole('menuitem', { name: /app-b/ }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/tenant-1/apps/app-b');
    });
  });
});

describe('AppSelect — switcher contract', () => {
  it('should treat selecting the app you are already in as a no-op (menu closes, no navigation)', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await user.click(await screen.findByRole('menuitem', { name: /app-a/ }));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('should mark only the current app with the selected state + checkmark', async () => {
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    const current = await screen.findByRole('menuitem', { name: /app-a/ });
    const other = screen.getByRole('menuitem', { name: /app-b/ });

    expect(current).toHaveClass('Mui-selected');
    expect(current.querySelector('[data-icon="eva:checkmark-fill"]')).toBeInTheDocument();
    expect(other).not.toHaveClass('Mui-selected');
    expect(other.querySelector('[data-icon="eva:checkmark-fill"]')).toBeNull();
  });

  it('should render nothing at all outside an app route', () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'tenant-1' });
    renderAppSelect(TWO_APPS);

    expect(screen.queryByRole('button', { name: 'Select app' })).not.toBeInTheDocument();
  });

  it('should not navigate when the org segment is missing', async () => {
    vi.mocked(useParams).mockReturnValue({ appName: 'app-a' });
    const push = setupRouter();
    const user = userEvent.setup();
    renderAppSelect([{ id: 'id-b', name: 'app-b', display_name: null }]);

    // No org → "View all apps" is a no-op (the guard still holds), even
    // though the seeded list itself renders regardless of the org segment.
    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await user.click(screen.getByRole('menuitem', { name: /View all apps/ }));
    expect(push).not.toHaveBeenCalled();
  });

  it('should resolve catch-all (array) route params to their first segment', async () => {
    vi.mocked(useParams).mockReturnValue({ orgName: ['tenant-1'], appName: ['app-a'] });
    const push = setupRouter();
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    // The trigger shows the resolved app name…
    expect(screen.getByRole('button', { name: 'Select app' })).toHaveTextContent('app-a');

    // …the resolved value still matches the current app for the selected state…
    await user.click(screen.getByRole('button', { name: 'Select app' }));
    expect(await screen.findByRole('menuitem', { name: /app-a/ })).toHaveClass('Mui-selected');

    // …and navigation builds from the resolved org segment.
    await user.click(screen.getByRole('menuitem', { name: /View all apps/ }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/tenant-1/apps');
    });
  });

  it('should show the header + only the "View all apps" action while the list is not yet seeded (empty)', async () => {
    const user = userEvent.setup();
    renderAppSelect([]);

    await user.click(screen.getByRole('button', { name: 'Select app' }));

    // No phantom rows from an unresolved seed — just the footer action.
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['View all apps']);
    expect(screen.getByText('Switch app')).toBeInTheDocument();
    expect(items[0]?.querySelector('[data-icon="eva:grid-outline"]')).toBeInTheDocument();
  });

  it('should render display_name as the label while still routing by the slug', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    renderAppSelect([
      { id: 'id-a', name: 'app-a', display_name: 'Triage Bot' },
      { id: 'id-b', name: 'app-b', display_name: null },
    ]);

    expect(
      screen.getByRole('button', { name: 'Select app' }),
    ).toHaveTextContent('Triage Bot');

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    expect(
      await screen.findByRole('menuitem', { name: /Triage Bot/ }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /app-b/ }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/tenant-1/apps/app-b');
    });
  });

  it('should treat an empty seeded list as no rows, not phantom entries', async () => {
    const user = userEvent.setup();
    renderAppSelect([]);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['View all apps']);
  });

  it('should rotate the trigger chevron only while the menu is open', async () => {
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    const chevron = () =>
      document.querySelector('[data-icon="mdi:chevron-down"]');
    expect(chevron()?.getAttribute('data-sx')).not.toContain('rotate(180deg)');

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    expect(chevron()?.getAttribute('data-sx')).toContain('rotate(180deg)');
  });

  it('should track route changes across re-renders (no stale-closure navigation)', async () => {
    const push = setupRouter();
    const user = userEvent.setup();
    const view = renderAppSelect(TWO_APPS);

    // Navigate the params from app-a to app-b mid-session.
    vi.mocked(useParams).mockReturnValue({ orgName: 'tenant-1', appName: 'app-b' });
    rerenderAppSelect(view, TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    const appB = await screen.findByRole('menuitem', { name: /app-b/ });
    expect(appB).toHaveClass('Mui-selected');
    await user.click(appB);
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await user.click(await screen.findByRole('menuitem', { name: /app-a/ }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/tenant-1/apps/app-a');
    });
  });

  it('should pick up an org that appears after the first render for "View all apps"', async () => {
    vi.mocked(useParams).mockReturnValue({ appName: 'app-a' });
    const push = setupRouter();
    const user = userEvent.setup();
    const view = renderAppSelect(TWO_APPS);

    vi.mocked(useParams).mockReturnValue({ orgName: 'tenant-1', appName: 'app-a' });
    rerenderAppSelect(view, TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await user.click(await screen.findByRole('menuitem', { name: /View all apps/ }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/orgs/tenant-1/apps');
    });
  });

  it("shows only the new org's apps once the seed updates after switching orgs", async () => {
    vi.mocked(useParams).mockReturnValue({ orgName: 'org-a', appName: 'app-x' });
    const user = userEvent.setup();
    const view = renderAppSelect([{ id: 'a1', name: 'a1-app', display_name: null }]);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    let items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['a1-app', 'View all apps']);

    // Switch org — the seeded list updates to the new org's apps (a fresh
    // `[appName]` RSC re-seed on navigation), never keeping the stale one.
    vi.mocked(useParams).mockReturnValue({ orgName: 'org-b', appName: 'app-x' });
    rerenderAppSelect(view, [{ id: 'b1', name: 'b1-app', display_name: null }]);

    items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['b1-app', 'View all apps']);
  });

  it('should keep the menu scannable: bounded paper, ellipsised rows, consistent type', async () => {
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await screen.findByRole('menuitem', { name: /app-a/ });

    // A long app list must scroll inside a bounded popover, not grow unbounded.
    const paper = document.querySelector('.MuiMenu-paper');
    expect(paper).toHaveStyle({ minWidth: '200px', maxHeight: '320px' });

    // Long app names ellipsise on one line instead of wrapping the row.
    const primary = screen
      .getByRole('menuitem', { name: /app-a/ })
      .querySelector('.MuiListItemText-primary');
    expect(primary).toHaveClass('MuiTypography-noWrap');
    expect(primary).toHaveClass('MuiTypography-body2');

    // The footer action reads in the same type scale as the rows.
    const footer = screen
      .getByRole('menuitem', { name: /View all apps/ })
      .querySelector('.MuiListItemText-primary');
    expect(footer).toHaveClass('MuiTypography-body2');
  });

  it('should not re-render menu items on an unrelated window focus event (no breadcrumb flicker)', async () => {
    const user = userEvent.setup();
    renderAppSelect(TWO_APPS);

    await user.click(screen.getByRole('button', { name: 'Select app' }));
    await screen.findByRole('menuitem', { name: /app-a/ });

    // The list is seeded context, not a live client fetch — a window focus
    // event has nothing to revalidate and must not change what's rendered.
    fireEvent(window, new Event('focus'));
    await new Promise((r) => setTimeout(r, 20));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['app-a', 'app-b', 'View all apps']);
  });
});
