// @vitest-environment jsdom
/**
 * Dialog submit buttons keep their label while the mutation is in flight.
 *
 * The bug class is a busy affordance that REPLACES the label with a spinner
 * instead of overlaying one: mid-flight the control still has to say what it
 * does, or a screen reader reaches a button with no name and a sighted user
 * loses the only confirmation of which action they committed to. Each case
 * pins the in-flight state positively (still named, disabled) and against the
 * idle state, so a button that never entered the busy state cannot pass.
 *
 * Seams mocked: useDashboards (the mutation, held pending on purpose),
 * useAppPermissions (gate), next/navigation + useSelectedEnv (URL), snackbar,
 * TemplateGallery (irrelevant subtree).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DashboardList } from '../dashboard-list';

vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar: vi.fn() }),
}));

vi.mock('@/lib/adapters/use-app-permissions', () => ({
  useAppPermissions: () => ({
    hasPermission: () => true,
    permissions: [],
    isLoading: false,
  }),
}));

const createDashboard = vi.fn();
const renameDashboard = vi.fn();
const deleteDashboard = vi.fn();
vi.mock('../../hooks/use-dashboards', () => ({
  useDashboards: () => ({
    dashboards: [{ id: 'd1', name: 'Overview', widgetCount: 2, isDefault: false }],
    isLoading: false,
    createDashboard: (...args: unknown[]) => createDashboard(...args),
    deleteDashboard: (...args: unknown[]) => deleteDashboard(...args),
    renameDashboard: (...args: unknown[]) => renameDashboard(...args),
    duplicateDashboard: vi.fn(),
    setDefault: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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

/** Never settles, so the button is observable in its in-flight state. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('DashboardList — dialog submit buttons while busy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the Create button named and disables it while the create is in flight', async () => {
    createDashboard.mockReturnValue(pending());
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    await user.click(screen.getByRole('button', { name: /new dashboard/i }));
    await user.type(screen.getByLabelText('Name'), 'Latency');

    const submit = screen.getByRole('button', { name: 'Create' });
    // Idle: named and live. Without this the in-flight assertion below could
    // pass against a button that was never enabled in the first place.
    expect(submit).toBeEnabled();

    await user.click(submit);

    await vi.waitFor(() => expect(submit).toBeDisabled());
    // The label survives the spinner — this is the assertion the icon-swap
    // pattern fails, because it removes the text node entirely.
    expect(submit).toHaveTextContent('Create');
    expect(createDashboard).toHaveBeenCalledWith({ name: 'Latency' });
  });

  it('keeps the Rename button named and disables it while the rename is in flight', async () => {
    renameDashboard.mockReturnValue(pending());
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    await user.click(screen.getByLabelText('Dashboard actions for Overview'));
    await user.click(screen.getByText('Rename'));

    const submit = screen.getByRole('button', { name: 'Rename' });
    expect(submit).toBeEnabled();

    await user.click(submit);

    await vi.waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent('Rename');
    expect(renameDashboard).toHaveBeenCalledWith('d1', 'Overview');
  });

  it('keeps the Delete button named and disables it while the delete is in flight', async () => {
    deleteDashboard.mockReturnValue(pending());
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    await user.click(screen.getByLabelText('Dashboard actions for Overview'));
    await user.click(screen.getByText('Delete'));

    const submit = screen.getByRole('button', { name: 'Delete' });
    expect(submit).toBeEnabled();

    await user.click(submit);

    await vi.waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent('Delete');
    expect(deleteDashboard).toHaveBeenCalledWith('d1');
  });
});
