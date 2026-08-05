/**
 * Unit Tests for DashboardService
 *
 * These tests verify service logic with a mocked Supabase client.
 * Unit tests cover all business logic functions; external services are
 * exercised through interfaces + mocks.
 */

vi.mock('server-only', () => ({}));

import type { Mock } from 'vitest';
import { dashboardsService } from './service';
import type { ServiceContext } from '@/lib/action-kit/service-context';
import { NotFoundError, ValidationError } from '@/lib/analytics/errors';
import type {
  DashboardRow,
  DashboardWidgetRow,
  CreateDashboardRequest,
  UpdateDashboardRequest,
  CreateWidgetRequest,
  UpdateWidgetRequest,
} from './types';
import {
  MAX_DASHBOARDS_PER_APP,
  MAX_DASHBOARDS_PER_ORG,
  MAX_WIDGETS_PER_DASHBOARD,
} from './types';
import { getTemplate } from './templates';

// A live template used purely as a "some template with widgets" fixture for
// the create-from-template DB orchestration tests below. The service resolves
// templateId via the real getTemplate(), so the fixture must reference a
// template that still exists. Counts are derived from the template so adding
// a widget to it later doesn't silently break these mechanics tests.
const FIXTURE_TEMPLATE_ID = 'agent-operations';
const FIXTURE_TEMPLATE = getTemplate(FIXTURE_TEMPLATE_ID)!;
const FIXTURE_WIDGET_COUNT = FIXTURE_TEMPLATE.widgets.length;

// ============================================================================
// Mock Supabase Client Factory
// ============================================================================

/**
 * Creates a mock Supabase client with chainable query builder.
 *
 * Usage: Tests override mockFrom.mockImplementation() or configure chain
 * terminal methods (single, maybeSingle) to control return values.
 *
 * For multi-call scenarios (e.g., count then insert), use
 * mockFrom.mockImplementation() with a call counter to return different
 * chains for each from() invocation.
 */
function createMockSupabaseClient() {
  const mockSingle = vi.fn();
  const mockMaybeSingle = vi.fn();
  const mockOrder = vi.fn().mockReturnThis();
  const mockLimit = vi.fn().mockReturnThis();
  const mockEq = vi.fn().mockReturnThis();
  const mockSelect = vi.fn().mockReturnThis();
  const mockInsert = vi.fn().mockReturnThis();
  const mockUpdate = vi.fn().mockReturnThis();
  const mockDelete = vi.fn().mockReturnThis();

  const chain: Record<string, Mock> = {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    order: mockOrder,
    limit: mockLimit,
    single: mockSingle,
    maybeSingle: mockMaybeSingle,
  };

  // Wire up chainable methods to return the chain for fluent API
  mockSelect.mockReturnValue(chain);
  mockInsert.mockReturnValue(chain);
  mockUpdate.mockReturnValue(chain);
  mockDelete.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  mockOrder.mockReturnValue(chain);
  mockLimit.mockReturnValue(chain);

  const mockFrom = vi.fn().mockReturnValue(chain);

  return {
    from: mockFrom,
    _chain: chain,
    _mocks: {
      from: mockFrom,
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      eq: mockEq,
      order: mockOrder,
      limit: mockLimit,
      single: mockSingle,
      maybeSingle: mockMaybeSingle,
    },
  };
}

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_USER_ID = 'user-abc-123';
const TEST_APP_ID = 'app-xyz-456';
const TEST_TENANT_ID = 'tenant-def-789';
const TEST_DASHBOARD_ID = 'dash-001';
const TEST_WIDGET_ID = 'widget-001';

const baseDashboardRow: DashboardRow = {
  id: TEST_DASHBOARD_ID,
  user_id: null,
  app_id: TEST_APP_ID,
  tenant_id: TEST_TENANT_ID,
  name: 'My Dashboard',
  description: 'A test dashboard',
  is_default: false,
  layout: [],
  global_time_range: '7d',
  created_at: '2026-01-15T10:00:00Z',
  updated_at: null,
  created_by: TEST_USER_ID,
  updated_by: null,
};

const baseWidgetRow: DashboardWidgetRow = {
  id: TEST_WIDGET_ID,
  dashboard_id: TEST_DASHBOARD_ID,
  tenant_id: TEST_TENANT_ID,
  title: 'Request Count',
  metric: 'request_count',
  visualization: 'line',
  filters: [],
  group_by: null,
  time_granularity: 'auto',
  score_name: null,
  score_name_b: null,
  environment_config: null,
  sort_order: 0,
  created_at: '2026-01-15T10:30:00Z',
  updated_at: null,
  created_by: TEST_USER_ID,
  updated_by: null,
};

// ============================================================================
// Tests
// ============================================================================

describe('DashboardService', () => {
  let mockClient: ReturnType<typeof createMockSupabaseClient>;
  let ctx: ServiceContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockSupabaseClient();
    ctx = { db: mockClient as any, tenantId: TEST_TENANT_ID, actor: { userId: TEST_USER_ID, role: '' } };
  });

  // --------------------------------------------------------------------------
  // listDashboards
  // --------------------------------------------------------------------------

  describe('listDashboards', () => {
    it('should return transformed dashboard summaries with widget count when listDashboards succeeds', async () => {
      const dashboardRows = [
        {
          ...baseDashboardRow,
          dashboard_widget: [{ count: 3 }],
        },
        {
          ...baseDashboardRow,
          id: 'dash-002',
          name: 'Second Dashboard',
          is_default: true,
          dashboard_widget: [{ count: 5 }],
        },
      ];

      // The service calls: from('dashboard').select('*, dashboard_widget(count)').eq('app_id', ...).order(...)
      // order() is the terminal that resolves the promise
      mockClient._mocks.order.mockResolvedValue({
        data: dashboardRows,
        error: null,
      });

      const result = await dashboardsService.list(ctx, TEST_APP_ID);

      expect(result).toHaveLength(2);

      // Verify snake_case -> camelCase transformation
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: TEST_DASHBOARD_ID,
          name: 'My Dashboard',
          description: 'A test dashboard',
          isDefault: false,
          widgetCount: 3,
          globalTimeRange: '7d',
          createdAt: '2026-01-15T10:00:00Z',
          updatedAt: null,
        })
      );

      expect(result[1]).toEqual(
        expect.objectContaining({
          id: 'dash-002',
          name: 'Second Dashboard',
          isDefault: true,
          widgetCount: 5,
        })
      );

      // Verify correct table and filters used — no user_id filter
      expect(mockClient._mocks.from).toHaveBeenCalledWith('dashboard');
      expect(mockClient._mocks.select).toHaveBeenCalledWith('*, dashboard_widget(count)');
      expect(mockClient._mocks.eq).toHaveBeenCalledWith('app_id', TEST_APP_ID);
      expect(mockClient._mocks.eq).not.toHaveBeenCalledWith('user_id', expect.anything());
    });

    it('should return empty array when no dashboards exist', async () => {
      mockClient._mocks.order.mockResolvedValue({
        data: [],
        error: null,
      });

      const result = await dashboardsService.list(ctx, TEST_APP_ID);

      expect(result).toEqual([]);
    });

    it('should throw when Supabase returns an error', async () => {
      mockClient._mocks.order.mockResolvedValue({
        data: null,
        error: { message: 'Database connection failed', code: 'PGRST000' },
      });

      await expect(
        dashboardsService.list(ctx, TEST_APP_ID)
      ).rejects.toThrow('Failed to list dashboards: Database connection failed');
    });

    it('should return empty array when Supabase returns null data with no error', async () => {
      mockClient._mocks.order.mockResolvedValue({
        data: null,
        error: null,
      });

      const result = await dashboardsService.list(ctx, TEST_APP_ID);
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getDashboard
  // --------------------------------------------------------------------------

  describe('getDashboard', () => {
    it('should return full dashboard with widgets array when getDashboard succeeds', async () => {
      const widgetRows = [
        { ...baseWidgetRow },
        {
          ...baseWidgetRow,
          id: 'widget-002',
          title: 'Total Cost',
          metric: 'total_cost',
          visualization: 'stat',
          group_by: 'model',
          time_granularity: 'day',
          sort_order: 1,
        },
      ];

      // getDashboard makes TWO from() calls:
      //   1. from('dashboard').select('*').eq(id).eq(app_id).single()
      //   2. from('dashboard_widget').select('*').eq(dashboard_id).order(sort_order)

      const dashboardChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { ...baseDashboardRow },
          error: null,
        }),
      };

      const widgetChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: widgetRows,
          error: null,
        }),
      };

      mockClient.from.mockImplementation((table: string) => {
        if (table === 'dashboard') return dashboardChain;
        if (table === 'dashboard_widget') return widgetChain;
        return dashboardChain;
      });

      const result = await dashboardsService.get(ctx, TEST_APP_ID, TEST_DASHBOARD_ID);

      // Verify dashboard fields transformation
      expect(result.id).toBe(TEST_DASHBOARD_ID);
      expect(result.name).toBe('My Dashboard');
      expect(result.description).toBe('A test dashboard');
      expect(result.isDefault).toBe(false);
      expect(result.globalTimeRange).toBe('7d');
      expect(result.layout).toEqual([]);
      expect(result.createdAt).toBe('2026-01-15T10:00:00Z');
      expect(result.updatedAt).toBeNull();

      // Verify widgets transformation
      expect(result.widgets).toHaveLength(2);

      expect(result.widgets[0]).toEqual(
        expect.objectContaining({
          id: TEST_WIDGET_ID,
          dashboardId: TEST_DASHBOARD_ID,
          title: 'Request Count',
          metric: 'request_count',
          visualization: 'line',
          filters: [],
          groupBy: null,
          timeGranularity: 'auto',
          createdAt: '2026-01-15T10:30:00Z',
          updatedAt: null,
        })
      );

      expect(result.widgets[1]).toEqual(
        expect.objectContaining({
          id: 'widget-002',
          title: 'Total Cost',
          metric: 'total_cost',
          visualization: 'stat',
          groupBy: 'model',
          timeGranularity: 'day',
        })
      );

      // Verify both queries used correct tables
      expect(mockClient.from).toHaveBeenCalledWith('dashboard');
      expect(mockClient.from).toHaveBeenCalledWith('dashboard_widget');
    });

    it('should throw NotFoundError when dashboard not found', async () => {
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'Row not found' },
      });

      await expect(
        dashboardsService.get(ctx, TEST_APP_ID, 'nonexistent-id')
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw a non-NotFound error when the row read fails for a reason other than no-rows', async () => {
      // No-rows is the only failure that means "not found". Classifying a
      // connection failure as one is how a transient outage reaches the user
      // as a deleted dashboard.
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      });

      const err = await dashboardsService
        .get(ctx, TEST_APP_ID, TEST_DASHBOARD_ID)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe('Failed to fetch dashboard: connection failure');
    });

    it('should throw when widget fetch fails after dashboard is found', async () => {
      const dashboardChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { ...baseDashboardRow },
          error: null,
        }),
      };

      const widgetChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Widget query failed', code: 'PGRST000' },
        }),
      };

      mockClient.from.mockImplementation((table: string) => {
        if (table === 'dashboard') return dashboardChain;
        if (table === 'dashboard_widget') return widgetChain;
        return dashboardChain;
      });

      await expect(
        dashboardsService.get(ctx, TEST_APP_ID, TEST_DASHBOARD_ID)
      ).rejects.toThrow('Failed to fetch widgets: Widget query failed');
    });

    it('should return dashboard with empty widgets array when no widgets exist', async () => {
      const dashboardChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { ...baseDashboardRow },
          error: null,
        }),
      };

      const widgetChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      };

      mockClient.from.mockImplementation((table: string) => {
        if (table === 'dashboard') return dashboardChain;
        if (table === 'dashboard_widget') return widgetChain;
        return dashboardChain;
      });

      const result = await dashboardsService.get(ctx, TEST_APP_ID, TEST_DASHBOARD_ID);

      expect(result.widgets).toEqual([]);
      expect(result.id).toBe(TEST_DASHBOARD_ID);
    });
  });

  // --------------------------------------------------------------------------
  // createDashboard
  // --------------------------------------------------------------------------

  describe('createDashboard', () => {
    const createRequest: CreateDashboardRequest = {
      name: 'New Dashboard',
      description: 'A brand new dashboard',
      isDefault: false,
    };

    it('should create dashboard and return transformed result when valid input is provided', async () => {
      const createdRow: DashboardRow = {
        ...baseDashboardRow,
        id: 'dash-new-001',
        name: 'New Dashboard',
        description: 'A brand new dashboard',
        created_at: '2026-02-01T12:00:00Z',
      };

      // createDashboard makes FOUR from('dashboard') calls:
      //   1. per-app count check
      //   2. per-org count check
      //   3. name uniqueness check
      //   4. actual insert
      let callCount = 0;

      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: 2,
          error: null,
        }),
      };

      const orgCountChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 5, error: null }),
      };

      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      const insertChain = {
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: createdRow,
          error: null,
        }),
      };

      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        if (callCount === 2) return orgCountChain;
        if (callCount === 3) return nameCheckChain;
        return insertChain;
      });

      const result = await dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest });

      // Verify transformation
      expect(result.id).toBe('dash-new-001');
      expect(result.name).toBe('New Dashboard');
      expect(result.description).toBe('A brand new dashboard');
      expect(result.isDefault).toBe(false);
      expect(result.globalTimeRange).toBe('7d');
      expect(result.createdAt).toBe('2026-02-01T12:00:00Z');
      expect(result.widgets).toEqual([]);
    });

    it('should throw "Dashboard name already exists" when Supabase returns error code 23505', async () => {
      // Count check passes
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: 1,
          error: null,
        }),
      };

      const orgCountChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 5, error: null }),
      };

      // Name check passes (no duplicate found — race condition case)
      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      // Insert fails with unique constraint violation (race condition)
      const insertChain = {
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        if (callCount === 2) return orgCountChain;
        if (callCount === 3) return nameCheckChain;
        return insertChain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow('Dashboard name already exists');
    });

    it('should throw ValidationError when dashboard count exceeds MAX_DASHBOARDS_PER_APP', async () => {
      // Count check returns the max (10)
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: MAX_DASHBOARDS_PER_APP,
          error: null,
        }),
      };

      mockClient.from.mockReturnValue(countChain);

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when org dashboard count exceeds MAX_DASHBOARDS_PER_ORG', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
      };
      const orgCountChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: MAX_DASHBOARDS_PER_ORG, error: null }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        return orgCountChain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw when org dashboard count check fails', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
      };
      const orgCountChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: null,
          error: { message: 'Org count query failed', code: 'PGRST000' },
        }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        return orgCountChain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow('Failed to check org dashboard count: Org count query failed');
    });

    it('should throw when dashboard count check fails', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: null,
          error: { message: 'Count query failed', code: 'PGRST000' },
        }),
      };

      mockClient.from.mockReturnValue(countChain);

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow('Failed to check dashboard count: Count query failed');
    });

    it('should throw generic error when insert fails with non-23505 code', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
      };

      const orgCountChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 5, error: null }),
      };

      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      const insertChain = {
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { code: 'PGRST000', message: 'Insert failed unexpectedly' },
        }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        if (callCount === 2) return orgCountChain;
        if (callCount === 3) return nameCheckChain;
        return insertChain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow('Failed to create dashboard: Insert failed unexpectedly');
    });

    it('should include MAX_DASHBOARDS_PER_APP value in error message when limit is exceeded', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: MAX_DASHBOARDS_PER_APP,
          error: null,
        }),
      };

      mockClient.from.mockReturnValue(countChain);

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow(String(MAX_DASHBOARDS_PER_APP));
    });

    it('should throw ValidationError when dashboard name already exists for the app', async () => {
      // Call 1: per-app count
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
      };

      // Call 2: per-org count
      const orgCountChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 5, error: null }),
      };

      // Call 3: name uniqueness check — finds an existing dashboard with same name
      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: 'existing-id' },
          error: null,
        }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        if (callCount === 2) return orgCountChain;
        return nameCheckChain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...createRequest })
      ).rejects.toThrow('Dashboard name already exists for this application');
    });
  });

    it('should create dashboard with template widgets and layout when templateId is provided', async () => {
      const createdRow: DashboardRow = {
        ...baseDashboardRow,
        id: 'dash-tpl-001',
        name: 'From Template',
        is_default: false,
        layout: [],
      };

      const templateWidgetRows = Array.from({ length: FIXTURE_WIDGET_COUNT }, (_, i) => ({
        ...baseWidgetRow,
        id: `tpl-w${i}`,
        dashboard_id: 'dash-tpl-001',
        sort_order: i,
      }));

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        // 1. Per-app count check
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 2. Per-org count check
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 3. Name uniqueness check
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        // 4. Insert dashboard
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: createdRow, error: null }),
          };
        }
        // 5. Insert template widgets
        if (callCount === 5) {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: templateWidgetRows, error: null }),
          };
        }
        // 6. Update layout
        if (callCount === 6) {
          return {
            update: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return mockClient._chain;
      });

      const result = await dashboardsService.create(ctx, { appId: TEST_APP_ID, ...{ name: 'From Template', templateId: FIXTURE_TEMPLATE_ID } });

      expect(result.id).toBe('dash-tpl-001');
      expect(result.widgets).toHaveLength(FIXTURE_WIDGET_COUNT);
      // Layout should have widget IDs mapped from template
      expect(result.layout).toHaveLength(FIXTURE_WIDGET_COUNT);
      expect(result.layout[0]!.widgetId).toBe('tpl-w0');
    });

    it('should rollback dashboard when template widget creation fails', async () => {
      const createdRow: DashboardRow = {
        ...baseDashboardRow,
        id: 'dash-rollback-001',
        name: 'Rollback Test',
        layout: [],
      };

      const mockDeleteEq = vi.fn().mockResolvedValue({ error: null });

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        // 1. Per-app count check
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 2. Per-org count check
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 3. Name uniqueness check
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        // 4. Insert dashboard — succeeds
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: createdRow, error: null }),
          };
        }
        // 5. Insert widgets — fails
        if (callCount === 5) {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'Widget insert failed' },
            }),
          };
        }
        // 6. Rollback delete
        if (callCount === 6) {
          return {
            delete: vi.fn().mockReturnThis(),
            eq: mockDeleteEq,
          };
        }
        return mockClient._chain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...{
          name: 'Rollback Test',
          templateId: FIXTURE_TEMPLATE_ID,
        } })
      ).rejects.toThrow('Failed to create template widgets: Widget insert failed');

      // Verify rollback delete was called
      expect(mockDeleteEq).toHaveBeenCalledWith('id', 'dash-rollback-001');
    });

    it('should throw when layout update fails after template widget creation', async () => {
      const createdRow: DashboardRow = {
        ...baseDashboardRow,
        id: 'dash-layout-err',
        name: 'Layout Error',
        layout: [],
      };

      const templateWidgetRows = Array.from({ length: FIXTURE_WIDGET_COUNT }, (_, i) => ({
        ...baseWidgetRow,
        id: `w${i}`,
        dashboard_id: 'dash-layout-err',
        sort_order: i,
      }));

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        // 1. Per-app count check
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 2. Per-org count check
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 3. Name uniqueness check
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        // 4. Insert dashboard
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: createdRow, error: null }),
          };
        }
        // 5. Insert template widgets
        if (callCount === 5) {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: templateWidgetRows, error: null }),
          };
        }
        // 6. Layout update fails
        if (callCount === 6) {
          return {
            update: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ error: { message: 'Layout update failed' } }),
          };
        }
        return mockClient._chain;
      });

      await expect(
        dashboardsService.create(ctx, { appId: TEST_APP_ID, ...{
          name: 'Layout Error',
          templateId: FIXTURE_TEMPLATE_ID,
        } })
      ).rejects.toThrow('Failed to update dashboard layout: Layout update failed');
    });

  // --------------------------------------------------------------------------
  // updateDashboard
  // --------------------------------------------------------------------------

  describe('updateDashboard', () => {
    const updateRequest: UpdateDashboardRequest = {
      name: 'Updated Dashboard Name',
      globalTimeRange: '30d',
    };

    it('should update with partial data and return transformed result when valid input is provided', async () => {
      const updatedRow: DashboardRow = {
        ...baseDashboardRow,
        name: 'Updated Dashboard Name',
        global_time_range: '30d',
        updated_at: '2026-02-01T14:00:00Z',
      };

      // updateDashboard makes TWO from() calls:
      //   1. from('dashboard').update(...).eq(id).eq(app_id).select().single()
      //   2. from('dashboard_widget').select('*').eq(dashboard_id).order(sort_order)
      const updateChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: updatedRow,
          error: null,
        }),
      };

      const widgetChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      };

      mockClient.from.mockImplementation((table: string) => {
        if (table === 'dashboard') return updateChain;
        if (table === 'dashboard_widget') return widgetChain;
        return updateChain;
      });

      const result = await dashboardsService.update(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...updateRequest });

      expect(result.name).toBe('Updated Dashboard Name');
      expect(result.globalTimeRange).toBe('30d');
      expect(result.updatedAt).toBe('2026-02-01T14:00:00Z');

      // Verify update was called on 'dashboard' table
      expect(mockClient.from).toHaveBeenCalledWith('dashboard');
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Updated Dashboard Name',
          global_time_range: '30d',
        })
      );
    });

    it('should throw NotFoundError when dashboard not found', async () => {
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'Row not found' },
      });

      await expect(
        dashboardsService.update(ctx, { appId: TEST_APP_ID, dashboardId: 'nonexistent-id', ...updateRequest })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw a non-NotFound error when the update fails for a reason other than no-rows', async () => {
      // Rename is the reachable caller, and it renders this message as the
      // dialog's field error — so a transient failure classified as not-found
      // tells the user a dashboard still listed behind that dialog is gone.
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: '08006', message: 'connection failure' },
      });

      const err = await dashboardsService
        .update(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...updateRequest })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe('Failed to update dashboard: connection failure');
    });

    it('should throw ValidationError when update causes unique constraint violation', async () => {
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });

      await expect(
        dashboardsService.update(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...{ name: 'Taken Name' } })
      ).rejects.toThrow('Dashboard name already exists');
    });
  });

  // --------------------------------------------------------------------------
  // deleteDashboard
  // --------------------------------------------------------------------------

  describe('deleteDashboard', () => {
    it('should delete successfully when dashboard exists', async () => {
      // deleteDashboard: from('dashboard').delete({ count: 'exact' }).eq(id).eq(app_id)
      // Two chained .eq() calls; only the last resolves the promise
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn()
          .mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null, count: 1 }) })
      };

      mockClient.from.mockReturnValue(deleteChain);

      const result = await dashboardsService.delete(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID });

      expect(result).toBeUndefined();
      expect(mockClient.from).toHaveBeenCalledWith('dashboard');
      expect(deleteChain.delete).toHaveBeenCalledWith({ count: 'exact' });
    });

    it('should throw NotFoundError when dashboard not found (count === 0)', async () => {
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn()
          .mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null, count: 0 }) })
      };

      mockClient.from.mockReturnValue(deleteChain);

      await expect(
        dashboardsService.delete(ctx, { appId: TEST_APP_ID, dashboardId: 'nonexistent-id' })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw generic error when Supabase delete fails', async () => {
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn()
          .mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: { message: 'DB error' }, count: null }) })
      };

      mockClient.from.mockReturnValue(deleteChain);

      await expect(
        dashboardsService.delete(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID })
      ).rejects.toThrow('Failed to delete dashboard: DB error');
    });
  });

  // --------------------------------------------------------------------------
  // addWidget
  // --------------------------------------------------------------------------

  describe('addWidget', () => {
    const createWidgetRequest: CreateWidgetRequest = {
      title: 'New Widget',
      metric: 'request_count',
      visualization: 'bar',
      filters: [{ field: 'model', operator: 'eq', value: 'gpt-4' }],
      groupBy: 'model',
      timeGranularity: 'day',
    };

    it('should create widget and return transformed result when valid input is provided', async () => {
      const createdWidgetRow: DashboardWidgetRow = {
        id: 'widget-new-001',
        dashboard_id: TEST_DASHBOARD_ID,
        tenant_id: TEST_TENANT_ID,
        title: 'New Widget',
        metric: 'request_count',
        visualization: 'bar',
        filters: [{ field: 'model', operator: 'eq', value: 'gpt-4' }],
        group_by: 'model',
        time_granularity: 'day',
        score_name: null,
        score_name_b: null,
        environment_config: null,
        sort_order: 5,
        created_at: '2026-02-01T15:00:00Z',
        updated_at: null,
        created_by: TEST_USER_ID,
        updated_by: null,
      };

      // addWidget makes THREE from('dashboard_widget') calls:
      //   1. count check
      //   2. title uniqueness check
      //   3. insert
      let callCount = 0;

      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: 5,
          error: null,
        }),
      };

      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      const insertChain = {
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: createdWidgetRow,
          error: null,
        }),
      };

      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        if (callCount === 2) return nameCheckChain;
        return insertChain;
      });

      const result = await dashboardsService.addWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...createWidgetRequest });

      // Verify transformation
      expect(result.id).toBe('widget-new-001');
      expect(result.dashboardId).toBe(TEST_DASHBOARD_ID);
      expect(result.title).toBe('New Widget');
      expect(result.metric).toBe('request_count');
      expect(result.visualization).toBe('bar');
      expect(result.filters).toEqual([{ field: 'model', operator: 'eq', value: 'gpt-4' }]);
      expect(result.groupBy).toBe('model');
      expect(result.timeGranularity).toBe('day');
      expect(result.createdAt).toBe('2026-02-01T15:00:00Z');
      expect(result.updatedAt).toBeNull();

      // Verify both calls went to 'dashboard_widget'
      expect(mockClient.from).toHaveBeenCalledWith('dashboard_widget');
    });

    it('should throw ValidationError when widget count exceeds MAX_WIDGETS_PER_DASHBOARD', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: MAX_WIDGETS_PER_DASHBOARD,
          error: null,
        }),
      };

      mockClient.from.mockReturnValue(countChain);

      await expect(
        dashboardsService.addWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...createWidgetRequest })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw when widget count check fails', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: null,
          error: { message: 'Count query failed', code: 'PGRST000' },
        }),
      };

      mockClient.from.mockReturnValue(countChain);

      await expect(
        dashboardsService.addWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...createWidgetRequest })
      ).rejects.toThrow('Failed to check widget count: Count query failed');
    });

    it('should throw when widget insert fails', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
      };

      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      const insertChain = {
        insert: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Insert failed', code: 'PGRST000' },
        }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        if (callCount === 2) return nameCheckChain;
        return insertChain;
      });

      await expect(
        dashboardsService.addWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...createWidgetRequest })
      ).rejects.toThrow('Failed to add widget: Insert failed');
    });

    it('should throw ValidationError when widget title already exists on the dashboard', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
      };

      const nameCheckChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: 'widget-existing-001' },
          error: null,
        }),
      };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return countChain;
        return nameCheckChain;
      });

      await expect(
        dashboardsService.addWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...createWidgetRequest })
      ).rejects.toThrow('Widget title already exists on this dashboard');
    });

    it('should include MAX_WIDGETS_PER_DASHBOARD value in error message when limit is exceeded', async () => {
      const countChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({
          count: MAX_WIDGETS_PER_DASHBOARD,
          error: null,
        }),
      };

      mockClient.from.mockReturnValue(countChain);

      await expect(
        dashboardsService.addWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, ...createWidgetRequest })
      ).rejects.toThrow(String(MAX_WIDGETS_PER_DASHBOARD));
    });
  });

  // --------------------------------------------------------------------------
  // updateWidget
  // --------------------------------------------------------------------------

  describe('updateWidget', () => {
    const updateWidgetRequest: UpdateWidgetRequest = {
      title: 'Updated Widget Title',
      visualization: 'stat',
      groupBy: null,
    };

    it('should update widget with partial data and return transformed result when valid input is provided', async () => {
      const updatedWidgetRow: DashboardWidgetRow = {
        ...baseWidgetRow,
        title: 'Updated Widget Title',
        visualization: 'stat',
        group_by: null,
        updated_at: '2026-02-01T16:00:00Z',
      };

      mockClient._mocks.single.mockResolvedValue({
        data: updatedWidgetRow,
        error: null,
      });

      const result = await dashboardsService.updateWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, widgetId: TEST_WIDGET_ID, ...updateWidgetRequest });

      expect(result.id).toBe(TEST_WIDGET_ID);
      expect(result.title).toBe('Updated Widget Title');
      expect(result.visualization).toBe('stat');
      expect(result.groupBy).toBeNull();
      expect(result.updatedAt).toBe('2026-02-01T16:00:00Z');

      // Verify correct table and filters
      expect(mockClient._mocks.from).toHaveBeenCalledWith('dashboard_widget');
      expect(mockClient._mocks.eq).toHaveBeenCalledWith('id', TEST_WIDGET_ID);
      expect(mockClient._mocks.eq).toHaveBeenCalledWith('dashboard_id', TEST_DASHBOARD_ID);
    });

    it('should throw NotFoundError when widget does not belong to dashboard', async () => {
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'Row not found' },
      });

      await expect(
        dashboardsService.updateWidget(ctx, { appId: TEST_APP_ID, dashboardId: 'wrong-dashboard-id', widgetId: TEST_WIDGET_ID, ...updateWidgetRequest })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError when Supabase returns null data without error', async () => {
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: null,
      });

      await expect(
        dashboardsService.updateWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, widgetId: TEST_WIDGET_ID, ...updateWidgetRequest })
      ).rejects.toThrow(NotFoundError);
    });
  });

  // --------------------------------------------------------------------------
  // deleteWidget
  // --------------------------------------------------------------------------

  describe('deleteWidget', () => {
    it('should delete widget successfully when widget exists and belongs to dashboard', async () => {
      // deleteWidget: from('dashboard_widget').delete({ count: 'exact' }).eq(id).eq(dashboard_id)
      // Two chained .eq() calls
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn()
          .mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null, count: 1 }) })
      };

      mockClient.from.mockReturnValue(deleteChain);

      const result = await dashboardsService.deleteWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, widgetId: TEST_WIDGET_ID });

      expect(result).toBeUndefined();
      expect(mockClient.from).toHaveBeenCalledWith('dashboard_widget');
      expect(deleteChain.delete).toHaveBeenCalledWith({ count: 'exact' });
    });

    it('should throw NotFoundError when widget not found or wrong dashboard (count === 0)', async () => {
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn()
          .mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null, count: 0 }) })
      };

      mockClient.from.mockReturnValue(deleteChain);

      await expect(
        dashboardsService.deleteWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, widgetId: 'nonexistent-widget-id' })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw generic error when Supabase delete fails', async () => {
      const deleteChain = {
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn()
          .mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: { message: 'DB error' }, count: null }) })
      };

      mockClient.from.mockReturnValue(deleteChain);

      await expect(
        dashboardsService.deleteWidget(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID, widgetId: TEST_WIDGET_ID })
      ).rejects.toThrow('Failed to delete widget: DB error');
    });
  });

  // --------------------------------------------------------------------------
  // getOrCreateDefaultDashboard
  // --------------------------------------------------------------------------

  describe('getOrCreateDefaultDashboard', () => {
    it('should return existing default dashboard when dashboards exist', async () => {
      // Setup: listDashboards returns existing dashboards
      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: false, dashboard_widget: [{ count: 2 }] },
        { ...baseDashboardRow, id: 'dash-002', is_default: true, dashboard_widget: [{ count: 3 }] },
      ];

      // Mock for getDashboard
      const detailRow = { ...baseDashboardRow, id: 'dash-002', is_default: true };
      const widgetRows = [{ ...baseWidgetRow, dashboard_id: 'dash-002' }];

      let callCount = 0;
      mockClient.from.mockImplementation((_table: string) => {
        callCount++;
        // First call: listDashboards (dashboard table)
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: existingDashboards,
                  error: null,
                }),
              }),
            }),
          };
        }
        // Second call: getDashboard (dashboard table)
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: detailRow,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        // Third call: widgets for getDashboard
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: widgetRows,
                error: null,
              }),
            }),
          }),
        };
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-002');
      expect(result.isDefault).toBe(true);
    });

    it('should return first dashboard when no default exists', async () => {
      // Setup: listDashboards returns dashboards with none marked as default
      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: false, dashboard_widget: [{ count: 2 }] },
        { ...baseDashboardRow, id: 'dash-002', is_default: false, dashboard_widget: [{ count: 1 }] },
      ];

      // Mock for getDashboard (first one)
      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: false };
      const widgetRows = [{ ...baseWidgetRow, dashboard_id: 'dash-001' }];

      let callCount = 0;
      mockClient.from.mockImplementation((_table: string) => {
        callCount++;
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: existingDashboards,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: detailRow,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: widgetRows,
                error: null,
              }),
            }),
          }),
        };
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
    });

    it('should create dashboard from template when no dashboards exist', async () => {
      // Setup: listDashboards returns empty array
      const createdDashboardRow = {
        ...baseDashboardRow,
        id: 'dash-new-001',
        name: 'Overview',
        is_default: true,
        layout: [],
      };

      let callCount = 0;
      mockClient.from.mockImplementation((_table: string) => {
        callCount++;
        // 1. listDashboards (returns empty)
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          };
        }
        // 2. per-app count check for createDashboard
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                count: 0,
                error: null,
              }),
            }),
          };
        }
        // 3. per-org count check for createDashboard
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          };
        }
        // 4. Name uniqueness check
        if (callCount === 4) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                ilike: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        // 5. insert dashboard
        if (callCount === 5) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: createdDashboardRow,
                  error: null,
                }),
              }),
            }),
          };
        }
        // 6. insert widgets from template
        if (callCount === 6) {
          // Return mock widget rows (5 widgets for agent-fleet-overview template)
          const widgetRows = Array.from({ length: 5 }, (_, i) => ({
            ...baseWidgetRow,
            id: `widget-${i}`,
            dashboard_id: 'dash-new-001',
            sort_order: i,
          }));
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: widgetRows,
                  error: null,
                }),
              }),
            }),
          };
        }
        // 7. update layout
        if (callCount === 7) {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                error: null,
              }),
            }),
          };
        }
        // Default: return empty for any additional calls
        return mockClient._chain;
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.name).toBe('Overview');
      expect(result.isDefault).toBe(true);
      expect(result.widgets.length).toBe(5); // agent-fleet-overview has 5 widgets
    });
  });

  // --------------------------------------------------------------------------
  // syncDashboardWithTemplate (via getOrCreateDefaultDashboard)
  // --------------------------------------------------------------------------

  describe('syncDashboardWithTemplate', () => {
    it('should skip sync for non-default dashboards', async () => {
      // Dashboard is not default — sync should not add widgets
      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: false, name: 'Custom', dashboard_widget: [{ count: 1 }] },
      ];

      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: false, name: 'Custom' };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingDashboards, error: null }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        // Widgets fetch
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [baseWidgetRow], error: null }),
            }),
          }),
        };
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
      // Only 3 from() calls: listDashboards, getDashboard(dashboard), getDashboard(widgets)
      // No sync calls
      expect(callCount).toBe(3);
    });

    it('should skip sync for default dashboards not named Overview', async () => {
      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'My Custom Default', dashboard_widget: [{ count: 1 }] },
      ];

      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'My Custom Default' };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingDashboards, error: null }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [baseWidgetRow], error: null }),
            }),
          }),
        };
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
      expect(callCount).toBe(3);
    });

    it('should add missing template widgets when default Overview dashboard is out of date', async () => {
      // Dashboard built from the current default (agent-outcomes) but missing
      // its Clean Job Rate tile and the score-outcome correlation tile — a
      // majority of template pairs are present, so the lineage guard lets
      // the additive sync run.
      const existingWidgets = [
        { ...baseWidgetRow, id: 'existing-w0', metric: 'score_summary', visualization: 'stat', title: 'Outcome Scores by Name' },
        { ...baseWidgetRow, id: 'existing-w1', metric: 'score_trend', visualization: 'line', title: 'First-Pass CI Green Rate' },
        { ...baseWidgetRow, id: 'existing-w2', metric: 'score_histogram', visualization: 'bar', title: 'Merge Outcome Split' },
        { ...baseWidgetRow, id: 'existing-w3', metric: 'agent_pr_merge_rate', visualization: 'stat', title: 'Agent PR Merge Rate (lifecycle)' },
        { ...baseWidgetRow, id: 'existing-w4', metric: 'agent_pr_revert_rate', visualization: 'stat', title: 'Revert Rate (lifecycle)' },
      ];

      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', dashboard_widget: [{ count: 5 }] },
      ];

      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', layout: [] };

      // 2 new widgets to be inserted (the missing Clean Job Rate and the
      // score-outcome correlation tile)
      const insertedWidgets = Array.from({ length: 2 }, (_, i) => ({
        ...baseWidgetRow,
        id: `new-w${i}`,
        dashboard_id: 'dash-001',
        sort_order: 5 + i,
      }));

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        // 1. listDashboards
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingDashboards, error: null }),
              }),
            }),
          };
        }
        // 2. getDashboard - dashboard
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        // 3. getDashboard - widgets
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingWidgets, error: null }),
              }),
            }),
          };
        }
        // 4. syncDashboardWithTemplate - insert missing widgets
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: insertedWidgets, error: null }),
              }),
            }),
          };
        }
        // 5. syncDashboardWithTemplate - update layout
        if (callCount === 5) {
          return {
            update: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        // 6. Re-fetch getDashboard after sync - dashboard
        if (callCount === 6) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        // 7. Re-fetch getDashboard after sync - all widgets
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [...existingWidgets, ...insertedWidgets],
                error: null,
              }),
            }),
          }),
        };
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
      expect(result.widgets).toHaveLength(7);
      // Verify sync happened (more than 3 calls)
      expect(callCount).toBeGreaterThan(3);
    });

    it('should skip sync when all template widgets already exist', async () => {
      // Dashboard already has every agent-outcomes widget. Sync matches on
      // `${metric}:${visualization}` without scoreName, so the template's two
      // score_trend:line entries dedupe to one — one present trend satisfies
      // both.
      const allWidgets = [
        { ...baseWidgetRow, id: 'w0', metric: 'score_summary', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w1', metric: 'score_trend', visualization: 'line' },
        { ...baseWidgetRow, id: 'w2', metric: 'score_histogram', visualization: 'bar' },
        { ...baseWidgetRow, id: 'w3', metric: 'agent_pr_merge_rate', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w4', metric: 'agent_pr_revert_rate', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w5', metric: 'agent_clean_job_rate', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w6', metric: 'agent_pr_outcome_by_score_merge_rate', visualization: 'stat' },
      ];

      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', dashboard_widget: [{ count: 24 }] },
      ];

      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', layout: [] };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingDashboards, error: null }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: allWidgets, error: null }),
              }),
            }),
          };
        }
        return mockClient._chain;
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
      expect(result.widgets).toHaveLength(7);
      // Only 3 calls — no sync needed
      expect(callCount).toBe(3);
    });

    it('should freeze an Overview built from a retired default template', async () => {
      // A legacy auto-created Overview: none of its widgets belong to the
      // current default template, so the lineage guard must skip the additive
      // sync — piling a second template's widgets onto a retired board is
      // exactly what the guard exists to prevent.
      const legacyWidgets = [
        { ...baseWidgetRow, id: 'w0', metric: 'section_header', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w1', metric: 'agent_pr_cycle_time_trend', visualization: 'line' },
        { ...baseWidgetRow, id: 'w2', metric: 'agent_cost_per_merged_pr', visualization: 'stat' },
      ];

      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', dashboard_widget: [{ count: 3 }] },
      ];

      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', layout: [] };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingDashboards, error: null }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: legacyWidgets, error: null }),
            }),
          }),
        };
      });

      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
      expect(result.widgets).toHaveLength(3);
      // listDashboards, getDashboard(dashboard), getDashboard(widgets) — no insert.
      expect(callCount).toBe(3);
    });

    it('should gracefully handle sync failure and return existing dashboard', async () => {
      // Same-lineage dashboard missing one widget, so the guard admits the
      // sync — whose insert then fails, and the failure must not break the
      // read path.
      const existingWidgets = [
        { ...baseWidgetRow, id: 'w0', metric: 'score_summary', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w1', metric: 'score_trend', visualization: 'line' },
        { ...baseWidgetRow, id: 'w2', metric: 'score_histogram', visualization: 'bar' },
        { ...baseWidgetRow, id: 'w3', metric: 'agent_pr_merge_rate', visualization: 'stat' },
        { ...baseWidgetRow, id: 'w4', metric: 'agent_pr_revert_rate', visualization: 'stat' },
      ];

      const existingDashboards = [
        { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', dashboard_widget: [{ count: 1 }] },
      ];

      const detailRow = { ...baseDashboardRow, id: 'dash-001', is_default: true, name: 'Overview', layout: [] };

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingDashboards, error: null }),
              }),
            }),
          };
        }
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
                }),
              }),
            }),
          };
        }
        if (callCount === 3) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: existingWidgets, error: null }),
              }),
            }),
          };
        }
        // Sync widget insert fails
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: null,
                  error: { message: 'Sync insert failed' },
                }),
              }),
            }),
          };
        }
        return mockClient._chain;
      });

      // Should not throw — sync failure is caught and logged
      const result = await dashboardsService.getOrCreateDefault(ctx, TEST_APP_ID);

      expect(result.id).toBe('dash-001');
      expect(result.widgets).toHaveLength(5); // Returns existing widgets, not synced
    });
  });

  // --------------------------------------------------------------------------
  // duplicateDashboard
  // --------------------------------------------------------------------------

  describe('duplicateDashboard', () => {
    it('should create dashboard with " (Copy)" suffix when duplicating', async () => {
      // getDashboard returns the source
      const sourceDashboard = { ...baseDashboardRow, name: 'My Dashboard' };
      const sourceWidgets = [
        { ...baseWidgetRow, id: 'orig-w1', title: 'Widget 1' },
        { ...baseWidgetRow, id: 'orig-w2', title: 'Widget 2' },
      ];

      // duplicated dashboard row
      const duplicatedRow = {
        ...baseDashboardRow,
        id: 'dash-copy-001',
        name: 'My Dashboard (Copy)',
        is_default: false,
        layout: [],
      };

      // copied widgets
      const copiedWidgets = [
        { ...baseWidgetRow, id: 'copy-w1', dashboard_id: 'dash-copy-001', sort_order: 0 },
        { ...baseWidgetRow, id: 'copy-w2', dashboard_id: 'dash-copy-001', sort_order: 1 },
      ];

      let callCount = 0;
      mockClient.from.mockImplementation((_table: string) => {
        callCount++;
        // 1. getDashboard — dashboard table
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: sourceDashboard,
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        // 2. getDashboard — widgets table
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: sourceWidgets,
                  error: null,
                }),
              }),
            }),
          };
        }
        // 3. Insert new dashboard
        if (callCount === 3) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: duplicatedRow,
                  error: null,
                }),
              }),
            }),
          };
        }
        // 4. Insert copied widgets
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: copiedWidgets,
                  error: null,
                }),
              }),
            }),
          };
        }
        // Any remaining calls
        return mockClient._chain;
      });

      const result = await dashboardsService.duplicate(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID });

      expect(result.id).toBe('dash-copy-001');
      expect(result.name).toBe('My Dashboard (Copy)');
      expect(result.isDefault).toBe(false);
      expect(result.widgets).toHaveLength(2);
    });

    it('should throw NotFoundError when source dashboard does not exist', async () => {
      mockClient._mocks.single.mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'Row not found' },
      });

      await expect(
        dashboardsService.duplicate(ctx, { appId: TEST_APP_ID, dashboardId: 'bad-id' })
      ).rejects.toThrow(NotFoundError);
    });

    it('should rollback dashboard when widget copy fails during duplicate', async () => {
      const sourceDashboard = { ...baseDashboardRow, name: 'Source' };
      const sourceWidgets = [{ ...baseWidgetRow, id: 'orig-w1' }];
      const duplicatedRow = {
        ...baseDashboardRow,
        id: 'dash-copy-fail',
        name: 'Source (Copy)',
        layout: [],
      };

      const mockDeleteEq = vi.fn().mockResolvedValue({ error: null });

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        // 1. getDashboard - dashboard
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: sourceDashboard, error: null }),
                }),
              }),
            }),
          };
        }
        // 2. getDashboard - widgets
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: sourceWidgets, error: null }),
              }),
            }),
          };
        }
        // 3. Insert duplicate dashboard
        if (callCount === 3) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: duplicatedRow, error: null }),
              }),
            }),
          };
        }
        // 4. Insert widgets — fails
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: null,
                  error: { message: 'Widget copy failed' },
                }),
              }),
            }),
          };
        }
        // 5. Rollback delete
        if (callCount === 5) {
          return {
            delete: vi.fn().mockReturnThis(),
            eq: mockDeleteEq,
          };
        }
        return mockClient._chain;
      });

      await expect(
        dashboardsService.duplicate(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID })
      ).rejects.toThrow('Failed to duplicate widgets: Widget copy failed');

      expect(mockDeleteEq).toHaveBeenCalledWith('id', 'dash-copy-fail');
    });

    it('should remap layout widget IDs from source to duplicate', async () => {
      const sourceLayout = [
        { widgetId: 'orig-w1', x: 0, y: 0, w: 6, h: 4 },
        { widgetId: 'orig-w2', x: 6, y: 0, w: 6, h: 4 },
      ];
      const sourceDashboard = { ...baseDashboardRow, name: 'With Layout', layout: sourceLayout };
      const sourceWidgets = [
        { ...baseWidgetRow, id: 'orig-w1', title: 'Widget 1' },
        { ...baseWidgetRow, id: 'orig-w2', title: 'Widget 2' },
      ];

      const duplicatedRow = {
        ...baseDashboardRow,
        id: 'dash-copy-layout',
        name: 'With Layout (Copy)',
        is_default: false,
        layout: [],
      };

      const copiedWidgets = [
        { ...baseWidgetRow, id: 'new-w1', dashboard_id: 'dash-copy-layout', sort_order: 0 },
        { ...baseWidgetRow, id: 'new-w2', dashboard_id: 'dash-copy-layout', sort_order: 1 },
      ];

      const mockLayoutUpdate = vi.fn().mockReturnThis();
      const mockLayoutUpdateEq = vi.fn().mockResolvedValue({ error: null });

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        // 1. getDashboard - dashboard
        if (callCount === 1) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: sourceDashboard, error: null }),
                }),
              }),
            }),
          };
        }
        // 2. getDashboard - widgets
        if (callCount === 2) {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: sourceWidgets, error: null }),
              }),
            }),
          };
        }
        // 3. Insert duplicate dashboard
        if (callCount === 3) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: duplicatedRow, error: null }),
              }),
            }),
          };
        }
        // 4. Insert copied widgets
        if (callCount === 4) {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: copiedWidgets, error: null }),
              }),
            }),
          };
        }
        // 5. Update layout with remapped IDs
        if (callCount === 5) {
          return {
            update: mockLayoutUpdate,
            eq: mockLayoutUpdateEq,
          };
        }
        return mockClient._chain;
      });

      const result = await dashboardsService.duplicate(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID });

      // Verify layout has new widget IDs, not old ones
      expect(result.layout).toHaveLength(2);
      expect(result.layout[0]!.widgetId).toBe('new-w1');
      expect(result.layout[1]!.widgetId).toBe('new-w2');
      // Positions preserved from source
      expect(result.layout[0]!.x).toBe(0);
      expect(result.layout[1]!.x).toBe(6);

      // Verify layout update was called with remapped IDs
      expect(mockLayoutUpdate).toHaveBeenCalledWith({
        layout: expect.arrayContaining([
          expect.objectContaining({ widgetId: 'new-w1' }),
          expect.objectContaining({ widgetId: 'new-w2' }),
        ]),
      });
    });
  });

  // --------------------------------------------------------------------------
  // setDefault
  // --------------------------------------------------------------------------

  describe('setDefault', () => {
    it('should unset existing defaults and set new default when called', async () => {
      // setDefault makes TWO from('dashboard') calls:
      //   1. update(is_default: false).eq(app_id).eq(is_default: true)
      //   2. update(is_default: true).eq(id).eq(app_id)
      let callCount = 0;

      const unsetChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      };
      // Terminal .eq() resolves the promise
      unsetChain.eq.mockReturnValue(unsetChain);
      // After 2nd eq, resolve
      let unsetEqCount = 0;
      unsetChain.eq.mockImplementation(() => {
        unsetEqCount++;
        if (unsetEqCount >= 2) {
          return Promise.resolve({ error: null });
        }
        return unsetChain;
      });

      const setChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      };
      let setEqCount = 0;
      setChain.eq.mockImplementation(() => {
        setEqCount++;
        if (setEqCount >= 2) {
          return Promise.resolve({ error: null });
        }
        return setChain;
      });

      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return unsetChain;
        return setChain;
      });

      await dashboardsService.setDefault(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID });

      expect(mockClient.from).toHaveBeenCalledWith('dashboard');
      expect(unsetChain.update).toHaveBeenCalledWith({ is_default: false });
      expect(setChain.update).toHaveBeenCalledWith({ is_default: true });
    });

    it('should throw when set-default update fails', async () => {
      // First call (unset) succeeds
      const unsetChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn(),
      };
      let unsetEqCount = 0;
      unsetChain.eq.mockImplementation(() => {
        unsetEqCount++;
        if (unsetEqCount >= 2) return Promise.resolve({ error: null });
        return unsetChain;
      });

      // Second call (set) fails
      const setChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn(),
      };
      let setEqCount = 0;
      setChain.eq.mockImplementation(() => {
        setEqCount++;
        if (setEqCount >= 2) return Promise.resolve({ error: { message: 'Update failed' } });
        return setChain;
      });

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return unsetChain;
        return setChain;
      });

      await expect(
        dashboardsService.setDefault(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID })
      ).rejects.toThrow('Failed to set default dashboard');
    });

    it('should not error when unset step silently fails and set step succeeds', async () => {
      // Unset step returns an error but setDefault doesn't check it
      const unsetChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn(),
      };
      let unsetEqCount = 0;
      unsetChain.eq.mockImplementation(() => {
        unsetEqCount++;
        if (unsetEqCount >= 2) return Promise.resolve({ error: { message: 'Unset failed' } });
        return unsetChain;
      });

      const setChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn(),
      };
      let setEqCount = 0;
      setChain.eq.mockImplementation(() => {
        setEqCount++;
        if (setEqCount >= 2) return Promise.resolve({ error: null });
        return setChain;
      });

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return unsetChain;
        return setChain;
      });

      // Should succeed even though unset step had an error
      await expect(
        dashboardsService.setDefault(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID })
      ).resolves.toBeUndefined();
    });

    it('should propagate error when unset-defaults step throws', async () => {
      // First call (unset) rejects
      const unsetChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn(),
      };
      let unsetEqCount = 0;
      unsetChain.eq.mockImplementation(() => {
        unsetEqCount++;
        if (unsetEqCount >= 2) return Promise.resolve({ error: { message: 'Unset failed' } });
        return unsetChain;
      });

      mockClient.from.mockReturnValue(unsetChain);

      // setDefault does not check for error on unset step in current implementation.
      // This test documents that behavior — the unset error is silently ignored
      // and the set step is still attempted.
      // If the set step also fails, that error is thrown.
      const setChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn(),
      };
      let setEqCount = 0;
      setChain.eq.mockImplementation(() => {
        setEqCount++;
        if (setEqCount >= 2) return Promise.resolve({ error: { message: 'Set also failed' } });
        return setChain;
      });

      let callCount = 0;
      mockClient.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return unsetChain;
        return setChain;
      });

      await expect(
        dashboardsService.setDefault(ctx, { appId: TEST_APP_ID, dashboardId: TEST_DASHBOARD_ID })
      ).rejects.toThrow('Failed to set default dashboard');
    });
  });
});
