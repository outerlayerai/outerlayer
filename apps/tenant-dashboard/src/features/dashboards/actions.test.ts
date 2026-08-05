/**
 * Every `authorizedAction` export in `./actions.ts` — the glue around
 * `dashboardsService`: input validation, permission narrowing to `appId`,
 * one service call under the resolved context, and (for the dashboard-level
 * mutations) a revalidate. The context/permission seams and the service
 * itself are mocked; `service.test.ts` covers the service's own DB
 * mechanics.
 */

vi.mock('server-only', () => ({}));

const { loadCtxMock, checkPermMock, revalidateMock, hasCustomMetricsMock } = vi.hoisted(() => ({
  loadCtxMock: vi.fn(),
  checkPermMock: vi.fn(),
  revalidateMock: vi.fn(),
  hasCustomMetricsMock: vi.fn(),
}));
vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: loadCtxMock,
  checkRequestPermission: checkPermMock,
  hasCustomMetricsEntitlement: hasCustomMetricsMock,
}));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock }));

const serviceMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  duplicate: vi.fn(),
  setDefault: vi.fn(),
  saveLayout: vi.fn(),
  addWidget: vi.fn(),
  updateWidget: vi.fn(),
  deleteWidget: vi.fn(),
}));
vi.mock('./service', () => ({ dashboardsService: serviceMock }));

import {
  createDashboard,
  renameDashboard,
  deleteDashboard,
  duplicateDashboard,
  setDefaultDashboard,
  saveDashboardLayout,
  addWidget,
  updateWidget,
  deleteWidget,
} from './actions';
import type { Dashboard, Widget } from './types';

const APP_ID = '550e8400-e29b-41d4-a716-446655440000';
const DASHBOARD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const WIDGET_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DASHBOARDS_LIST_PATH = '/orgs/[orgName]/apps/[appName]/env/[envName]/dashboards';

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: DASHBOARD_ID,
    name: 'Overview',
    description: null,
    isDefault: false,
    globalTimeRange: '7d',
    layout: [],
    widgets: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: null,
    ...overrides,
  };
}

function widget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: WIDGET_ID,
    dashboardId: DASHBOARD_ID,
    title: 'Requests',
    metric: 'request_count',
    visualization: 'line',
    filters: [],
    groupBy: null,
    timeGranularity: 'auto',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadCtxMock.mockResolvedValue({
    db: {},
    tenantId: 'tenant-1',
    actor: { userId: 'user-1', role: 'owner' },
  });
  checkPermMock.mockResolvedValue(true);
  hasCustomMetricsMock.mockResolvedValue(true);
});

describe('createDashboard', () => {
  it('authorizes on dashboard.insert, creates, and revalidates the list', async () => {
    serviceMock.create.mockResolvedValue(dashboard({ name: 'New' }));

    const res = await createDashboard({ appId: APP_ID, name: 'New' });

    expect(res).toEqual({ ok: true, data: dashboard({ name: 'New' }) });
    expect(checkPermMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'dashboard.insert', APP_ID);
    expect(serviceMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      { appId: APP_ID, name: 'New', description: undefined, isDefault: undefined, templateId: undefined },
    );
    expect(revalidateMock).toHaveBeenCalledWith(DASHBOARDS_LIST_PATH, 'page');
  });

  it('fails validation without calling the service when name is missing', async () => {
    const res = await createDashboard({ appId: APP_ID });

    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error' } });
    expect(serviceMock.create).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('denies an actor lacking dashboard.insert without calling the service', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await createDashboard({ appId: APP_ID, name: 'New' });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(serviceMock.create).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe('renameDashboard', () => {
  it('authorizes on dashboard.update, renames, and revalidates', async () => {
    serviceMock.update.mockResolvedValue(dashboard({ name: 'Renamed' }));

    const res = await renameDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID, name: 'Renamed' });

    expect(res).toEqual({ ok: true, data: dashboard({ name: 'Renamed' }) });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), 'dashboard.update', APP_ID);
    expect(serviceMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      { appId: APP_ID, dashboardId: DASHBOARD_ID, name: 'Renamed' },
    );
    expect(revalidateMock).toHaveBeenCalledWith(DASHBOARDS_LIST_PATH, 'page');
  });

  it('denies an actor lacking dashboard.update', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await renameDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID, name: 'Renamed' });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(serviceMock.update).not.toHaveBeenCalled();
  });
});

describe('deleteDashboard', () => {
  it('authorizes on dashboard.delete, deletes, and revalidates', async () => {
    serviceMock.delete.mockResolvedValue(undefined);

    const res = await deleteDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), 'dashboard.delete', APP_ID);
    expect(serviceMock.delete).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), {
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
    });
    expect(revalidateMock).toHaveBeenCalledWith(DASHBOARDS_LIST_PATH, 'page');
  });

  it('denies an actor lacking dashboard.delete', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await deleteDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(serviceMock.delete).not.toHaveBeenCalled();
  });
});

describe('duplicateDashboard', () => {
  it('authorizes on dashboard.insert, duplicates, and revalidates', async () => {
    serviceMock.duplicate.mockResolvedValue(dashboard({ id: 'new-dup-id', name: 'Overview (Copy)' }));

    const res = await duplicateDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID });

    expect(res).toEqual({ ok: true, data: dashboard({ id: 'new-dup-id', name: 'Overview (Copy)' }) });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), 'dashboard.insert', APP_ID);
    expect(revalidateMock).toHaveBeenCalledWith(DASHBOARDS_LIST_PATH, 'page');
  });
});

describe('setDefaultDashboard', () => {
  it('authorizes on dashboard.update, sets default, and revalidates', async () => {
    serviceMock.setDefault.mockResolvedValue(undefined);

    const res = await setDefaultDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(serviceMock.setDefault).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), {
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
    });
    expect(revalidateMock).toHaveBeenCalledWith(DASHBOARDS_LIST_PATH, 'page');
  });

  it('denies an actor lacking dashboard.update', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await setDefaultDashboard({ appId: APP_ID, dashboardId: DASHBOARD_ID });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(serviceMock.setDefault).not.toHaveBeenCalled();
  });
});

describe('saveDashboardLayout', () => {
  it('authorizes on dashboard.update, saves the layout, and never revalidates', async () => {
    const layout = [{ widgetId: WIDGET_ID, x: 0, y: 0, w: 4, h: 2 }];
    serviceMock.saveLayout.mockResolvedValue(undefined);

    const res = await saveDashboardLayout({ appId: APP_ID, dashboardId: DASHBOARD_ID, layout });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(serviceMock.saveLayout).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), {
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
      layout,
    });
    // Fires on every debounced drag — revalidating the React Server Component (RSC) mid-drag would
    // fight the client's own optimistic layout state.
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});

describe('addWidget', () => {
  it('authorizes on dashboard.update, adds the widget, and never revalidates', async () => {
    serviceMock.addWidget.mockResolvedValue(widget());

    const res = await addWidget({
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
      title: 'Requests',
      metric: 'request_count',
      visualization: 'line',
      groupBy: null,
      timeGranularity: 'auto',
    });

    expect(res).toEqual({ ok: true, data: widget() });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), 'dashboard.update', APP_ID);
    expect(hasCustomMetricsMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('gates a derived-metric widget behind the custom-metrics entitlement, denying an ungated tenant', async () => {
    hasCustomMetricsMock.mockResolvedValue(false);

    const res = await addWidget({
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
      title: 'Merge rate',
      metric: 'requests_per_user',
      visualization: 'stat',
      groupBy: null,
      timeGranularity: 'auto',
    });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(hasCustomMetricsMock).toHaveBeenCalledWith('tenant-1');
    expect(serviceMock.addWidget).not.toHaveBeenCalled();
  });

  it('allows a derived-metric widget once the tenant holds the custom-metrics entitlement', async () => {
    hasCustomMetricsMock.mockResolvedValue(true);
    serviceMock.addWidget.mockResolvedValue(widget({ metric: 'requests_per_user' }));

    const res = await addWidget({
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
      title: 'Merge rate',
      metric: 'requests_per_user',
      visualization: 'stat',
      groupBy: null,
      timeGranularity: 'auto',
    });

    expect(res).toMatchObject({ ok: true });
    expect(serviceMock.addWidget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: APP_ID, dashboardId: DASHBOARD_ID, metric: 'requests_per_user' }),
    );
  });
});

describe('updateWidget', () => {
  it('authorizes on dashboard.update, updates the widget, and never revalidates', async () => {
    serviceMock.updateWidget.mockResolvedValue(widget({ title: 'Renamed widget' }));

    const res = await updateWidget({
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
      widgetId: WIDGET_ID,
      title: 'Renamed widget',
    });

    expect(res).toEqual({ ok: true, data: widget({ title: 'Renamed widget' }) });
    expect(checkPermMock).toHaveBeenCalledWith(expect.anything(), 'dashboard.update', APP_ID);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('denies an actor lacking dashboard.update', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await updateWidget({ appId: APP_ID, dashboardId: DASHBOARD_ID, widgetId: WIDGET_ID, title: 'X' });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(serviceMock.updateWidget).not.toHaveBeenCalled();
  });
});

describe('deleteWidget', () => {
  it('authorizes on dashboard.update, deletes the widget, and never revalidates', async () => {
    serviceMock.deleteWidget.mockResolvedValue(undefined);

    const res = await deleteWidget({ appId: APP_ID, dashboardId: DASHBOARD_ID, widgetId: WIDGET_ID });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(serviceMock.deleteWidget).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), {
      appId: APP_ID,
      dashboardId: DASHBOARD_ID,
      widgetId: WIDGET_ID,
    });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('denies an actor lacking dashboard.update', async () => {
    checkPermMock.mockResolvedValue(false);

    const res = await deleteWidget({ appId: APP_ID, dashboardId: DASHBOARD_ID, widgetId: WIDGET_ID });

    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(serviceMock.deleteWidget).not.toHaveBeenCalled();
  });
});
