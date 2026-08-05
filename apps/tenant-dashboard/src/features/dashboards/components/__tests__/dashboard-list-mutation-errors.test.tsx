// @vitest-environment jsdom
/**
 * Menu-driven dashboard mutations report their failures.
 *
 * Duplicate and Set-as-Default fire from a menu with no dialog to carry a
 * `helperText`, and the list behind them is a fetcher-less cache that the
 * failed mutation was itself the only writer of. A dropped error therefore
 * leaves the grid identical to a success — the user believes the action took.
 *
 * Seams mocked: useDashboards (data), useAppPermissions (gate),
 * next/navigation + useSelectedEnv (URL), snackbar (toast transport),
 * TemplateGallery (irrelevant subtree).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DashboardList } from '../dashboard-list';

const enqueueSnackbar = vi.fn();
vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

vi.mock('@/lib/adapters/use-app-permissions', () => ({
  useAppPermissions: () => ({
    hasPermission: () => true,
    permissions: [],
    isLoading: false,
  }),
}));

const duplicateDashboard = vi.fn();
const setDefault = vi.fn();
vi.mock('../../hooks/use-dashboards', () => ({
  useDashboards: () => ({
    dashboards: [{ id: 'd1', name: 'Overview', widgetCount: 2, isDefault: false }],
    isLoading: false,
    createDashboard: vi.fn(),
    deleteDashboard: vi.fn(),
    renameDashboard: vi.fn(),
    duplicateDashboard: (...args: unknown[]) => duplicateDashboard(...args),
    setDefault: (...args: unknown[]) => setDefault(...args),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ orgName: 'org-1', appName: 'app-1', envName: 'dev' }),
}));

vi.mock('@/hooks/environments/use-selected-env', () => ({
  useSelectedEnv: () => ({
    name: 'dev',
    id: 'env-dev',
    isPinned: false,
    pinnedVersion: null,
    currentCommitSha: null,
    isDefault: true,
    isUnknown: false,
    nameSource: 'default',
  }),
}));

vi.mock('../template-gallery', () => ({
  TemplateGallery: () => <div data-testid="template-gallery" />,
}));

async function openCardMenu(user: ReturnType<typeof userEvent.setup>) {
  // Selected by the card's accessible name, so adding any trailing button to
  // the page cannot silently retarget these tests at the wrong control.
  await user.click(screen.getByLabelText('Dashboard actions for Overview'));
}

describe('DashboardList — menu mutation failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts the duplicate failure with the error message', async () => {
    duplicateDashboard.mockRejectedValue(new Error('Maximum of 20 dashboards reached'));
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    await openCardMenu(user);
    await user.click(screen.getByText('Duplicate'));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Maximum of 20 dashboards reached', {
        variant: 'error',
      }),
    );
    expect(duplicateDashboard).toHaveBeenCalledWith('d1');
  });

  it('toasts the set-default failure with the error message', async () => {
    setDefault.mockRejectedValue(new Error('Permission denied: dashboard.update'));
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    await openCardMenu(user);
    await user.click(screen.getByText('Set as Default'));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Permission denied: dashboard.update', {
        variant: 'error',
      }),
    );
    expect(setDefault).toHaveBeenCalledWith('d1');
  });

  it('stays quiet when the mutation succeeds', async () => {
    duplicateDashboard.mockResolvedValue({ id: 'd2' });
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    await openCardMenu(user);
    await user.click(screen.getByText('Duplicate'));

    await vi.waitFor(() => expect(duplicateDashboard).toHaveBeenCalledWith('d1'));
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });
});
