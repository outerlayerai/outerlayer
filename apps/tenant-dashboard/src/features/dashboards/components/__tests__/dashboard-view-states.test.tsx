// @vitest-environment jsdom
/**
 * The dashboard detail view: page identity, the load-error/not-found split,
 * and widget-delete failure feedback.
 *
 * The detail is server-loaded, so a failed read and a dashboard that genuinely
 * does not exist both arrive as a null dashboard. Only the failure message
 * distinguishes them — without it a transient read error tells the user their
 * dashboard was deleted. Widget delete has the mirror problem: both the thrown
 * and the `ok: false` outcome leave the widget on the grid, so an unreported
 * failure reads as a delete that silently undid itself.
 *
 * Seams mocked: react-grid-layout (DOM measurement), WidgetRenderer (its own
 * data fetching), the deleteWidget action, snackbar, next/navigation.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, createTheme } from '@mui/material/styles';

const enqueueSnackbar = vi.fn();
const refresh = vi.fn();

vi.mock('@/components/snackbar', () => ({
  useSnackbar: () => ({ enqueueSnackbar }),
}));

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

vi.mock('react-grid-layout', () => ({
  GridLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null } }),
}));

vi.mock('../widget-renderer', () => ({
  WidgetRenderer: ({
    widget,
    onDelete,
  }: {
    widget: { id: string; title: string };
    onDelete?: (id: string) => void;
  }) => (
    <div data-testid={`widget-${widget.id}`}>
      {widget.title}
      <button type="button" onClick={() => onDelete?.(widget.id)}>
        Delete {widget.id}
      </button>
    </div>
  ),
}));

// Stubbed down to its `open` prop: the dialog's own internals are covered
// elsewhere, and its visibility is the only thing the view controls.
vi.mock('../widget-config-dialog', () => ({
  WidgetConfigDialog: ({ open, dashboardId }: { open: boolean; dashboardId: string }) =>
    open ? <div data-testid="widget-config-dialog">{dashboardId}</div> : null,
}));

const deleteWidget = vi.fn();
vi.mock('../../actions', () => ({
  deleteWidget: (...args: unknown[]) => deleteWidget(...args),
  saveDashboardLayout: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../hooks/use-dashboards', () => ({
  useDashboards: () => ({ dashboards: [] }),
}));

import { DashboardView } from '../dashboard-view';
import type { Dashboard } from '../../types';

const NOT_FOUND_COPY = /may have been deleted/i;

function makeDashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'd1',
    name: 'Executive Overview',
    description: 'Fleet health at a glance',
    isDefault: true,
    globalTimeRange: '7d',
    layout: [{ widgetId: 'w1', x: 0, y: 0, w: 6, h: 4 }],
    widgets: [
      {
        id: 'w1',
        dashboardId: 'd1',
        title: 'Requests',
        metric: 'request_count',
        visualization: 'line',
        filters: [],
        groupBy: null,
        timeGranularity: 'auto',
        createdAt: '2026-01-01',
        updatedAt: null,
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
    ...over,
  };
}

// A fresh dashboardId per render keeps each mount on its own SWR cache entry —
// `fallbackData` only seeds a key the first time it is seen.
let idCounter = 0;
function renderView(props: { dashboard?: Dashboard | null; loadError?: string | null } = {}) {
  idCounter += 1;
  const dashboardId = `d-${idCounter}`;
  // Any supplied dashboard is re-stamped with this render's id so the seeded
  // record and the requested key never disagree.
  const dashboard =
    props.dashboard === undefined
      ? makeDashboard({ id: dashboardId })
      : props.dashboard && { ...props.dashboard, id: dashboardId };
  return {
    dashboardId,
    ...render(
      <ThemeProvider theme={createTheme()}>
        <DashboardView
          dashboardId={dashboardId}
          appId="app-1"
          initialDashboard={dashboard}
          initialDashboards={[]}
          loadError={props.loadError ?? null}
        />
      </ThemeProvider>,
    ),
  };
}

describe('DashboardView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('titles the page with the dashboard name', () => {
    renderView();

    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('Executive Overview');
  });

  it('carries the title, description, and every page control in one header', () => {
    renderView();

    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 4 })).toHaveTextContent(
      'Executive Overview',
    );
    expect(screen.getByTestId('page-header-caption')).toHaveTextContent('Fleet health at a glance');

    // The switcher is a page control, so it sits in the trailing action slot
    // beside the others rather than inside the title.
    const actions = screen.getByTestId('page-header-actions');
    expect(within(actions).getByRole('button', { name: 'Switch' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /add widget/i })).toBeInTheDocument();

    // Inside the heading, "Switch" would land in the page title's accessible
    // name and be announced as part of it.
    expect(
      within(screen.getByRole('heading', { level: 4 })).queryByRole('button'),
    ).not.toBeInTheDocument();
  });

  it('omits the caption for a dashboard with no description', () => {
    renderView({ dashboard: makeDashboard({ description: null }) });

    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('Executive Overview');
    expect(screen.queryByTestId('page-header-caption')).not.toBeInTheDocument();
  });

  it('renders the empty widget grid as a create-your-first prompt, not a fault', () => {
    renderView({ dashboard: makeDashboard({ widgets: [], layout: [] }) });

    const empty = screen.getByTestId('empty-state');
    expect(empty).toHaveTextContent('No widgets yet');
    // Dashed reads as a slot waiting to be filled; the card treatment is for a
    // plain absence like not-found.
    expect(empty).toHaveAttribute('data-variant', 'dashed');
    // An empty grid is not a failure, so it must not announce as one.
    expect(empty).not.toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  // Both entry points open the same dialog against the same dashboard, so a
  // decorative button — one that lost its handler when the control moved into
  // the header's action slot or the empty state's action slot — fails here.
  it('opens the widget dialog for this dashboard from the header action', async () => {
    const user = userEvent.setup();
    const { dashboardId } = renderView();

    expect(screen.queryByTestId('widget-config-dialog')).not.toBeInTheDocument();

    await user.click(
      within(screen.getByTestId('page-header-actions')).getByRole('button', {
        name: /add widget/i,
      }),
    );

    expect(screen.getByTestId('widget-config-dialog')).toHaveTextContent(dashboardId);
  });

  it('opens the widget dialog for this dashboard from the empty grid prompt', async () => {
    const user = userEvent.setup();
    const { dashboardId } = renderView({ dashboard: makeDashboard({ widgets: [], layout: [] }) });

    expect(screen.queryByTestId('widget-config-dialog')).not.toBeInTheDocument();

    await user.click(
      within(screen.getByTestId('empty-state')).getByRole('button', { name: /add widget/i }),
    );

    expect(screen.getByTestId('widget-config-dialog')).toHaveTextContent(dashboardId);
  });

  it('renders a failed read as a retryable error, never as the not-found state', async () => {
    const user = userEvent.setup();
    renderView({ dashboard: null, loadError: 'Supabase connection reset' });

    const card = screen.getByTestId('error-state');
    expect(card).toHaveTextContent("Couldn't load this dashboard");
    expect(card).toHaveTextContent('Supabase connection reset');
    // A failure is announced; the two look alike, so the role is what tells a
    // screen reader this is a fault and not an empty result.
    expect(card).toHaveAttribute('role', 'alert');
    // The bug class: an unreadable dashboard reported as a deleted one.
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND_COPY)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry now/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the not-found state when the read succeeded and resolved no dashboard', () => {
    renderView({ dashboard: null, loadError: null });

    const card = screen.getByTestId('empty-state');
    expect(card).toBeInTheDocument();
    expect(screen.getByText(NOT_FOUND_COPY)).toBeInTheDocument();
    // A missing dashboard is an absence, not a fault: card treatment, and it
    // must not announce as an alert the way the failed read above does.
    expect(card).toHaveAttribute('data-variant', 'card');
    expect(card).not.toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  // proves AC-063-15
  it('toasts a thrown widget delete and leaves the widget on the grid', async () => {
    deleteWidget.mockRejectedValue(new Error('Network request failed'));
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: /delete w1/i }));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Network request failed', { variant: 'error' }),
    );
    expect(screen.getByTestId('widget-w1')).toBeInTheDocument();
  });

  it('toasts a rejected widget delete and leaves the widget on the grid', async () => {
    deleteWidget.mockResolvedValue({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Permission denied: dashboard.update' },
    });
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: /delete w1/i }));

    await vi.waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith('Permission denied: dashboard.update', {
        variant: 'error',
      }),
    );
    expect(screen.getByTestId('widget-w1')).toBeInTheDocument();
  });

  it('removes the widget and says nothing when the delete succeeds', async () => {
    deleteWidget.mockResolvedValue({ ok: true, data: undefined });
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: /delete w1/i }));

    await vi.waitFor(() => expect(screen.queryByTestId('widget-w1')).not.toBeInTheDocument());
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });
});
