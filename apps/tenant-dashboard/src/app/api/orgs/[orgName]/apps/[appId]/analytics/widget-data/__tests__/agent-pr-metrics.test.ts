/**
 * Tests: POST /api/analytics/widget-data — Agent PR-lifecycle metrics
 * (agent_pr_merge_rate, agent_pr_cycle_time_trend).
 *
 * These metrics are the route's first Postgres-backed widgets: the
 * `pull_request` table is the lifecycle source of truth (read through MSW
 * here — no client mocks, per app testing rules), while ClickHouse
 * contributes only the session→PR attribution set (`getAgentPrAttribution`,
 * mocked at the service seam like every other fleet method). The metric
 * math itself is pinned in `pr-metrics.test.ts`; this file pins the WIRING:
 * the fetch window (prior-period start, decided-only rows, tenant/app
 * scoping), the fraction→percentage-points scaling + change math, and the
 * fixed response shapes.
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

const mockGetAgentPrAttribution = vi.fn();
const mockGetAgentFleetOverview = vi.fn();
const mockGetAgentPrCostAttribution = vi.fn();
let serviceHasAttributionMethod = true;

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () =>
    serviceHasAttributionMethod
      ? {
          getAgentPrAttribution: mockGetAgentPrAttribution,
          getAgentFleetOverview: mockGetAgentFleetOverview,
          getAgentPrCostAttribution: mockGetAgentPrCostAttribution,
        }
      : {},
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

import { http, HttpResponse } from 'msw';
import { server } from '@/test-helpers/msw-server';
import { POST } from '../route';

const API = 'http://localhost:54321/rest/v1';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/analytics/widget-data?appId=app-789', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function prRow(over: Record<string, unknown>) {
  return {
    pr_number: 1,
    head_branch: 'agent/x',
    state: 'merged',
    opened_at: '2026-01-29T09:00:00+00:00',
    closed_at: '2026-01-30T09:00:00+00:00',
    merged_at: '2026-01-30T09:00:00+00:00',
    ...over,
  };
}

let fetchedUrls: URL[];

function seedPullRequests(rows: Array<Record<string, unknown>>) {
  server.use(
    http.get(`${API}/pull_request`, ({ request }) => {
      fetchedUrls.push(new URL(request.url));
      return HttpResponse.json(rows);
    })
  );
}

const ATTRIBUTION = { branches: ['agent/x'], prNumbers: [512] };

beforeEach(() => {
  vi.clearAllMocks();
  fetchedUrls = [];
  serviceHasAttributionMethod = true;
  mockGetAgentPrAttribution.mockResolvedValue(ATTRIBUTION);
  mockGetAgentFleetOverview.mockResolvedValue({ totalCost: { current: 0, prior: 0 } });
  mockGetAgentPrCostAttribution.mockResolvedValue({ items: [] });
});

describe('POST /api/analytics/widget-data (agent_pr_merge_rate)', () => {
  it('computes the decided-cohort rate in percentage points with prior-period change', async () => {
    seedPullRequests([
      // current window (Jan 28 – Feb 4): 1 merged + 1 closed-unmerged agent PR → 50
      prRow({ pr_number: 1 }),
      prRow({
        pr_number: 512, // attributed via pr-link even though the branch is human
        head_branch: 'human/refactor',
        state: 'closed',
        merged_at: null,
        closed_at: '2026-02-01T12:00:00+00:00',
      }),
      // human PR in the current window: excluded from the cohort
      prRow({ pr_number: 7, head_branch: 'human/docs' }),
      // prior window (Jan 20–27): 1 merged agent PR → 100
      prRow({ pr_number: 3, closed_at: '2026-01-22T09:00:00+00:00', merged_at: '2026-01-22T09:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_pr_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 50 vs prior 100 → change -50%, down.
    expect(body).toEqual({
      type: 'stat',
      value: 50,
      label: 'Agent PR Merge Rate',
      change: { value: -50, direction: 'down' },
    });
    expect(mockGetAgentPrAttribution).toHaveBeenCalledTimes(1);
    expect(mockGetAgentPrAttribution).toHaveBeenCalledWith(mockTenantContext, undefined);
  });

  it('fetches only decided rows from the PRIOR window start, scoped to the verified tenant/app', async () => {
    seedPullRequests([]);

    await POST(makeRequest({ metric: 'agent_pr_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });

    expect(fetchedUrls).toHaveLength(1);
    const params = fetchedUrls[0]!.searchParams;
    expect(params.get('tenant_id')).toBe('eq.tenant-456');
    expect(params.get('app_id')).toBe('eq.app-789');
    expect(params.get('state')).toBe('neq.open');
    // Window Jan 28 – Feb 4 → prior window starts Jan 20 (equal length).
    expect(params.get('closed_at')).toBe('gte.2026-01-20T00:00:00Z');
    expect(params.get('select')).toBe(
      'pr_number,head_branch,state,opened_at,closed_at,merged_at,ready_for_review_at,first_review_at,first_approved_at,reopen_count,reverted_at,additions,deletions,changed_files,first_ci_status',
    );
    expect(params.get('limit')).toBe('5000');
  });

  it('returns 0 with a flat change when nothing was decided in either window', async () => {
    seedPullRequests([]);

    const res = await POST(makeRequest({ metric: 'agent_pr_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'Agent PR Merge Rate',
      change: { value: 0, direction: 'flat' },
    });
  });

  it('an empty prior cohort yields priorEmpty and NO change (never a fabricated +100%)', async () => {
    // One merged agent PR in the current window; nothing decided in the prior.
    seedPullRequests([prRow({ pr_number: 1 })]);

    const res = await POST(makeRequest({ metric: 'agent_pr_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 100,
      label: 'Agent PR Merge Rate',
      priorEmpty: true,
    });
  });
});

describe('POST /api/analytics/widget-data (agent_pr_cycle_time_trend)', () => {
  it('returns daily P50/P95 cycle-time hours by merge date as a fixed time series', async () => {
    seedPullRequests([
      // Jan 30: 24h and 48h cycle times → p50 36, p95 46.8
      prRow({ pr_number: 1, opened_at: '2026-01-29T09:00:00+00:00', merged_at: '2026-01-30T09:00:00+00:00', closed_at: '2026-01-30T09:00:00+00:00' }),
      prRow({ pr_number: 2, opened_at: '2026-01-28T10:00:00+00:00', merged_at: '2026-01-30T10:00:00+00:00', closed_at: '2026-01-30T10:00:00+00:00' }),
      // Feb 1: single 6h merge
      prRow({ pr_number: 3, opened_at: '2026-02-01T03:00:00+00:00', merged_at: '2026-02-01T09:00:00+00:00', closed_at: '2026-02-01T09:00:00+00:00' }),
      // human merge the same day: excluded
      prRow({ pr_number: 4, head_branch: 'human/docs', opened_at: '2026-02-01T00:00:00+00:00', merged_at: '2026-02-01T09:00:00+00:00', closed_at: '2026-02-01T09:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_pr_cycle_time_trend', timeRange: { preset: '7d' } }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'P50', data: [{ x: '2026-01-30', y: 36 }, { x: '2026-02-01', y: 6 }] },
        { name: 'P95', data: [{ x: '2026-01-30', y: 46.8 }, { x: '2026-02-01', y: 6 }] },
      ],
    });
  });
});

describe('POST /api/analytics/widget-data (agent_pr_cycle_time_breakdown)', () => {
  it('returns per-phase median hours as an ordered ranking (coding → pickup → review → merge)', async () => {
    seedPullRequests([
      // coding 2h / pickup 4h / review 4h / merge 2h
      prRow({
        pr_number: 1,
        opened_at: '2026-01-30T00:00:00+00:00',
        ready_for_review_at: '2026-01-30T02:00:00+00:00',
        first_review_at: '2026-01-30T06:00:00+00:00',
        first_approved_at: '2026-01-30T10:00:00+00:00',
        merged_at: '2026-01-30T12:00:00+00:00',
        closed_at: '2026-01-30T12:00:00+00:00',
      }),
      // coding 4h / pickup 6h / review 8h / merge 4h
      prRow({
        pr_number: 2,
        opened_at: '2026-01-31T00:00:00+00:00',
        ready_for_review_at: '2026-01-31T04:00:00+00:00',
        first_review_at: '2026-01-31T10:00:00+00:00',
        first_approved_at: '2026-01-31T18:00:00+00:00',
        merged_at: '2026-01-31T22:00:00+00:00',
        closed_at: '2026-01-31T22:00:00+00:00',
      }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_pr_cycle_time_breakdown', timeRange: { preset: '7d' }, visualization: 'bar' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'Coding', value: 3 },
        { name: 'Pickup', value: 5 },
        { name: 'Review', value: 6 },
        { name: 'Merge', value: 3 },
      ],
    });
  });

  it('returns an empty ranking (→ empty state) when no agent PR reached any phase', async () => {
    seedPullRequests([]);

    const res = await POST(makeRequest({ metric: 'agent_pr_cycle_time_breakdown', timeRange: { preset: '7d' }, visualization: 'bar' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({ type: 'ranking', items: [] });
  });
});

describe('POST /api/analytics/widget-data (agent_cost_per_merged_pr)', () => {
  it('divides total agent spend by merged-PR count with prior-period change', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({ totalCost: { current: 100, prior: 40 } });
    seedPullRequests([
      // current window (Jan 28 – Feb 4): 2 merged agent PRs → 100/2 = 50
      prRow({ pr_number: 1, merged_at: '2026-01-30T09:00:00+00:00', closed_at: '2026-01-30T09:00:00+00:00' }),
      prRow({ pr_number: 2, merged_at: '2026-02-01T09:00:00+00:00', closed_at: '2026-02-01T09:00:00+00:00' }),
      // prior window (Jan 20–27): 1 merged agent PR → 40/1 = 40
      prRow({ pr_number: 3, merged_at: '2026-01-22T09:00:00+00:00', closed_at: '2026-01-22T09:00:00+00:00' }),
      // non-agent merged in window: excluded from the denominator
      prRow({ pr_number: 7, head_branch: 'human/docs', merged_at: '2026-01-30T09:00:00+00:00', closed_at: '2026-01-30T09:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_cost_per_merged_pr', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 50 vs prior 40 → +25%, up.
    expect(body).toEqual({
      type: 'stat',
      value: 50,
      label: 'Cost per Merged PR',
      change: { value: 25, direction: 'up' },
    });
  });

  it('renders unavailable (not $0) when there is spend but nothing merged this window', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({ totalCost: { current: 25, prior: 10 } });
    seedPullRequests([
      // only a prior-window merge — current window has zero merged agent PRs
      prRow({ pr_number: 1, merged_at: '2026-01-22T09:00:00+00:00', closed_at: '2026-01-22T09:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_cost_per_merged_pr', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'Cost per Merged PR',
      unavailable: { reason: 'agent spend, no PRs merged yet' },
    });
  });

  it('distinguishes "no agent PRs merged" from "spend, none merged" when there is also no spend', async () => {
    mockGetAgentFleetOverview.mockResolvedValue({ totalCost: { current: 0, prior: 0 } });
    seedPullRequests([]);

    const res = await POST(makeRequest({ metric: 'agent_cost_per_merged_pr', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'Cost per Merged PR',
      unavailable: { reason: 'no agent PRs merged in this window' },
    });
  });
});

describe('POST /api/analytics/widget-data (agent_direct_cost_per_merged_pr)', () => {
  it('divides ATTRIBUTED spend by merged-PR count, explicit-link and branch, with prior-period change', async () => {
    mockGetAgentPrCostAttribution.mockResolvedValue({
      items: [
        { branch: 'agent/x', prNumber: 0, costUsd: 30 }, // branch → current PR #1
        { branch: 'irrelevant', prNumber: 512, costUsd: 12 }, // explicit #512 → prior PR #512
      ],
    });
    seedPullRequests([
      // current window: PR #1 on agent/x, merged → 30 / 1 = 30
      prRow({ pr_number: 1, head_branch: 'agent/x', merged_at: '2026-01-30T09:00:00+00:00', closed_at: '2026-01-30T09:00:00+00:00' }),
      // prior window: PR #512 (agent via pr-link) on a distinct branch → 12 / 1 = 12
      prRow({ pr_number: 512, head_branch: 'feature/prior', merged_at: '2026-01-22T09:00:00+00:00', closed_at: '2026-01-22T09:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_direct_cost_per_merged_pr', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 30 vs prior 12 → +150%, up.
    expect(body).toEqual({
      type: 'stat',
      value: 30,
      label: 'Attributed Cost per Merged PR',
      change: { value: 150, direction: 'up' },
    });
  });

  it('renders unavailable (not $0) when no agent PR merged this window', async () => {
    mockGetAgentPrCostAttribution.mockResolvedValue({ items: [{ branch: 'agent/x', prNumber: 0, costUsd: 40 }] });
    seedPullRequests([
      // only a prior-window merge
      prRow({ pr_number: 1, head_branch: 'agent/x', merged_at: '2026-01-22T09:00:00+00:00', closed_at: '2026-01-22T09:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_direct_cost_per_merged_pr', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'Attributed Cost per Merged PR',
      unavailable: { reason: 'no agent PRs merged in this window' },
    });
  });
});

describe('POST /api/analytics/widget-data (agent_pr_unreviewed_merge_rate)', () => {
  it('returns the share of merged agent PRs with no human review/approval, as a percentage with change', async () => {
    seedPullRequests([
      // current window: 1 merged agent PR, unreviewed (no review/approval milestone) → 100%
      prRow({ pr_number: 1, merged_at: '2026-01-30T09:00:00+00:00', closed_at: '2026-01-30T09:00:00+00:00' }),
      // prior window: 2 merged agent PRs, 1 unreviewed → 50%
      prRow({ pr_number: 2, merged_at: '2026-01-22T09:00:00+00:00', closed_at: '2026-01-22T09:00:00+00:00' }),
      prRow({ pr_number: 3, merged_at: '2026-01-23T09:00:00+00:00', closed_at: '2026-01-23T09:00:00+00:00', first_review_at: '2026-01-23T08:00:00+00:00' }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_pr_unreviewed_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 100 (current) vs 50 (prior) → +100%, up (the card renders up as BAD for this metric).
    expect(body).toEqual({
      type: 'stat',
      value: 100,
      label: 'Merged Without Review (%)',
      change: { value: 100, direction: 'up' },
    });
  });
});

describe('POST /api/analytics/widget-data (agent_pr_reopen_rate)', () => {
  it('returns the share of decided agent PRs reopened at least once, as a percentage with change', async () => {
    seedPullRequests([
      // current window: 1 decided agent PR, reopened → 100%
      prRow({ pr_number: 1, closed_at: '2026-01-30T09:00:00+00:00', reopen_count: 1 }),
      // prior window: 2 decided, 1 reopened → 50%
      prRow({ pr_number: 2, closed_at: '2026-01-22T09:00:00+00:00', reopen_count: 1 }),
      prRow({ pr_number: 3, closed_at: '2026-01-23T09:00:00+00:00', reopen_count: 0 }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_pr_reopen_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 100 (current) vs 50 (prior) → +100%, up (the card renders up as BAD for this metric).
    expect(body).toEqual({
      type: 'stat',
      value: 100,
      label: 'PR Reopen Rate (%)',
      change: { value: 100, direction: 'up' },
    });
  });
});

describe('POST /api/analytics/widget-data (agent_pr_revert_rate)', () => {
  it('returns the share of decided agent PRs later reverted, as a percentage with change', async () => {
    seedPullRequests([
      // current window: 1 decided agent PR, reverted → 100%
      prRow({ pr_number: 1, closed_at: '2026-01-30T09:00:00+00:00', reverted_at: '2026-02-01T09:00:00+00:00' }),
      // prior window: 2 decided, 1 reverted → 50%
      prRow({ pr_number: 2, closed_at: '2026-01-22T09:00:00+00:00', reverted_at: '2026-01-24T09:00:00+00:00' }),
      prRow({ pr_number: 3, closed_at: '2026-01-23T09:00:00+00:00', reverted_at: null }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_pr_revert_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 100 (current) vs 50 (prior) → +100%, up (the card renders up as BAD for this metric).
    expect(body).toEqual({
      type: 'stat',
      value: 100,
      label: 'Revert Rate (%)',
      change: { value: 100, direction: 'up' },
    });
  });
});

describe('POST /api/analytics/widget-data (agent_clean_job_rate)', () => {
  it('returns the share of decided agent PRs that merged, held, AND needed no steering', async () => {
    // PR 2 was steered (a linked session had > 1 user turn) → not a clean job.
    mockGetAgentPrAttribution.mockResolvedValue({ branches: ['agent/x'], prNumbers: [], steeredPrNumbers: [2] });
    seedPullRequests([
      // current window: PR 1 clean (merged, held, unsteered); PR 2 steered; PR 3 reverted
      prRow({ pr_number: 1, closed_at: '2026-01-30T09:00:00+00:00', state: 'merged', reverted_at: null }),
      prRow({ pr_number: 2, closed_at: '2026-01-30T09:00:00+00:00', state: 'merged', reverted_at: null }),
      prRow({ pr_number: 3, closed_at: '2026-01-30T09:00:00+00:00', state: 'merged', reverted_at: '2026-02-01T00:00:00+00:00' }),
      // prior window: 1 decided, 1 clean → 100%
      prRow({ pr_number: 4, closed_at: '2026-01-22T09:00:00+00:00', state: 'merged', reverted_at: null }),
    ]);

    const res = await POST(makeRequest({ metric: 'agent_clean_job_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // current: 3 decided, 1 clean → 33.3333%; prior: 100% → down (fewer clean jobs).
    // Up = good for this metric, so it is NOT in INVERTED_CHANGE_METRICS.
    expect(body).toEqual({
      type: 'stat',
      value: 33.3333,
      label: 'Clean Job Rate (%)',
      change: { value: -66.67, direction: 'down' },
    });
  });
});

describe('POST /api/analytics/widget-data (agent PR metrics — failure modes)', () => {
  it('returns a 500 with a clear message when the service lacks getAgentPrAttribution', async () => {
    serviceHasAttributionMethod = false;
    seedPullRequests([]);

    const res = await POST(makeRequest({ metric: 'agent_pr_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Agent PR metrics are not available in this environment.' });
    expect(fetchedUrls).toHaveLength(0); // never reaches Postgres
  });

  it('surfaces a pull_request read failure instead of rendering an empty widget', async () => {
    server.use(
      http.get(`${API}/pull_request`, () =>
        HttpResponse.json({ message: 'permission denied', code: '42501' }, { status: 403 })
      )
    );

    const res = await POST(makeRequest({ metric: 'agent_pr_merge_rate', timeRange: { preset: '7d' }, visualization: 'stat' }), { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'pull_request read failed: permission denied' });
  });
});
