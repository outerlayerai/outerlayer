// @vitest-environment jsdom
/**
 * The list renders a read failure and an empty app as different things.
 *
 * The cold-start block ("No dashboards yet" + the template gallery) tells the
 * user they have never created a dashboard. Rendering it for a failed read
 * says their dashboards are gone, which is both false and unactionable — the
 * failure needs its own card with a way to retry. Each direction is pinned
 * negatively, because the bug is one state wearing the other's clothes.
 *
 * Seams mocked: useDashboards (data), useAppPermissions (gate),
 * next/navigation + useSelectedEnv (URL), TemplateGallery (identified by a
 * stub so its presence is assertable either way).
 */

import { render, screen, within } from '@testing-library/react';
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

let dashboards: unknown[] = [];
vi.mock('../../hooks/use-dashboards', () => ({
  useDashboards: () => ({
    dashboards,
    isLoading: false,
    createDashboard: vi.fn(),
    deleteDashboard: vi.fn(),
    renameDashboard: vi.fn(),
    duplicateDashboard: vi.fn(),
    setDefault: vi.fn(),
  }),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
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

beforeEach(() => {
  vi.clearAllMocks();
  dashboards = [];
});

/** The secondary sentence the page sends down; the heading is the card's own. */
const READ_FAILED = "The dashboard list couldn't be read just now. Nothing was lost — try again.";

describe('DashboardList — a failed read', () => {
  // proves AC-063-14
  it('reports the failure and withholds the cold-start invitation', async () => {
    render(
      <DashboardList
        appId="app-1"
        initialDashboards={[]}
        initialTemplates={[]}
        loadError={READ_FAILED}
      />,
    );

    // Heading and body have to say different things — the body is the page's
    // secondary sentence, not a second copy of the heading.
    const card = screen.getByTestId('error-state');
    expect(card).toHaveTextContent("Couldn't load your dashboards");
    expect(card).toHaveTextContent(READ_FAILED);
    // The two cards look alike, so the role is what marks this one a fault
    // rather than an empty account.
    expect(card).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('No dashboards yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Empty Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('template-gallery')).not.toBeInTheDocument();
  });

  it('disables the header create action so retry is the only offered path', () => {
    render(
      <DashboardList
        appId="app-1"
        initialDashboards={[]}
        initialTemplates={[]}
        loadError={READ_FAILED}
      />,
    );

    expect(screen.getByRole('button', { name: /new dashboard/i })).toBeDisabled();
  });

  it('re-runs the server render on retry', async () => {
    const user = userEvent.setup();
    render(
      <DashboardList
        appId="app-1"
        initialDashboards={[]}
        initialTemplates={[]}
        loadError={READ_FAILED}
      />,
    );

    await user.click(screen.getByRole('button', { name: /retry now/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardList — a successful read', () => {
  it('invites the user to create their first dashboard when the app is genuinely empty', () => {
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    const empty = screen.getByTestId('empty-state');
    expect(empty).toHaveTextContent('No dashboards yet');
    expect(screen.getByTestId('template-gallery')).toBeInTheDocument();
    // Dashed is the create-your-first treatment — the outline reads as a slot
    // waiting to be filled rather than a result card.
    expect(empty).toHaveAttribute('data-variant', 'dashed');
    // An empty account is not a fault, so it must not announce as one the way
    // the failed read above does.
    expect(empty).not.toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('carries the title and the create action in one page header', () => {
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 4 })).toHaveTextContent('Dashboards');
    expect(
      within(screen.getByTestId('page-header-actions')).getByRole('button', {
        name: /new dashboard/i,
      }),
    ).toBeInTheDocument();
    // A page has exactly one title. The cold-start card's own heading is an h6,
    // so a second h4 here would mean the empty state grew a page title.
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1);
  });

  it('names each card menu so the control is reachable by its dashboard', () => {
    dashboards = [
      { id: 'd1', name: 'Overview', widgetCount: 2, isDefault: false },
      { id: 'd2', name: 'Latency', widgetCount: 1, isDefault: false },
    ];
    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    expect(screen.getByLabelText('Dashboard actions for Overview')).toBeInTheDocument();
    expect(screen.getByLabelText('Dashboard actions for Latency')).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});
