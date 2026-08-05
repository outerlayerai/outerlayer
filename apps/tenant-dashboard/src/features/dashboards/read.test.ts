/**
 * The React Server Component (RSC) read helpers resolve the per-request ServiceContext and delegate to
 * the one dashboardsService call each page needs — the seam the dashboards
 * list/detail/default pages call to seed their props.
 */

vi.mock('server-only', () => ({}));

const { loadCtxMock, listMock, getMock, getOrCreateDefaultMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  listMock: vi.fn(),
  getMock: vi.fn(),
  getOrCreateDefaultMock: vi.fn(),
}));

vi.mock('@/lib/adapters', () => ({ loadRequestServiceContext: loadCtxMock }));
vi.mock('./service', () => ({
  dashboardsService: {
    list: listMock,
    get: getMock,
    getOrCreateDefault: getOrCreateDefaultMock,
  },
}));

import { loadDashboardsForApp, loadDashboardForApp, loadDefaultDashboardForApp, loadTemplates } from './read';
import { NotFoundError } from '@/lib/analytics/errors';
import { DEFAULT_TEMPLATE_ID } from './templates';

const CTX = { db: {}, tenantId: 'tenant-1', actor: { userId: 'user-1', role: 'owner' } };
const APP_ID = 'app-1';

beforeEach(() => {
  vi.clearAllMocks();
  loadCtxMock.mockResolvedValue(CTX);
});

it('resolves the request context and lists the app dashboards', async () => {
  const summaries = [{ id: 'd-1', name: 'Overview' }];
  listMock.mockResolvedValue(summaries);

  const result = await loadDashboardsForApp(APP_ID);

  expect(loadCtxMock).toHaveBeenCalledTimes(1);
  expect(listMock).toHaveBeenCalledWith(CTX, APP_ID);
  expect(result).toEqual(summaries);
});

it('returns the dashboard when the service resolves one', async () => {
  const dashboard = { id: 'd-1', name: 'Overview', widgets: [] };
  getMock.mockResolvedValue(dashboard);

  const result = await loadDashboardForApp(APP_ID, 'd-1');

  expect(getMock).toHaveBeenCalledWith(CTX, APP_ID, 'd-1');
  expect(result).toEqual(dashboard);
});

it('degrades to null when the dashboard is not found (unknown id or foreign tenant)', async () => {
  getMock.mockRejectedValue(new NotFoundError('Dashboard not found', 'dashboard', 'missing'));

  const result = await loadDashboardForApp(APP_ID, 'missing');

  expect(result).toBeNull();
});

it('propagates a failure that is not an absence, rather than reporting it as null', async () => {
  // Null is what the page renders as "this dashboard was deleted". Returning
  // it for a timed-out widget query would state a deletion that never
  // happened, so only NotFoundError may produce it.
  getMock.mockRejectedValue(new Error('Failed to fetch widgets: connection timed out'));

  await expect(loadDashboardForApp(APP_ID, 'd-1')).rejects.toThrow(
    'Failed to fetch widgets: connection timed out',
  );
});

it('resolves the app default dashboard', async () => {
  const dashboard = { id: 'd-default', name: 'Overview', isDefault: true };
  getOrCreateDefaultMock.mockResolvedValue(dashboard);

  const result = await loadDefaultDashboardForApp(APP_ID);

  expect(getOrCreateDefaultMock).toHaveBeenCalledWith(CTX, APP_ID);
  expect(result).toEqual(dashboard);
});

it('returns the static template catalog without a request context', async () => {
  const templates = await loadTemplates();

  expect(loadCtxMock).not.toHaveBeenCalled();
  expect(templates.some((t) => t.id === DEFAULT_TEMPLATE_ID)).toBe(true);
});
