// @vitest-environment jsdom
/**
 * Tests: useDashboards
 *
 * The list is seeded by a React Server Component (RSC), with no GET route
 * behind it — these tests
 * exercise the real SWR cache so `mutate(next, { revalidate: false })`
 * behaves exactly as it does at runtime, rather than a hand-rolled stub.
 * Each CRUD method is asserted on the *resulting cache shape*, not just
 * "was called" — the point of this hook is that the cache stays correct with
 * no server round-trip to re-derive it from.
 */

vi.mock('server-only', () => ({}));

// Every CRUD method calls its matching `authorizedAction` directly (no route
// survives behind the list) — mocked at the module boundary so the hook's
// cache-write logic is exercised without a real ServiceContext/DB.
const {
  createDashboardMock,
  deleteDashboardMock,
  renameDashboardMock,
  duplicateDashboardMock,
  setDefaultDashboardMock,
} = vi.hoisted(() => ({
  createDashboardMock: vi.fn(),
  deleteDashboardMock: vi.fn(),
  renameDashboardMock: vi.fn(),
  duplicateDashboardMock: vi.fn(),
  setDefaultDashboardMock: vi.fn(),
}));
vi.mock('../../actions', () => ({
  createDashboard: createDashboardMock,
  deleteDashboard: deleteDashboardMock,
  renameDashboard: renameDashboardMock,
  duplicateDashboard: duplicateDashboardMock,
  setDefaultDashboard: setDefaultDashboardMock,
}));

import { renderHook, waitFor, act } from '@testing-library/react';
import { useDashboards } from '../use-dashboards';
import type { DashboardSummary } from '../../types';

const summary = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id: 'd1',
  name: 'Overview',
  description: null,
  isDefault: false,
  widgetCount: 0,
  globalTimeRange: '7d',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// SWR's default cache is global and keyed by `['/api/dashboards', appId]`;
// `fallbackData` only seeds a key the FIRST time it's seen, so two tests
// reusing the same appId would leak the previous test's mutated cache
// into the next render. A fresh appId per test keeps each hook mount on
// its own cache entry.
let appIdCounter = 0;
function uniqueAppId(): string {
  appIdCounter += 1;
  return `app-${appIdCounter}`;
}

describe('useDashboards', () => {
  it('presents the seeded list with no fetch on mount', () => {
    const initial = [summary({ id: 'd1' }), summary({ id: 'd2' })];
    const appId = uniqueAppId();
    renderHook(() => useDashboards({ appId, initialDashboards: initial }));

    expect(createDashboardMock).not.toHaveBeenCalled();
  });

  it('appends the created dashboard to the cached list', async () => {
    const initial = [summary({ id: 'd1' })];
    createDashboardMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 'd2', name: 'New', description: null, isDefault: false, globalTimeRange: '7d', layout: [], widgets: [{}], createdAt: '2026-02-01', updatedAt: null },
    });

    const appId = uniqueAppId();
    const { result } = renderHook(() => useDashboards({ appId, initialDashboards: initial }));

    await act(async () => {
      await result.current.createDashboard({ name: 'New' });
    });

    await waitFor(() => {
      expect(result.current.dashboards.map((d) => d.id)).toEqual(['d1', 'd2']);
    });
    expect(result.current.dashboards[1]).toEqual(
      expect.objectContaining({ id: 'd2', name: 'New', widgetCount: 1 }),
    );
  });

  it('removes the deleted dashboard from the cached list', async () => {
    const initial = [summary({ id: 'd1' }), summary({ id: 'd2' })];
    deleteDashboardMock.mockResolvedValueOnce({ ok: true, data: undefined });

    const appId = uniqueAppId();
    const { result } = renderHook(() => useDashboards({ appId, initialDashboards: initial }));

    await act(async () => {
      await result.current.deleteDashboard('d1');
    });

    await waitFor(() => {
      expect(result.current.dashboards).toEqual([summary({ id: 'd2' })]);
    });
  });

  it('replaces the renamed entry in place, preserving list order', async () => {
    const initial = [summary({ id: 'd1', name: 'Old' }), summary({ id: 'd2' })];
    renameDashboardMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 'd1', name: 'Renamed', description: null, isDefault: false, globalTimeRange: '7d', layout: [], widgets: [], createdAt: '2026-01-01', updatedAt: '2026-02-01' },
    });

    const appId = uniqueAppId();
    const { result } = renderHook(() => useDashboards({ appId, initialDashboards: initial }));

    await act(async () => {
      await result.current.renameDashboard('d1', 'Renamed');
    });

    await waitFor(() => {
      expect(result.current.dashboards.map((d) => d.name)).toEqual(['Renamed', 'Overview']);
    });
  });

  // The cross-entity case: setDefault clears every OTHER row's isDefault
  // server-side. If the local cache only flipped the target row, the list
  // would render two "Default" badges until the next full page load.
  it('clears every other dashboard default when setDefault targets one row', async () => {
    const initial = [
      summary({ id: 'd1', isDefault: true }),
      summary({ id: 'd2', isDefault: false }),
      summary({ id: 'd3', isDefault: false }),
    ];
    setDefaultDashboardMock.mockResolvedValueOnce({ ok: true, data: undefined });

    const appId = uniqueAppId();
    const { result } = renderHook(() => useDashboards({ appId, initialDashboards: initial }));

    await act(async () => {
      await result.current.setDefault('d2');
    });

    await waitFor(() => {
      expect(result.current.dashboards).toEqual([
        summary({ id: 'd1', isDefault: false }),
        summary({ id: 'd2', isDefault: true }),
        summary({ id: 'd3', isDefault: false }),
      ]);
    });
  });

  it('throws the action error message and leaves the cache unchanged on failure', async () => {
    const initial = [summary({ id: 'd1' })];
    createDashboardMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'validation_error', message: 'Dashboard name already exists' },
    });

    const appId = uniqueAppId();
    const { result } = renderHook(() => useDashboards({ appId, initialDashboards: initial }));

    await expect(
      act(async () => {
        await result.current.createDashboard({ name: 'Dup' });
      }),
    ).rejects.toThrow('Dashboard name already exists');

    expect(result.current.dashboards).toEqual(initial);
  });
});
