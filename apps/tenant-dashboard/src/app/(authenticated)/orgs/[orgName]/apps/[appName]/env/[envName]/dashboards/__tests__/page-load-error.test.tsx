/**
 * A failed list read reaches the list as a failure, not as absence.
 *
 * An empty list drives a cold-start gallery whose whole message is "you have
 * no dashboards yet" — a claim only a successful read is entitled to make. So
 * empty has to mean empty and nothing else, and the flag that separates the
 * two has to survive the trip through the React Server Component (RSC)'s props.
 *
 * The mock seam is the SERVICE, with the real `read.ts` in the path: mocking
 * the read helper instead would let it "reject" in a way the real module could
 * not, and the test would keep passing over a read layer that swallows
 * everything.
 */
import type React from 'react';

vi.mock('server-only', () => ({}));

vi.mock('@/utils/get-app-id', () => ({
  getAppIdByName: () => Promise.resolve('app-1'),
}));

vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: () =>
    Promise.resolve({ db: {}, tenantId: 't-1', actor: { userId: 'u-1' } }),
  checkRequestPermission: () => Promise.resolve(true),
}));

const list = vi.fn();
vi.mock('@/features/dashboards/service', () => ({
  dashboardsService: {
    list: (...args: unknown[]) => list(...args),
  },
}));

import DashboardsPage from '../page';

const PARAMS = () => Promise.resolve({ appName: 'app-one' });

interface ListProps {
  loadError?: string | null;
  initialDashboards?: unknown[];
  initialTemplates?: unknown[];
}

async function listProps(): Promise<ListProps> {
  const tree = (await DashboardsPage({ params: PARAMS() })) as React.ReactElement;
  return tree.props as ListProps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it('flags a failed list read instead of handing down an empty list', async () => {
  list.mockRejectedValue(new Error('Failed to list dashboards: connection reset'));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const props = await listProps();

  expect(props.loadError).toBe(
    "The dashboard list couldn't be read just now. Nothing was lost — try again.",
  );
  expect(props.initialDashboards).toEqual([]);
  expect(errSpy).toHaveBeenCalledWith('[dashboards] list read failed:', expect.any(Error));
  errSpy.mockRestore();
});

it('reports no failure when the app genuinely has no dashboards', async () => {
  list.mockResolvedValue([]);

  const props = await listProps();

  expect(props.loadError).toBeNull();
  expect(props.initialDashboards).toEqual([]);
});

it('passes the dashboards through with no failure flag when the read succeeds', async () => {
  const dashboards = [{ id: 'd1', name: 'Overview', widgetCount: 2, isDefault: false }];
  list.mockResolvedValue(dashboards);

  const props = await listProps();

  expect(props.initialDashboards).toEqual(dashboards);
  expect(props.loadError).toBeNull();
});

it('never leaks the underlying database error text into the rendered props', async () => {
  list.mockRejectedValue(
    new Error('Failed to list dashboards: relation "dashboard" does not exist'),
  );
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const props = await listProps();

  const serialized = JSON.stringify({
    loadError: props.loadError,
    initialDashboards: props.initialDashboards,
  });
  expect(serialized).not.toContain('relation');
  expect(serialized).not.toContain('does not exist');
  errSpy.mockRestore();
});
