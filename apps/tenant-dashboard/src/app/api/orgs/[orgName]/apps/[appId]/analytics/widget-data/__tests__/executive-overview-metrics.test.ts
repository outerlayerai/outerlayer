/**
 * Tests: POST /api/analytics/widget-data — Executive Overview metrics.
 *
 * The metrics behind the three-question default dashboard:
 *  - agent_spend_per_active_dev — a ratio of two overview tiles, computed
 *    per period IN THE ROUTE (the service returns the raw tiles).
 *  - agent_autonomy_mix_trend — its own query; the route pivots per-day
 *    per-kind rows into one zero-filled series per worker kind, seat first.
 *  - agent_interventions_trend — rides the percentile-trend query's new
 *    interventionsMean column.
 *  - agent_sessions_by_worker_kind / agent_cost_by_worker_kind — the
 *    dimension breakdown with the worker_kind dimension.
 *  - agent_share_of_merged_prs / agent_vs_human_* /
 *    agent_unshipped_spend_share — the PR-lifecycle branch (Postgres rows +
 *    ClickHouse attribution), math pinned in pr-metrics.test.ts; these tests
 *    pin the ROUTE's response mapping (shape, scaling, empty handling).
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
const mockGetAgentFleetAutonomyMixTrend = vi.fn();
const mockGetAgentFleetPercentileTrend = vi.fn();
const mockGetAgentFleetDimensionBreakdown = vi.fn();
const mockGetAgentPrAttribution = vi.fn();
const mockGetAgentPrCostAttribution = vi.fn();

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getAgentFleetOverview: mockGetAgentFleetOverview,
    getAgentFleetAutonomyMixTrend: mockGetAgentFleetAutonomyMixTrend,
    getAgentFleetPercentileTrend: mockGetAgentFleetPercentileTrend,
    getAgentFleetDimensionBreakdown: mockGetAgentFleetDimensionBreakdown,
    getAgentPrAttribution: mockGetAgentPrAttribution,
    getAgentPrCostAttribution: mockGetAgentPrCostAttribution,
  }),
  parseDateRange: (_preset: string) => ({ start: '2026-01-28', end: '2026-02-04' }),
}));

const mockFetchDecidedPullRequests = vi.fn();
vi.mock('@/lib/system/pr-tracking/pr-lifecycle-read', () => ({
  fetchDecidedPullRequests: (...args: unknown[]) => mockFetchDecidedPullRequests(...args),
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
  activeActors: { current: 4, prior: 2 },
  totalCost: { current: 30, prior: 24 },
  modelMix: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent_spend_per_active_dev', () => {
  it('divides total cost by active actors PER PERIOD — never a per-person breakdown', async () => {
    mockGetAgentFleetOverview.mockResolvedValue(OVERVIEW);

    const res = await POST(
      makeRequest({ metric: 'agent_spend_per_active_dev', visualization: 'stat', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // current 30/4 = 7.5, prior 24/2 = 12 → change (7.5-12)/12 = -37.5%
    expect(body).toEqual({
      type: 'stat',
      value: 7.5,
      label: 'Spend per Active Dev',
      change: { value: -37.5, direction: 'down' },
    });
  });

  it('returns 0 (not NaN/Infinity) when no actors were active', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({
      ...OVERVIEW,
      activeActors: { current: 0, prior: 0 },
      totalCost: { current: 0, prior: 0 },
    });

    const res = await POST(
      makeRequest({ metric: 'agent_spend_per_active_dev', visualization: 'stat', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();
    expect(body.value).toBe(0);
  });
});

describe('agent_autonomy_mix_trend', () => {
  it('pivots per-day per-kind rows into zero-filled series, seat first', async () => {
    mockGetAgentFleetAutonomyMixTrend.mockResolvedValue({
      points: [
        // Deliberately unordered kinds + a date where cloud is absent.
        { date: '2026-02-01', workerKind: 'cloud', sessions: 3 },
        { date: '2026-02-01', workerKind: 'seat', sessions: 12 },
        { date: '2026-02-02', workerKind: 'seat', sessions: 10 },
        { date: '2026-02-02', workerKind: 'ci', sessions: 2 },
      ],
    });

    const res = await POST(
      makeRequest({ metric: 'agent_autonomy_mix_trend', visualization: 'area', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // Fixed kind order (seat, [shared,] ci, cloud) and a zero where a kind
    // had no sessions that day — sparse series would mis-stack.
    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'seat', data: [{ x: '2026-02-01', y: 12 }, { x: '2026-02-02', y: 10 }] },
        { name: 'ci', data: [{ x: '2026-02-01', y: 0 }, { x: '2026-02-02', y: 2 }] },
        { name: 'cloud', data: [{ x: '2026-02-01', y: 3 }, { x: '2026-02-02', y: 0 }] },
      ],
    });
  });
});

describe('agent_interventions_trend', () => {
  it('surfaces the daily interventions mean from the percentile-trend query, rounded to 2dp', async () => {
    mockGetAgentFleetPercentileTrend.mockResolvedValue({
      points: [
        { date: '2026-02-01', costP50: 1, costP95: 2, durationP50Ms: 1, durationP95Ms: 2, durationP99Ms: 3, turnCountP95: 9, interventionsMean: 2.4567 },
        { date: '2026-02-02', costP50: 1, costP95: 2, durationP50Ms: 1, durationP95Ms: 2, durationP99Ms: 3, turnCountP95: 9, interventionsMean: 0 },
      ],
    });

    const res = await POST(
      makeRequest({ metric: 'agent_interventions_trend', visualization: 'line', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        {
          name: 'Mean interventions',
          data: [{ x: '2026-02-01', y: 2.46 }, { x: '2026-02-02', y: 0 }],
        },
      ],
    });
  });
});

describe('worker-kind dimension rankings', () => {
  const BREAKDOWN = {
    items: [
      { dimensionValue: 'seat', sessions: 14, costUsd: 21.5, toolErrorRate: 0.05 },
      { dimensionValue: 'cloud', sessions: 6, costUsd: 8.5, toolErrorRate: 0.02 },
    ],
  };

  it('agent_sessions_by_worker_kind requests the worker_kind dimension and surfaces session counts', async () => {
    mockGetAgentFleetDimensionBreakdown.mockResolvedValue(BREAKDOWN);

    const res = await POST(
      makeRequest({ metric: 'agent_sessions_by_worker_kind', visualization: 'bar', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(mockGetAgentFleetDimensionBreakdown).toHaveBeenCalledWith(
      mockTenantContext,
      { start: '2026-01-28', end: '2026-02-04' },
      'worker_kind',
      undefined,
    );
    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'seat', value: 14 },
        { name: 'cloud', value: 6 },
      ],
    });
  });

  it('agent_cost_by_worker_kind surfaces the cost field off the same rows', async () => {
    mockGetAgentFleetDimensionBreakdown.mockResolvedValue(BREAKDOWN);

    const res = await POST(
      makeRequest({ metric: 'agent_cost_by_worker_kind', visualization: 'bar', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(body.items).toEqual([
      { name: 'seat', value: 21.5 },
      { name: 'cloud', value: 8.5 },
    ]);
  });
});

describe('PR-lifecycle Executive Overview metrics', () => {
  const ATTRIBUTION = { branches: ['agent/x'], prNumbers: [7], steeredPrNumbers: [] };
  // Merged inside the mocked 2026-01-28..2026-02-04 window.
  const ROWS = [
    { pr_number: 7, head_branch: 'human/renamed', state: 'merged', opened_at: '2026-01-30T00:00:00Z', closed_at: '2026-01-31T12:00:00Z', merged_at: '2026-01-31T12:00:00Z' },
    { pr_number: 8, head_branch: 'agent/x', state: 'merged', opened_at: '2026-01-30T00:00:00Z', closed_at: '2026-02-01T00:00:00Z', merged_at: '2026-02-01T00:00:00Z' },
    { pr_number: 9, head_branch: 'human/one', state: 'merged', opened_at: '2026-01-31T18:00:00Z', closed_at: '2026-02-01T00:00:00Z', merged_at: '2026-02-01T00:00:00Z' },
    { pr_number: 10, head_branch: 'human/two', state: 'closed', opened_at: '2026-01-30T00:00:00Z', closed_at: '2026-02-01T00:00:00Z', merged_at: null },
  ];

  beforeEach(() => {
    mockGetAgentPrAttribution.mockResolvedValue(ATTRIBUTION);
    mockFetchDecidedPullRequests.mockResolvedValue(ROWS);
  });

  it('agent_share_of_merged_prs is agent-merged ÷ all-merged in percentage points', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_share_of_merged_prs', visualization: 'stat', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // 2 agent-attributed of 3 merged → 66.6667pp; prior window empty → priorEmpty.
    expect(body).toEqual({
      type: 'stat',
      value: 66.6667,
      label: 'Agent Share of Merged PRs (%)',
      priorEmpty: true,
    });
  });

  it('agent_vs_human_cycle_time returns the fixed two-item ranking, agent first, in p50 hours', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_vs_human_cycle_time', visualization: 'bar', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // Agent cycles: 36h and 48h → p50 42. Human: single 6h merge → 6.
    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'Agent-shipped', value: 42 },
        { name: 'Human-only', value: 6 },
      ],
    });
  });

  it('agent_vs_human_merge_rate scales both populations to percentage points over the decided cohort', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_vs_human_merge_rate', visualization: 'bar', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // Agent: 2 merged / 2 decided → 100. Human: 1 merged / 2 decided → 50.
    expect(body.items).toEqual([
      { name: 'Agent-shipped', value: 100 },
      { name: 'Human-only', value: 50 },
    ]);
  });

  it('agent_vs_human_* returns an EMPTY ranking when the window has no cohort — never two measured-looking zeros', async () => {
    mockFetchDecidedPullRequests.mockResolvedValue([]);

    const res = await POST(
      makeRequest({ metric: 'agent_vs_human_cycle_time', visualization: 'bar', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();
    expect(body).toEqual({ type: 'ranking', items: [] });
  });

  it('agent_unshipped_spend_share combines total spend with the cost-attribution set', async () => {
    mockGetAgentFleetOverview.mockResolvedValue(OVERVIEW);
    mockGetAgentPrCostAttribution.mockResolvedValue({
      items: [
        { branch: 'agent/x', prNumber: 0, costUsd: 6 },
        { branch: '', prNumber: 7, costUsd: 3 },
      ],
    });

    const res = await POST(
      makeRequest({ metric: 'agent_unshipped_spend_share', visualization: 'stat', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // Attributed 9 of 30 total → 70% unshipped; prior window has no merges,
    // so prior = 1 - 0/24 = 100% and the change is (70-100)/100 = -30%.
    expect(body).toEqual({
      type: 'stat',
      value: 70,
      label: 'Unshipped Spend (%)',
      change: { value: -30, direction: 'down' },
    });
  });

  it('agent_unshipped_spend_share renders unavailable (not a perfect 0%) when there is no spend', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({ ...OVERVIEW, totalCost: { current: 0, prior: 0 } });
    mockGetAgentPrCostAttribution.mockResolvedValue({ items: [] });

    const res = await POST(
      makeRequest({ metric: 'agent_unshipped_spend_share', visualization: 'stat', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(body.unavailable).toEqual({ reason: 'no agent spend in this window' });
    expect(body.change).toBeUndefined();
  });
});
