// @vitest-environment jsdom
/**
 * The empty state's "Create Empty Dashboard" prompt opens the create dialog on
 * a cleared name field.
 *
 * Two bug classes: a prompt that renders but does nothing (the action slot of a
 * shared empty state takes any node, so a handler dropped in the move is
 * invisible), and a dialog that reopens still holding whatever the user typed
 * before abandoning it — which reads as a half-finished dashboard they never
 * created.
 *
 * Seams mocked: useDashboards (data + mutations), useAppPermissions (gate),
 * next/navigation + useSelectedEnv (URL), snackbar, TemplateGallery.
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

vi.mock('../../hooks/use-dashboards', () => ({
  useDashboards: () => ({
    dashboards: [],
    isLoading: false,
    createDashboard: vi.fn(),
    deleteDashboard: vi.fn(),
    renameDashboard: vi.fn(),
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

describe('DashboardList — empty-state create prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the create dialog on an empty name field, discarding an abandoned draft', async () => {
    const user = userEvent.setup();
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    // Abandon a draft first: the reopened dialog must not inherit it.
    await user.click(screen.getByRole('button', { name: /new dashboard/i }));
    await user.type(screen.getByLabelText('Name'), 'Abandoned draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /create empty dashboard/i }));

    expect(screen.getByRole('dialog')).toHaveTextContent('New Dashboard');
    expect(screen.getByLabelText('Name')).toHaveValue('');
    // An empty name has nothing to submit, so the action stays closed off.
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
