// @vitest-environment jsdom
/**
 * useNavData hook tests
 *
 * Navigation sidebar must filter items based on the user's effective
 * permissions. Dashboards and Context lead the rail, followed by Workers and
 * the agents-only surfaces Sessions / Findings (trace.read). Settings trails
 * the rail — there is no Deployments item, and no "Getting started" or
 * "Overview" item.
 */
import { renderHook } from '@testing-library/react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useParams: () => ({ orgName: 'test-org', appName: 'test-app' }),
}));

// Mock locales
vi.mock('@outerlayer/locales', () => ({
  useTranslate: () => ({
    t: (key: string) => key,
  }),
}));

// Mock iconify
vi.mock('@/components/iconify', () => ({
  __esModule: true,
  default: ({ icon }: any) => <span data-testid={`icon-${icon}`} />,
}));

// Mock app paths
vi.mock('../../../routes/paths', () => ({
  appPaths: {
    developers: { root: (org: string, app: string) => `/${org}/${app}/settings` },
    insights: { root: (org: string, app: string) => `/${org}/${app}/insights` },
    dashboards: { root: (org: string, app: string) => `/${org}/${app}/dashboards` },
    workers: { root: (org: string, app: string) => `/${org}/${app}/workers` },
    context: { root: (org: string, app: string) => `/${org}/${app}/context` },
    agents: {
      sessions: (org: string, app: string) => `/${org}/${app}/agents/sessions`,
      findings: (org: string, app: string) => `/${org}/${app}/agents/findings`,
    },
  },
}));

// Mock auth hooks — controlled per test
const mockUseAuthContext = vi.fn();

vi.mock('../../../auth/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
}));

// Mock app context and app-level permissions to avoid module-level supabase init
const mockAppContext = vi.fn();
vi.mock('@/lib/app-shell/app-context/use-app-context', () => ({
  useAppContext: () => mockAppContext(),
}));

const mockUseAppPermissions = vi.fn();
vi.mock('../../../auth/hooks/use-app-permissions', () => ({
  useAppPermissions: (...args: any[]) => mockUseAppPermissions(...args),
}));

import { useNavData } from '../config-navigation';

const perm = (permission: string) => ({ id: 'p', role: 'read' as const, permission: permission as any });

/** Extract nav items from hook result — first section's items array. */
function getItems(data: ReturnType<typeof useNavData>): { title: string; path: string }[] {
  return data[0]?.items ?? [];
}

describe('useNavData — permission filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no app context, no app permissions
    mockAppContext.mockReturnValue({ app: null, loading: false, hasCreatedTrace: false });
    mockUseAppPermissions.mockReturnValue({ permissions: [], hasPermission: () => false, isLoading: false });
  });

  it('shows the full nav when user has every permission', () => {
    mockUseAuthContext.mockReturnValue({
      user: {
        permissions: [
          perm('trace.read'), perm('app.read'),
          perm('dashboard.read'),
          perm('worker_run.read'),
          perm('experiment.read'), perm('context.read'),
        ],
      },
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    // Positional: order is the rail order. Dashboards and Context lead the
    // rail (Context is app-level, no /env/ segment), Workers sits directly
    // under Context, and Settings trails the rail (there is no Deployments
    // item — no deploy pipeline to surface).
    expect(items.map((i) => i.title)).toEqual([
      'dashboard.sidebar.dashboards',
      'Context',
      'Workers',
      'Sessions', 'Findings',
      'dashboard.sidebar.topics',
      'dashboard.sidebar.settings',
    ]);
    expect(items.map((i) => i.path)).toEqual([
      '/test-org/test-app/dashboards',
      '/test-org/test-app/context',
      '/test-org/test-app/workers',
      '/test-org/test-app/agents/sessions',
      '/test-org/test-app/agents/findings',
      '/test-org/test-app/insights',
      '/test-org/test-app/settings',
    ]);
  });

  it('hides Context when the user lacks context.read', () => {
    mockUseAuthContext.mockReturnValue({
      user: {
        permissions: [
          perm('trace.read'), perm('app.read'),
          perm('dashboard.read'),
          perm('experiment.read'),
        ],
      },
    });

    const { result } = renderHook(() => useNavData());
    const titles = getItems(result.current).map((i) => i.title);

    expect(titles).not.toContain('Context');
    // The rest of the rail is unaffected.
    expect(titles).toContain('dashboard.sidebar.settings');
  });

  it('returns a single group carrying only items — no subheader/heading key', () => {
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [perm('trace.read')] },
    });

    const { result } = renderHook(() => useNavData());

    expect(result.current).toHaveLength(1);
    // The lone group must expose exactly `items` — the "App" heading is gone,
    // so the rail renders no group label or collapse toggle.
    expect(Object.keys(result.current[0]!)).toEqual(['items']);
  });

  it('shows only trace.read surfaces when user lacks the other permissions', () => {
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [perm('trace.read')] },
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    expect(items.map((i) => i.title)).toEqual(['Sessions', 'Findings', 'dashboard.sidebar.topics']);
  });

  it('shows only settings when user has only app.read', () => {
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [perm('app.read')] },
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    expect(items.map((i) => i.title)).toEqual(['dashboard.sidebar.settings']);
  });

  it('shows only Dashboards when user has only dashboard.read', () => {
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [perm('dashboard.read')] },
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    expect(items.map((i) => i.title)).toEqual(['dashboard.sidebar.dashboards']);
  });

  it('shows only Workers when user has only worker_run.read', () => {
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [perm('worker_run.read')] },
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    expect(items.map((i) => i.title)).toEqual(['Workers']);
  });

  it('shows no items when user has empty permissions', () => {
    mockUseAuthContext.mockReturnValue({
      user: { permissions: [] },
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    expect(items).toHaveLength(0);
  });

  it('handles null user gracefully (no items)', () => {
    mockUseAuthContext.mockReturnValue({
      user: null,
    });

    const { result } = renderHook(() => useNavData());
    const items = getItems(result.current);

    expect(items).toHaveLength(0);
  });

  // =========================================================================
  // App context permission resolution
  // =========================================================================

  describe('app context permission resolution', () => {
    it('uses app-level permissions when app context has a non-null id and useAppPermissions has loaded', () => {
      // Org grants everything, app-level grants app.read only.
      mockAppContext.mockReturnValue({ app: { id: 'app-123' }, loading: false, hasCreatedTrace: true });
      mockUseAppPermissions.mockReturnValue({
        permissions: [perm('app.read')],
        hasPermission: (p: string) => p === 'app.read',
        isLoading: false,
      });
      mockUseAuthContext.mockReturnValue({
        user: { permissions: [perm('trace.read'), perm('app.read')] },
      });

      const { result } = renderHook(() => useNavData());
      const titles = getItems(result.current).map((i) => i.title);

      // App-level wins: settings only, no agents sections.
      expect(titles).toEqual(['dashboard.sidebar.settings']);
    });

    it('falls back to user.permissions while app-level permissions are loading (isLoading true)', () => {
      mockAppContext.mockReturnValue({ app: { id: 'app-123' }, loading: false, hasCreatedTrace: true });
      mockUseAppPermissions.mockReturnValue({
        permissions: [],
        hasPermission: () => false,
        isLoading: true,
      });
      mockUseAuthContext.mockReturnValue({
        user: { permissions: [perm('trace.read')] },
      });

      const { result } = renderHook(() => useNavData());
      const titles = getItems(result.current).map((i) => i.title);

      expect(titles).toEqual(['Sessions', 'Findings', 'dashboard.sidebar.topics']);
    });

    it('uses org-level permissions when app.id is null', () => {
      mockAppContext.mockReturnValue({ app: { id: null }, loading: false, hasCreatedTrace: true });
      mockUseAppPermissions.mockReturnValue({
        permissions: [],
        hasPermission: () => false,
        isLoading: false,
      });
      mockUseAuthContext.mockReturnValue({
        user: { permissions: [perm('trace.read')] },
      });

      const { result } = renderHook(() => useNavData());
      const titles = getItems(result.current).map((i) => i.title);

      expect(titles).toEqual(['Sessions', 'Findings', 'dashboard.sidebar.topics']);
    });

    it('shows no items when app context is present and useAppPermissions returns empty permissions', () => {
      mockAppContext.mockReturnValue({ app: { id: 'app-123' }, loading: false, hasCreatedTrace: true });
      mockUseAppPermissions.mockReturnValue({
        permissions: [],
        hasPermission: () => false,
        isLoading: false,
      });
      mockUseAuthContext.mockReturnValue({
        user: { permissions: [perm('trace.read'), perm('app.read')] },
      });

      const { result } = renderHook(() => useNavData());

      expect(getItems(result.current)).toHaveLength(0);
    });
  });
});
