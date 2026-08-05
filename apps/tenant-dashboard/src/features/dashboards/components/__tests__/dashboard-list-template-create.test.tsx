// @vitest-environment jsdom
/**
 * Regression: creating a dashboard from the template gallery has to land in
 * the SAME list the gallery sits under.
 *
 * Both surfaces must write through the one path that updates the SWR cache:
 * `useDashboards().createDashboard`, which writes the cache via `mutate`.
 * A gallery that called the `createDashboard` server action directly would
 * leave the cache untouched, and `dashboards = data ?? initialDashboards`
 * (`use-dashboards.ts`) then re-renders the pre-write cache — the new
 * dashboard stays invisible until a hard reload. This renders the REAL
 * `TemplateGallery` (not stubbed, unlike `dashboard-list-create-gating.test`)
 * under the REAL `useDashboards` (real SWR cache, only the server action
 * mocked), so the shared path is proven end to end: click "Use Template", the
 * new dashboard shows up in the list's own grid.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DashboardList } from '../dashboard-list';
import type { DashboardTemplate } from '../../types';
import type { Permission } from '@/utils/permissions';

const mockHasPermission = vi.fn();
vi.mock('@/lib/adapters/use-app-permissions', () => ({
  useAppPermissions: () => ({ hasPermission: mockHasPermission, permissions: [], isLoading: false }),
}));

const enqueueSnackbar = vi.fn();
vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
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

// Only the server action boundary is mocked — `useDashboards` and
// `TemplateGallery` run for real, so the SWR cache write path is exercised
// exactly as it is at runtime.
const createDashboardMock = vi.fn();
vi.mock('../../actions', () => ({
  createDashboard: (...args: unknown[]) => createDashboardMock(...args),
}));

function setPermissions(perms: Permission[]) {
  mockHasPermission.mockImplementation((p: Permission) => perms.includes(p));
}

const template: DashboardTemplate = {
  id: 'agent-outcomes',
  name: 'Agent Outcomes',
  description: 'Is it working?',
  widgetCount: 2,
  widgets: [{ title: 'Clean Job Rate', metric: 'clean_job_rate', visualization: 'stat' }],
};

describe('DashboardList — template-gallery create lands in the same list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the newly created dashboard in the grid immediately after "Use Template", with no reload', async () => {
    setPermissions(['dashboard.read', 'dashboard.insert']);
    createDashboardMock.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'd-new',
        name: 'Agent Outcomes',
        description: null,
        isDefault: false,
        globalTimeRange: '7d',
        layout: [],
        widgets: [{}, {}],
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: null,
      },
    });

    const user = userEvent.setup();
    render(
      <DashboardList
        appId="app-1"
        initialDashboards={[{ id: 'd-existing', name: 'Existing', description: null, isDefault: false, widgetCount: 1, globalTimeRange: '7d', createdAt: '2026-01-01T00:00:00Z', updatedAt: null }]}
        initialTemplates={[template]}
      />,
    );

    // Only one "Agent Outcomes" exists before create: the template card's own title.
    expect(screen.getAllByText('Agent Outcomes')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /use template/i }));

    // After create, a SECOND "Agent Outcomes" appears — the new dashboard's
    // card in the grid, alongside the template gallery's own card title.
    await waitFor(() => {
      expect(screen.getAllByText('Agent Outcomes')).toHaveLength(2);
    });
    // The pre-existing row is still there — the write appended, it did not replace the list.
    expect(screen.getByText('Existing')).toBeInTheDocument();
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('d-new'));
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });

  it('toasts a failed template create instead of leaving the click unanswered', async () => {
    setPermissions(['dashboard.read', 'dashboard.insert']);
    createDashboardMock.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Maximum of 20 dashboards reached' },
    });

    const user = userEvent.setup();
    render(
      <DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[template]} />,
    );

    await user.click(screen.getByRole('button', { name: /use template/i }));

    // Nothing on this surface reflects the new dashboard, so a dropped error is
    // indistinguishable from a create that worked and then undid itself.
    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Maximum of 20 dashboards reached', {
        variant: 'error',
      }),
    );
    // A failed create must not navigate.
    expect(pushMock).not.toHaveBeenCalled();
  });
});
