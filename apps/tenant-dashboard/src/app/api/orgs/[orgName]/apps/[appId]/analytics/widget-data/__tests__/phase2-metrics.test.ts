/**
 * Tests: POST /api/analytics/widget-data — Autonomy Ladder.
 *
 * Pins the wiring (the classification math lives in pr-metrics.test.ts and
 * the SQL cut points in observability-service's tests): the ladder widgets
 * fetch the ladder attribution set and reduce it against merged PRs; the
 * delegated-share tile goes `unavailable` on an empty classified cohort
 * (never a confident 0%).
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
const mockGetAutonomyLadderAttribution = vi.fn();

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getAgentPrAttribution: mockGetAgentPrAttribution,
    getAutonomyLadderAttribution: mockGetAutonomyLadderAttribution,
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

function seedPullRequests(rows: Array<Record<string, unknown>>) {
  server.use(http.get(`${API}/pull_request`, () => HttpResponse.json(rows)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentPrAttribution.mockResolvedValue({
    branches: ['agent/x'],
    prNumbers: [],
    steeredPrNumbers: [],
    items: [],
  });
  mockGetAutonomyLadderAttribution.mockResolvedValue({ items: [] });
});

describe('agent_shipped_autonomy_trend', () => {
  it('classifies merged PRs at the min matched level into four fixed stacked series', async () => {
    seedPullRequests([
      prRow({ pr_number: 1 }), // agent/x → min(3, 2) = supervised
      prRow({ pr_number: 2, head_branch: 'cloud/y', merged_at: '2026-01-31T09:00:00+00:00', closed_at: '2026-01-31T09:00:00+00:00' }),
    ]);
    mockGetAutonomyLadderAttribution.mockResolvedValue({
      items: [
        { repo: 'acme/api', branch: 'agent/x', prNumber: 0, minLevel: 3, classifiedSessions: 2 },
        { repo: 'acme/api', branch: 'agent/x', prNumber: 0, minLevel: 2, classifiedSessions: 1 },
        { repo: 'acme/api', branch: 'cloud/y', prNumber: 0, minLevel: 4, classifiedSessions: 1 },
      ],
    });

    const res = await POST(
      makeRequest({ metric: 'agent_shipped_autonomy_trend', visualization: 'area', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'timeSeries',
      series: [
        { name: 'Assisted', data: [{ x: '2026-01-30', y: 0 }, { x: '2026-01-31', y: 0 }] },
        { name: 'Supervised', data: [{ x: '2026-01-30', y: 1 }, { x: '2026-01-31', y: 0 }] },
        { name: 'Delegated', data: [{ x: '2026-01-30', y: 0 }, { x: '2026-01-31', y: 0 }] },
        { name: 'Autonomous', data: [{ x: '2026-01-30', y: 0 }, { x: '2026-01-31', y: 1 }] },
      ],
    });
    expect(mockGetAutonomyLadderAttribution).toHaveBeenCalledWith(mockTenantContext, undefined);
  });
});

describe('agent_delegated_share', () => {
  it('computes the delegated+ share over CLASSIFIED merged PRs in percentage points', async () => {
    seedPullRequests([
      prRow({ pr_number: 1 }), // delegated
      prRow({ pr_number: 2, head_branch: 'agent/z' }), // assisted
      prRow({ pr_number: 3, head_branch: 'human/unmatched' }), // unclassified — out of the denominator
    ]);
    mockGetAutonomyLadderAttribution.mockResolvedValue({
      items: [
        { repo: 'acme/api', branch: 'agent/x', prNumber: 0, minLevel: 3, classifiedSessions: 1 },
        { repo: 'acme/api', branch: 'agent/z', prNumber: 0, minLevel: 1, classifiedSessions: 1 },
      ],
    });

    const res = await POST(
      makeRequest({ metric: 'agent_delegated_share', visualization: 'stat', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    // 1 of 2 classified at delegated+ → 50; the unclassified PR never dilutes it.
    expect(body).toEqual(
      expect.objectContaining({ type: 'stat', value: 50, label: 'Delegated+ Share of Merged PRs (%)' })
    );
  });

  it('renders unavailable (not 0%) when nothing classifiable merged', async () => {
    seedPullRequests([prRow({ pr_number: 3, head_branch: 'human/unmatched' })]);

    const res = await POST(
      makeRequest({ metric: 'agent_delegated_share', visualization: 'stat', timeRange: { preset: '7d' } })
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await res.json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'Delegated+ Share of Merged PRs (%)',
      unavailable: { reason: 'no classifiable merged PRs in this window' },
    });
  });
});
