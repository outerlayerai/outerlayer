/**
 * Tests: POST /api/analytics/widget-data — executive metrics.
 *
 * Four wiring surfaces pinned here (the metric math lives in
 * pr-metrics.test.ts / org-pr-scope.test.ts):
 *  - the steering tiles (tool denial / auto-approved) reading the new
 *    overview fields with the rate→percentage-points scaling;
 *  - total_cost_of_ai combining an ALWAYS-org-scoped metered read with the
 *    ai_cost_config seat spend (via MSW — Supabase is an HTTP boundary),
 *    prorated to the window;
 *  - the PR-plane size/CI widgets reading the new pull_request columns;
 *  - the org scope: `scope: 'org'` sweeps the tenant (no app_id filter) and
 *    matches attribution within repos, so a same-numbered PR in a second
 *    repo is never cross-attributed.
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

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getAgentPrAttribution: mockGetAgentPrAttribution,
    getAgentFleetOverview: mockGetAgentFleetOverview,
    getAgentPrCostAttribution: mockGetAgentPrCostAttribution,
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

const OVERVIEW = {
  sessions: { current: 20, prior: 10 },
  toolErrorRate: { current: 0.1, prior: 0.2 },
  cleanSessionRate: { current: 0.9, prior: 0.8 },
  handsOnRate: { current: 0.3, prior: 0.5 },
  activeActors: { current: 4, prior: 2 },
  totalCost: { current: 30, prior: 24 },
  toolDenialRate: { current: 0.05, prior: 0.1 },
  autoApprovedRate: { current: 0.6, prior: 0.4 },
  modelMix: [],
};

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

let pullRequestUrls: URL[];

function seedPullRequests(rows: Array<Record<string, unknown>>) {
  server.use(
    http.get(`${API}/pull_request`, ({ request }) => {
      pullRequestUrls.push(new URL(request.url));
      return HttpResponse.json(rows);
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pullRequestUrls = [];
  mockGetAgentPrAttribution.mockResolvedValue({
    branches: ['agent/x'],
    prNumbers: [],
    steeredPrNumbers: [],
    items: [],
  });
  mockGetAgentFleetOverview.mockResolvedValue(OVERVIEW);
  mockGetAgentPrCostAttribution.mockResolvedValue({ items: [] });
});

describe('steering tiles (agent_tool_denial_rate / agent_auto_approved_rate)', () => {
  it('scales the denial fraction to percentage points; down reads via the stat card as good', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_tool_denial_rate', visualization: 'stat', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();
    // 0.05 → 5pp vs prior 10pp → -50% change.
    expect(body).toEqual({
      type: 'stat',
      value: 5,
      label: 'Tool Denial Rate (%)',
      change: { value: -50, direction: 'down' },
    });
  });

  it('scales the auto-approved share the same way', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_auto_approved_rate', visualization: 'stat', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();
    expect(body).toEqual({
      type: 'stat',
      value: 60,
      label: 'Auto-Approved Sessions (%)',
      change: { value: 50, direction: 'up' },
    });
  });
});

describe('total_cost_of_ai', () => {
  it('adds window-prorated seat spend to org-scoped metered spend — org scope even without a request scope', async () => {
    server.use(
      http.get(`${API}/ai_cost_config`, () =>
        HttpResponse.json([{ seat_count: 10, cost_per_seat_usd: 100 }])
      )
    );

    const res = await POST(
      makeRequest({ metric: 'total_cost_of_ai', visualization: 'stat', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // Seat portion: 10 × $100 × (8 days ÷ 30.4375) = $262.8337…, identical on
    // both sides — the change indicator moves on metered spend only.
    expect(body).toEqual({
      type: 'stat',
      value: 292.83,
      label: 'Total Cost of AI',
      change: { value: 2.09, direction: 'up' },
    });
    expect(mockGetAgentFleetOverview).toHaveBeenCalledWith(
      mockTenantContext,
      { start: '2026-01-28', end: '2026-02-04' },
      { scope: 'org' }
    );
  });

  it('equals metered spend alone when the tenant never configured seat costs', async () => {
    server.use(http.get(`${API}/ai_cost_config`, () => HttpResponse.json([])));

    const res = await POST(
      makeRequest({ metric: 'total_cost_of_ai', visualization: 'stat', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();
    expect(body).toEqual({
      type: 'stat',
      value: 30,
      label: 'Total Cost of AI',
      change: { value: 25, direction: 'up' },
    });
  });
});

describe('PR size + first-pass CI widgets', () => {
  it('pr_size_trend: daily median lines changed over ALL merges, unknown sizes skipped', async () => {
    seedPullRequests([
      prRow({ pr_number: 1, additions: 100, deletions: 50 }),
      prRow({ pr_number: 2, head_branch: 'human/y', additions: 20, deletions: 10 }),
      // Unknown size — never a zero sample.
      prRow({ pr_number: 3, head_branch: 'human/z', additions: null, deletions: null }),
    ]);

    const res = await POST(
      makeRequest({ metric: 'pr_size_trend', visualization: 'line', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();
    expect(body).toEqual({
      type: 'timeSeries',
      series: [{ name: 'Median lines changed', data: [{ x: '2026-01-30', y: 90 }] }],
    });
  });

  it('agent_vs_human_first_pass_ci: fixed two-item ranking in percentage points over measured rows', async () => {
    seedPullRequests([
      prRow({ pr_number: 1, first_ci_status: 'failure' }),
      prRow({ pr_number: 2, head_branch: 'agent/x', first_ci_status: 'success' }),
      prRow({ pr_number: 3, head_branch: 'human/y', first_ci_status: 'success' }),
      // Unmeasured — excluded from both denominators.
      prRow({ pr_number: 4, head_branch: 'human/z', first_ci_status: null }),
    ]);

    const res = await POST(
      makeRequest({ metric: 'agent_vs_human_first_pass_ci', visualization: 'bar', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();
    expect(body).toEqual({
      type: 'ranking',
      items: [
        { name: 'Agent-shipped', value: 50 },
        { name: 'Human-only', value: 0 },
      ],
    });
  });

  it('agent_vs_human_pr_size returns an EMPTY ranking when no merged row carries size data', async () => {
    seedPullRequests([prRow({ pr_number: 1, additions: null, deletions: null })]);

    const res = await POST(
      makeRequest({ metric: 'agent_vs_human_pr_size', visualization: 'bar', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();
    expect(body).toEqual({ type: 'ranking', items: [] });
  });
});

describe('org scope (scope: "org")', () => {
  it('sweeps the tenant (no app_id filter) and matches attribution within repos — a same-numbered PR in another repo is never cross-attributed', async () => {
    // Two repos, both with merged PR #1 on branch agent/x; sessions only
    // touched repo-a. App scope would blur these; org scope must not.
    server.use(
      http.get(`${API}/pull_request`, ({ request }) => {
        pullRequestUrls.push(new URL(request.url));
        return HttpResponse.json([
          { app_id: 'app-a', ...prRow({ pr_number: 1 }) },
          { app_id: 'app-b', ...prRow({ pr_number: 1 }) },
        ]);
      }),
      http.get(`${API}/git_connection`, () =>
        HttpResponse.json([
          { app_id: 'app-a', repository: 'acme/repo-a' },
          { app_id: 'app-b', repository: 'acme/repo-b' },
        ])
      )
    );
    mockGetAgentPrAttribution.mockResolvedValue({
      branches: ['agent/x'],
      prNumbers: [],
      steeredPrNumbers: [],
      // Sessions report the host-qualified repo — the normalizer reconciles.
      items: [{ repo: 'github.com/acme/repo-a', branch: 'agent/x', prNumber: 0, steered: false }],
    });

    const res = await POST(
      makeRequest({
        metric: 'agent_share_of_merged_prs',
        visualization: 'stat',
        timeRange: { preset: '7d' },
        scope: 'org',
      })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 2 merges org-wide, exactly one attributable → 50%.
    expect(body).toEqual(
      expect.objectContaining({ type: 'stat', value: 50, label: 'Agent Share of Merged PRs (%)' })
    );
    // The attribution query itself ran org-scoped…
    expect(mockGetAgentPrAttribution).toHaveBeenCalledWith(mockTenantContext, { scope: 'org' });
    // …and the PR read swept the tenant, not one app.
    const params = pullRequestUrls[0]!.searchParams;
    expect(params.get('tenant_id')).toBe('eq.tenant-456');
    expect(params.get('app_id')).toBeNull();
    expect(params.get('select')).toContain('app_id');
  });
});
