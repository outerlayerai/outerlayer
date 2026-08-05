/**
 * Tests: POST /api/analytics/widget-data — Agent Fleet Overview metrics
 * (session_count, tool_error_rate, clean_session_rate, active_actor_count,
 * agent_model_mix, active_actor_trend).
 *
 * The five tile/ranking metrics read `getAgentFleetOverview` (a single
 * query backs all five). active_actor_trend is the odd one out — a daily
 * COUNT trend (never a %-of-org-seats adoption rate; that denominator
 * lives in Postgres org membership, not ClickHouse), backed by its own
 * `getAgentFleetActiveActorTrend` query. Both are a different code path
 * than every other metric in this route — separate file so it doesn't get
 * lost in route.test.ts's 900+ lines.
 */

// @vitest-environment node

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const mockTenantContext = Object.freeze({
  userId: 'user-123',
  tenantId: 'tenant-456',
  appId: 'app-789',
});

vi.mock('@/app/api/analytics/with-auth', () => ({
  withAnalyticsAuthParams: (handler: any) => async (
    request: Request,
    ctx?: { params: Promise<{ orgName: string; appId: string }> },
  ) => {
    const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
    return handler(request, mockTenantContext, params);
  },
}));

const mockGetAgentFleetOverview = vi.fn();
const mockGetAgentFleetActiveActorTrend = vi.fn();
const mockGetAgentFleetTrajectorySignalTrend = vi.fn();

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getAgentFleetOverview: mockGetAgentFleetOverview,
    getAgentFleetActiveActorTrend: mockGetAgentFleetActiveActorTrend,
    getAgentFleetTrajectorySignalTrend: mockGetAgentFleetTrajectorySignalTrend,
  }),
  parseDateRange: (_preset: string) => ({ start: '2026-01-28', end: '2026-02-04' }),
}));

vi.mock('@/lib/analytics/errors', () => ({
  toErrorResponse: (err: any) => ({ error: err.message }),
  getErrorStatusCode: () => 500,
  mapClickHouseError: (err: any) => err,
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ValidationError';
    }
  },
}));

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { query: vi.fn(), error: vi.fn() },
  createTimer: () => ({ elapsed: () => 100 }),
}));

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/analytics/widget-data?appId=app-789', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OVERVIEW = {
  sessions: { current: 20, prior: 10 },
  toolErrorRate: { current: 0.1, prior: 0.2 },
  cleanSessionRate: { current: 0.9, prior: 0.8 },
  handsOnRate: { current: 0.3, prior: 0.5 },
  activeActors: { current: 4, prior: 4 },
  totalCost: { current: 30, prior: 24 },
  modelMix: [
    { model: 'anthropic/claude-opus-4-8', sessions: 12 },
    { model: 'anthropic/claude-sonnet-5', sessions: 4 },
  ],
};

const ACTIVE_ACTOR_TREND = {
  points: [
    { date: '2026-01-28', activeActors: 3 },
    { date: '2026-01-29', activeActors: 4 },
  ],
};

const TRAJECTORY_TREND = {
  points: [
    { date: '2026-01-28', toolErrorRate: 0.125, denialRate: 0.05, handsOnShare: 0.4 },
    { date: '2026-01-29', toolErrorRate: 0, denialRate: 0, handsOnShare: 0 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentFleetOverview.mockResolvedValue(OVERVIEW);
  mockGetAgentFleetActiveActorTrend.mockResolvedValue(ACTIVE_ACTOR_TREND);
  mockGetAgentFleetTrajectorySignalTrend.mockResolvedValue(TRAJECTORY_TREND);
});

describe('POST /api/analytics/widget-data (agent fleet tiles)', () => {
  it('returns session_count as a stat with an "up" delta when sessions grew', async () => {
    const res = await POST(makeRequest({ metric: 'session_count', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 20,
      label: 'Sessions',
      change: { value: 100, direction: 'up' }, // (20-10)/10 * 100
    });
  });

  it('scales tool_error_rate from a 0..1 fraction to a percentage, and flags a "down" trend as improving', async () => {
    const res = await POST(makeRequest({ metric: 'tool_error_rate', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 10, // 0.1 * 100
      label: 'Tool Error Rate (%)',
      change: { value: -50, direction: 'down' }, // (10-20)/20 * 100
    });
  });

  it('scales clean_session_rate from a 0..1 fraction to a percentage, and flags an "up" trend as improving (not inverted, unlike error rate)', async () => {
    const res = await POST(makeRequest({ metric: 'clean_session_rate', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 90, // 0.9 * 100
      label: 'Error-Free Sessions (%)',
      change: { value: 12.5, direction: 'up' }, // (90-80)/80 * 100
    });
  });

  it('scales agent_hands_on_rate from a 0..1 fraction to a percentage; a "down" trend (less steering) reads as improving', async () => {
    const res = await POST(makeRequest({ metric: 'agent_hands_on_rate', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 30, // 0.3 * 100 — 30% of sessions needed mid-session steering
      label: 'Hands-On Rate (%)',
      change: { value: -40, direction: 'down' }, // (30-50)/50 * 100 — less steering than the prior window
    });
  });

  it('returns active_actor_count as a bare stat with a "flat" delta when unchanged', async () => {
    const res = await POST(makeRequest({ metric: 'active_actor_count', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 4,
      label: 'Active Actors',
      change: { value: 0, direction: 'flat' },
    });
  });

  it('returns total_agent_cost as a raw-dollar stat (scale 1, no percentage conversion) with a period delta', async () => {
    const res = await POST(makeRequest({ metric: 'total_agent_cost', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 30, // summed CostUsd passes through unscaled (unlike the rate tiles)
      label: 'Total Spend',
      change: { value: 25, direction: 'up' }, // (30-24)/24 * 100
    });
  });

  it('an empty prior window yields NO change (never a fabricated +100%), flagged priorEmpty', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({
      ...OVERVIEW,
      sessions: { current: 5, prior: 0 },
    });
    const res = await POST(makeRequest({ metric: 'session_count', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 5,
      label: 'Sessions',
      priorEmpty: true,
    });
  });

  it('a true 0 -> 0 is a flat 0% change, not priorEmpty (a real, comparable baseline)', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({
      ...OVERVIEW,
      sessions: { current: 0, prior: 0 },
    });
    const res = await POST(makeRequest({ metric: 'session_count', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'Sessions',
      change: { value: 0, direction: 'flat' },
    });
  });

  it('returns agent_model_mix as a ranking keyed by model, preserving order', async () => {
    const res = await POST(makeRequest({ metric: 'agent_model_mix', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'anthropic/claude-opus-4-8', value: 12 },
        { name: 'anthropic/claude-sonnet-5', value: 4 },
      ],
    });
  });

  it('calls getAgentFleetOverview exactly once even though the route is asked for one specific tile', async () => {
    await POST(makeRequest({ metric: 'session_count', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect(mockGetAgentFleetOverview).toHaveBeenCalledTimes(1);
    expect(mockGetAgentFleetOverview).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      // No scope in the request → app scope (options undefined).
      undefined,
    );
  });

  it('forwards scope: "org" from the request to getAgentFleetOverview\'s options, not the app-scope default', async () => {
    await POST(makeRequest({ metric: 'session_count', timeRange: { preset: '7d' }, scope: 'org' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect(mockGetAgentFleetOverview).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      { scope: 'org' },
    );
  });

});

describe('POST /api/analytics/widget-data (active actor trend)', () => {
  it('returns active_actor_trend as a single-series time series of daily active-actor COUNTs, not a %-of-seats rate', async () => {
    const res = await POST(makeRequest({ metric: 'active_actor_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'Active Actors', data: [{ x: '2026-01-28', y: 3 }, { x: '2026-01-29', y: 4 }] },
      ],
    });
    expect(mockGetAgentFleetActiveActorTrend).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      undefined,
    );
    // Distinct method from the tile query — active_actor_count (the stat)
    // and active_actor_trend (the trend) are two different queries.
    expect(mockGetAgentFleetOverview).not.toHaveBeenCalled();
  });

  it('errors clearly when the service does not implement getAgentFleetActiveActorTrend', async () => {
    vi.resetModules();
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/server', () => ({
      NextResponse: {
        json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
      },
    }));
    vi.doMock('@/app/api/analytics/with-auth', () => ({
      withAnalyticsAuthParams: (handler: any) => async (
        request: Request,
        ctx?: { params: Promise<{ orgName: string; appId: string }> },
      ) => {
        const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
        return handler(request, mockTenantContext, params);
      },
    }));
    vi.doMock('@/lib/analytics', () => ({
      getAnalyticsService: () => ({}),
      parseDateRange: () => ({ start: '2026-01-28', end: '2026-02-04' }),
    }));
    vi.doMock('@/lib/analytics/errors', () => ({
      toErrorResponse: (err: any) => ({ error: err.message }),
      getErrorStatusCode: () => 400,
      mapClickHouseError: (err: any) => err,
      ValidationError: class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      },
    }));
    vi.doMock('@/lib/analytics/logger', () => ({
      analyticsLogger: { query: vi.fn(), error: vi.fn() },
      createTimer: () => ({ elapsed: () => 100 }),
    }));

    const { POST: isolatedPost } = await import('../route');
    const res = await isolatedPost(makeRequest({ metric: 'active_actor_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Agent fleet metrics are not available');
  });
});

describe('POST /api/analytics/widget-data (trajectory signals trend)', () => {
  it('returns agent_trajectory_signals_trend as three named rate series, scaled to percentage points', async () => {
    const res = await POST(makeRequest({ metric: 'agent_trajectory_signals_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'Tool error rate', data: [{ x: '2026-01-28', y: 12.5 }, { x: '2026-01-29', y: 0 }] },
        { name: 'Denial rate', data: [{ x: '2026-01-28', y: 5 }, { x: '2026-01-29', y: 0 }] },
        { name: 'Hands-on sessions', data: [{ x: '2026-01-28', y: 40 }, { x: '2026-01-29', y: 0 }] },
      ],
    });
    expect(mockGetAgentFleetTrajectorySignalTrend).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-789', tenantId: 'tenant-456' }),
      expect.any(Object),
      undefined,
    );
    // Its own query — never the overview tiles or the percentile trend.
    expect(mockGetAgentFleetOverview).not.toHaveBeenCalled();
  });
});

describe('POST /api/analytics/widget-data (agent fleet — service missing the optional method)', () => {
  it('errors clearly (not a crash) when the analytics service does not implement getAgentFleetOverview', async () => {
    // Optional interface method — e.g. a CLI-local IAnalyticsService
    // implementer. Reset + remock in isolation so this one test exercises a
    // service object with the method genuinely absent (not just undefined
    // by accident), then dynamically re-import the route against it.
    vi.resetModules();
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/server', () => ({
      NextResponse: {
        json: (body: unknown, init?: { status?: number }) => ({
          status: init?.status ?? 200,
          json: async () => body,
        }),
      },
    }));
    vi.doMock('@/app/api/analytics/with-auth', () => ({
      withAnalyticsAuthParams: (handler: any) => async (
        request: Request,
        ctx?: { params: Promise<{ orgName: string; appId: string }> },
      ) => {
        const params = ctx ? await ctx.params : { orgName: 'test-org', appId: mockTenantContext.appId };
        return handler(request, mockTenantContext, params);
      },
    }));
    vi.doMock('@/lib/analytics', () => ({
      getAnalyticsService: () => ({}), // no getAgentFleetOverview at all
      parseDateRange: () => ({ start: '2026-01-28', end: '2026-02-04' }),
    }));
    vi.doMock('@/lib/analytics/errors', () => ({
      toErrorResponse: (err: any) => ({ error: err.message }),
      getErrorStatusCode: () => 400,
      mapClickHouseError: (err: any) => err,
      ValidationError: class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      },
    }));
    vi.doMock('@/lib/analytics/logger', () => ({
      analyticsLogger: { query: vi.fn(), error: vi.fn() },
      createTimer: () => ({ elapsed: () => 100 }),
    }));

    const { POST: isolatedPost } = await import('../route');
    const res = await isolatedPost(makeRequest({ metric: 'session_count', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Agent fleet metrics are not available');
  });
});
