/**
 * A failed dashboard detail read reaches the view as a failure, not as absence.
 *
 * The page renders a null dashboard as "it may have been deleted", so null has
 * to mean absence and nothing else. That guarantee spans three layers — the
 * service classifies the Postgres error, the React Server Component (RSC) read converts only a genuine
 * not-found into null, and the page flags anything else — and it holds only if
 * all three agree. So the mock seam here is the SERVICE, with the real
 * `read.ts` in the path: mocking the read helper instead would let it "reject"
 * in a way the real module could not, and the test would keep passing over a
 * read layer that swallows everything.
 *
 * The no-oracle posture is part of the contract: an unknown id and a
 * foreign-tenant id both surface as NotFoundError, and both must still collapse
 * to the same not-found outcome.
 */
import type React from 'react';

vi.mock('server-only', () => ({}));

vi.mock('@/utils/get-app-id', () => ({
  getAppIdByName: () => Promise.resolve('app-1'),
}));

const loadCtx = vi.fn();
vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: () => loadCtx(),
  checkRequestPermission: () => Promise.resolve(true),
}));

const get = vi.fn();
const list = vi.fn();
vi.mock('@/features/dashboards/service', () => ({
  dashboardsService: {
    get: (...args: unknown[]) => get(...args),
    list: (...args: unknown[]) => list(...args),
  },
}));

import DashboardPage from '../page';
import { NotFoundError } from '@/lib/analytics/errors';

const PARAMS = () => Promise.resolve({ appName: 'app-one', dashboardId: 'd1' });

interface ViewProps {
  loadError?: string | null;
  initialDashboard?: unknown;
}

async function viewProps(): Promise<ViewProps> {
  const tree = (await DashboardPage({ params: PARAMS() })) as React.ReactElement;
  return tree.props as ViewProps;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCtx.mockResolvedValue({ db: {}, tenantId: 't-1', actor: { userId: 'u-1' } });
  list.mockResolvedValue([]);
});

it('flags a detail read that failed for any reason other than absence', async () => {
  // The widget query timing out while the dashboard row itself reads fine —
  // the service throws a plain Error, and null must not be what comes out.
  get.mockRejectedValue(new Error('Failed to fetch widgets: connection timed out'));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const props = await viewProps();

  expect(props.initialDashboard).toBeNull();
  expect(props.loadError).toBe("Couldn't load this dashboard.");
  expect(errSpy).toHaveBeenCalledWith('[dashboards] detail read failed:', expect.any(Error));
  errSpy.mockRestore();
});

it('reports no failure when the dashboard is genuinely absent, so not-found stays not-found', async () => {
  get.mockRejectedValue(new NotFoundError('Dashboard not found', 'dashboard', 'd1'));

  const props = await viewProps();

  expect(props.initialDashboard).toBeNull();
  expect(props.loadError).toBeNull();
});

it('collapses a foreign-tenant dashboard into the same not-found outcome, with no failure flag', async () => {
  // RLS hides the row, so the service cannot tell "not yours" from "not there"
  // and neither may this page — a distinguishable outcome here would be an
  // existence oracle across tenants.
  get.mockRejectedValue(new NotFoundError('Dashboard not found', 'dashboard', 'someone-elses'));

  const props = await viewProps();

  expect(props.initialDashboard).toBeNull();
  expect(props.loadError).toBeNull();
});

it('flags a failure of the sibling list read too', async () => {
  get.mockResolvedValue({ id: 'd1', name: 'Overview', widgets: [], layout: [] });
  list.mockRejectedValue(new Error('Failed to list dashboards: connection reset'));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const props = await viewProps();

  expect(props.loadError).toBe("Couldn't load this dashboard.");
  errSpy.mockRestore();
});

it('passes the dashboard through with no failure flag when both reads succeed', async () => {
  const dashboard = { id: 'd1', name: 'Overview', widgets: [], layout: [] };
  get.mockResolvedValue(dashboard);

  const props = await viewProps();

  expect(props.initialDashboard).toEqual(dashboard);
  expect(props.loadError).toBeNull();
});

it('never leaks the underlying database error text into the rendered props', async () => {
  get.mockRejectedValue(
    new Error('Failed to fetch dashboard: relation "dashboard_widget" does not exist'),
  );
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  const props = await viewProps();

  expect(JSON.stringify(props)).not.toContain('dashboard_widget');
  expect(JSON.stringify(props)).not.toContain('relation');
  errSpy.mockRestore();
});
