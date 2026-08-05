// @vitest-environment jsdom
/**
 * Regression test for dashboard create-affordance gating.
 *
 * The template gallery offers create-from-template actions, so it must be
 * gated on `dashboard.insert` exactly like the "Create Empty Dashboard" button
 * — rendering it unconditionally leaks create affordances to view-only users
 * (whose clicks then 500 against RLS). This pins that the gallery is hidden
 * without `dashboard.insert` and shown with it, in both the empty and
 * non-empty dashboard states.
 *
 * Seams mocked: useAppPermissions (permission gate), useDashboards (data
 * seam), next/navigation (URL seam), and TemplateGallery (stubbed to an
 * identifiable marker so we assert gating, not its internals).
 */

import { render, screen } from '@testing-library/react';

import { DashboardList } from '../dashboard-list';
import type { Permission } from '@/utils/permissions';

const mockHasPermission = vi.fn();
vi.mock('@/lib/adapters/use-app-permissions', () => ({
  useAppPermissions: () => ({ hasPermission: mockHasPermission, permissions: [], isLoading: false }),
}));

const mockUseDashboards = vi.fn();
vi.mock('../../hooks/use-dashboards', () => ({
  useDashboards: () => mockUseDashboards(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ orgName: 'org-1', appName: 'app-1', envName: 'dev' }),
}));

// DashboardList builds env-scoped dashboard links via useSelectedEnv; mock it
// to the default env (no EnvProvider in this test).
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

function setPermissions(perms: Permission[]) {
  mockHasPermission.mockImplementation((p: Permission) => perms.includes(p));
}

function setDashboards(list: Array<{ id: string; name: string; widgetCount: number; isDefault?: boolean }>) {
  mockUseDashboards.mockReturnValue({
    dashboards: list,
    isLoading: false,
    createDashboard: vi.fn(),
    deleteDashboard: vi.fn(),
    renameDashboard: vi.fn(),
    duplicateDashboard: vi.fn(),
    setDefault: vi.fn(),
  });
}

describe('DashboardList — create-affordance gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the template gallery for a viewer without dashboard.insert (empty state)', () => {
    setPermissions(['dashboard.read']);
    setDashboards([]);

    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    expect(screen.queryByTestId('template-gallery')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create empty dashboard/i })).not.toBeInTheDocument();
  });

  it('hides the template gallery for a viewer without dashboard.insert (non-empty state)', () => {
    setPermissions(['dashboard.read']);
    setDashboards([{ id: 'd1', name: 'Existing', widgetCount: 2 }]);

    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    expect(screen.queryByTestId('template-gallery')).not.toBeInTheDocument();
  });

  it('shows the template gallery when the user has dashboard.insert', () => {
    setPermissions(['dashboard.read', 'dashboard.insert']);
    setDashboards([]);

    render(<DashboardList appId="app-1" initialDashboards={[]} initialTemplates={[]} />);

    expect(screen.getByTestId('template-gallery')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create empty dashboard/i })).toBeInTheDocument();
  });
});
