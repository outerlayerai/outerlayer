/**
 * Tests: POST /api/analytics/widget-data — score-outcome
 * correlation metrics (`agent_pr_outcome_by_score_*`). Math is pinned in
 * pr-metrics.test.ts (`computeAgentPrOutcomeByScore`); these tests pin the
 * ROUTE's contract: `scoreName` is required, org scope is rejected, a
 * missing predictor-score capability surfaces as a clear error, and the
 * response is a SINGLE lift stat (pass cohort minus fail cohort) labeled
 * with the scoreName — not a two-item ranking. A two-bar "Pass 100% / Fail
 * 50%" chart reads as if the numbers should sum to 100 (they're independent
 * rates, not a split of one total), so this widget shows one signed number
 * instead. Both cohorts must be populated for a lift to mean anything — an
 * empty cohort defaults to rate 0 in pr-metrics.ts, and printing "+100pp"
 * against that would be a confidently wrong number, not an honest unknown.
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

vi.mock('@/lib/analytics', () => ({
  getAnalyticsService: () => ({
    getAgentPrAttribution: mockGetAgentPrAttribution,
  }),
  parseDateRange: (_preset: string) => ({ start: '2026-01-28', end: '2026-02-04' }),
}));

const mockFetchDecidedPullRequests = vi.fn();
vi.mock('@/lib/system/pr-tracking/pr-lifecycle-read', () => ({
  fetchDecidedPullRequests: (...args: unknown[]) => mockFetchDecidedPullRequests(...args),
}));

const mockGetPredictorScoreVerdictsByPr = vi.fn();
vi.mock('@/lib/system/pr-outcome-correlation/service', () => ({
  getPredictorScoreVerdictsByPr: (...args: unknown[]) => mockGetPredictorScoreVerdictsByPr(...args),
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

const ATTRIBUTION = { branches: ['agent/x'], prNumbers: [], steeredPrNumbers: [] };
// Agent PRs decided inside the mocked 2026-01-28..2026-02-04 window:
//  - pass cohort: PR1 merged (36h cycle) → mergeRate 100%.
//  - fail cohort: PR2 merged (12h cycle) + PR3 closed-unmerged → mergeRate 50%.
// Lift (pass − fail): merge rate +50pp, cycle time +24h.
const ROWS = [
  { pr_number: 1, head_branch: 'agent/x', state: 'merged', opened_at: '2026-01-30T00:00:00Z', closed_at: '2026-01-31T12:00:00Z', merged_at: '2026-01-31T12:00:00Z' },
  { pr_number: 2, head_branch: 'agent/x', state: 'merged', opened_at: '2026-01-30T00:00:00Z', closed_at: '2026-01-30T12:00:00Z', merged_at: '2026-01-30T12:00:00Z' },
  { pr_number: 3, head_branch: 'agent/x', state: 'closed', opened_at: '2026-01-30T00:00:00Z', closed_at: '2026-01-30T12:00:00Z', merged_at: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentPrAttribution.mockResolvedValue(ATTRIBUTION);
  mockFetchDecidedPullRequests.mockResolvedValue(ROWS);
});

describe('agent_pr_outcome_by_score_*', () => {
  it('requires scoreName — there is no default predictor to fall back to', async () => {
    const res = await POST(
      makeRequest({ metric: 'agent_pr_outcome_by_score_merge_rate', visualization: 'stat', timeRange: { preset: '7d' } }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect((res as any).status).toBe(500);
    const body = await (res as any).json();
    expect(body.error).toMatch(/scoreName/);
    expect(mockGetPredictorScoreVerdictsByPr).not.toHaveBeenCalled();
  });

  it('rejects org scope — the predictor-score join is app-scoped only', async () => {
    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'judge.task_alignment',
        scope: 'org',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect((res as any).status).toBe(500);
    const body = await (res as any).json();
    expect(body.error).toMatch(/org scope/);
  });

  it.each(['worker.merged', 'worker.reverted'])(
    'rejects %s with an explanation rather than rendering an empty tile — it records the outcome, so predicting the outcome with it is circular',
    async (fateName) => {
      const res = await POST(
        makeRequest({
          metric: 'agent_pr_outcome_by_score_merge_rate',
          visualization: 'stat',
          scoreName: fateName,
          timeRange: { preset: '7d' },
        }) as any
      , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
      expect((res as any).status).toBe(500);
      const body = await (res as any).json();
      expect(body.error).toMatch(/can't also be used to predict it/);
      expect(mockGetPredictorScoreVerdictsByPr).not.toHaveBeenCalled();
    },
  );

  it('does NOT reject worker.ci_green — it is decided before the PR is, so it is a legitimate predictor', async () => {
    mockGetPredictorScoreVerdictsByPr.mockResolvedValue(new Map([[1, true], [2, false], [3, false]]));

    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'worker.ci_green',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(body).toEqual({
      type: 'stat',
      value: 50,
      label: 'worker.ci_green: Merge-Rate Lift (Pass − Fail)',
      caption: '1 passing vs 2 failing PRs',
    });
  });

  it('surfaces a clear error when the predictor-score capability is unavailable (no ClickHouse configured)', async () => {
    mockGetPredictorScoreVerdictsByPr.mockResolvedValue(null);

    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'judge.task_alignment',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    expect((res as any).status).toBe(500);
    const body = await (res as any).json();
    expect(body.error).toMatch(/not available/);
  });

  it('returns the merge-rate LIFT (pass minus fail), in percentage points, labeled with the scoreName', async () => {
    mockGetPredictorScoreVerdictsByPr.mockResolvedValue(
      new Map([
        [1, true],
        [2, false],
        [3, false],
      ]),
    );

    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'judge.task_alignment',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // Pass mergeRate 100, fail mergeRate 50 → lift +50pp. A SINGLE signed
    // number, not two bars a reader has to subtract themselves.
    expect(body).toEqual({
      type: 'stat',
      value: 50,
      label: 'judge.task_alignment: Merge-Rate Lift (Pass − Fail)',
      // The sample size the headline "+50pp" hides — decided-cohort counts
      // (pass = 1 decided PR, fail = 2). Without this a 3-PR lift looks as
      // authoritative as a 300-PR one.
      caption: '1 passing vs 2 failing PRs',
    });
    expect(mockGetPredictorScoreVerdictsByPr).toHaveBeenCalledWith({
      tenantId: 'tenant-456',
      appId: 'app-789',
      scoreName: 'judge.task_alignment',
    });
  });

  it('returns the cycle-time LIFT (pass minus fail) in hours for agent_pr_outcome_by_score_cycle_time', async () => {
    mockGetPredictorScoreVerdictsByPr.mockResolvedValue(
      new Map([
        [1, true],
        [2, false],
        [3, false],
      ]),
    );

    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_cycle_time',
        visualization: 'stat',
        scoreName: 'judge.task_alignment',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    // Pass cycle 36h, fail cycle 12h → lift +24h (passing predicts SLOWER
    // here — the sign is data, not assumed-good).
    expect(body).toEqual({
      type: 'stat',
      value: 24,
      label: 'judge.task_alignment: Cycle-Time Lift (Pass − Fail)',
      // Cycle-time cohort is the MERGED subset (pass 1 merged, fail 1 merged),
      // so the unit says "merged PRs" — matching what the metric counted.
      caption: '1 passing vs 1 failing merged PRs',
    });
  });

  it('marks the tile unavailable — never a confidently wrong number — when NEITHER cohort has a verdict', async () => {
    mockGetPredictorScoreVerdictsByPr.mockResolvedValue(new Map());

    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'judge.task_alignment',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'judge.task_alignment: Merge-Rate Lift (Pass − Fail)',
      unavailable: { reason: '0 passing, 0 failing — need both to compare' },
    });
  });

  it('reports the two cohort COUNTS when only one side has verdicts — an empty cohort defaults to rate 0 in pr-metrics.ts, so a lift against it would be confidently wrong; the counts say how close the tile is to filling in', async () => {
    // Every PR verdicts "pass" — the fail cohort is empty, not 0%. This is
    // the common default-template state on a repo whose agent PRs all pass
    // CI first try, so the tile must read as "here's what I have".
    mockGetPredictorScoreVerdictsByPr.mockResolvedValue(
      new Map([
        [1, true],
        [2, true],
        [3, true],
      ]),
    );

    const res = await POST(
      makeRequest({
        metric: 'agent_pr_outcome_by_score_merge_rate',
        visualization: 'stat',
        scoreName: 'judge.task_alignment',
        timeRange: { preset: '7d' },
      }) as any
    , { params: Promise.resolve({ orgName: 'test-org', appId: 'app-789' }) });
    const body = await (res as any).json();

    expect(body).toEqual({
      type: 'stat',
      value: 0,
      label: 'judge.task_alignment: Merge-Rate Lift (Pass − Fail)',
      unavailable: { reason: '3 passing, 0 failing — need both to compare' },
    });
  });
});
