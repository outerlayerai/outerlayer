// @vitest-environment jsdom
/**
 * Tests: useDashboard
 *
 * The detail view is seeded by a React Server Component (RSC), with no GET
 * route behind it — these
 * tests exercise the real SWR cache so the provider's optimistic
 * `mutate(next, { revalidate: false })` calls (add/remove/update widget)
 * behave exactly as they do at runtime.
 */

vi.mock('server-only', () => ({}));

import { renderHook, act } from '@testing-library/react';
import { useDashboard } from '../use-dashboard';
import type { Dashboard, Widget } from '../../types';

// A fresh dashboardId per test keeps each hook mount on its own SWR cache
// entry — `fallbackData` only seeds a key the first time it's seen.
let idCounter = 0;
function uniqueId(): string {
  idCounter += 1;
  return `d-${idCounter}`;
}

function makeDashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'd1',
    name: 'Overview',
    description: null,
    isDefault: true,
    globalTimeRange: '7d',
    layout: [],
    widgets: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
    ...over,
  };
}

const widget = (over: Partial<Widget> = {}): Widget => ({
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
  ...over,
});

describe('useDashboard', () => {
  it('presents the seeded dashboard with no fetch behavior', () => {
    const dashboardId = uniqueId();
    const initial = makeDashboard({ id: dashboardId });
    const { result } = renderHook(() => useDashboard({ appId: 'app-1', dashboardId, initialDashboard: initial }));

    expect(result.current.dashboard).toEqual(initial);
    // The hook exposes no error channel — it cannot fetch, so it cannot fail.
    // A load failure is the page's to report, not this cache's.
    expect(Object.keys(result.current).sort()).toEqual(['dashboard', 'mutate']);
  });

  it('presents null when the RSC read resolved no dashboard (not-found / foreign tenant)', () => {
    const dashboardId = uniqueId();
    const { result } = renderHook(() => useDashboard({ appId: 'app-1', dashboardId, initialDashboard: null }));

    expect(result.current.dashboard).toBeNull();
  });

  // Plain-value mutate, not a functional updater: the installed SWR version
  // doesn't apply a functional updater against a fetcher-less key, so every
  // caller (the provider's addWidget/removeWidget/updateWidget) computes the
  // next value itself from the dashboard it already holds.
  it('appends a widget added via mutate, without touching existing widgets', async () => {
    const dashboardId = uniqueId();
    const initial = makeDashboard({ id: dashboardId, widgets: [widget({ id: 'w1' })] });
    const { result } = renderHook(() => useDashboard({ appId: 'app-1', dashboardId, initialDashboard: initial }));

    await act(async () => {
      await result.current.mutate(
        { ...initial, widgets: [...initial.widgets, widget({ id: 'w2', title: 'Errors' })] },
        { revalidate: false },
      );
    });

    expect(result.current.dashboard?.widgets.map((w) => w.id)).toEqual(['w1', 'w2']);
  });

  it('removes a widget and its layout entry together via mutate', async () => {
    const dashboardId = uniqueId();
    const initial = makeDashboard({
      id: dashboardId,
      widgets: [widget({ id: 'w1' }), widget({ id: 'w2' })],
      layout: [
        { widgetId: 'w1', x: 0, y: 0, w: 6, h: 4 },
        { widgetId: 'w2', x: 6, y: 0, w: 6, h: 4 },
      ],
    });
    const { result } = renderHook(() => useDashboard({ appId: 'app-1', dashboardId, initialDashboard: initial }));

    await act(async () => {
      await result.current.mutate(
        {
          ...initial,
          widgets: initial.widgets.filter((w) => w.id !== 'w1'),
          layout: initial.layout.filter((l) => l.widgetId !== 'w1'),
        },
        { revalidate: false },
      );
    });

    expect(result.current.dashboard?.widgets.map((w) => w.id)).toEqual(['w2']);
    expect(result.current.dashboard?.layout.map((l) => l.widgetId)).toEqual(['w2']);
  });
});
