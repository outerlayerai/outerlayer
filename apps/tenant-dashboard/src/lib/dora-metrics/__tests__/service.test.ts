// ---------------------------------------------------------------------------
// DoraMetricsService - Unit Tests
//
// Tests the service layer logic: metric computation, trend bucketing, and
// ranking. The Supabase client is fully mocked. We mock `resolveTimeRange`
// so tests are deterministic and do not depend on the current date.
//
// NOTE: The service queries `platform_deployment` (our platform's CI/CD
// deployments) and `platform_incident` (incidents correlated with
// deployments), NOT the user-facing `deployment` table.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDoraMetricsService } from '../service';
import { ROW_LIMIT } from '../constants';

// ---------------------------------------------------------------------------
// Mock resolveTimeRange so every test uses fixed, predictable dates.
// ---------------------------------------------------------------------------

vi.mock('../validation', () => ({
  resolveTimeRange: vi.fn(),
}));

import { resolveTimeRange } from '../validation';

const mockedResolveTimeRange = vi.mocked(resolveTimeRange);

// ---------------------------------------------------------------------------
// Row type matching the shape the service expects internally
// ---------------------------------------------------------------------------

interface PlatformDeploymentRow {
  id: string;
  service: string;
  environment: string;
  status: string;
  commit_sha: string | null;
  commit_message: string | null;
  branch: string | null;
  failure_reason: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  pipeline_url: string | null;
  first_commit_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

interface PlatformIncidentRow {
  id: string;
  service: string | null;
  status: string;
  deployment_id: string | null;
  started_at: string;
  resolved_at: string | null;
  resolution_ms: number | null;
}

// ---------------------------------------------------------------------------
// Fixed dates used across tests
//
// Current period:  2026-01-18 -> 2026-02-17 (30 days)
// Previous period: 2025-12-19 -> 2026-01-18 (30 days)
// ---------------------------------------------------------------------------

const FIXED_END = new Date('2026-02-17T00:00:00.000Z');
const FIXED_START = new Date('2026-01-18T00:00:00.000Z');
const FIXED_PREV_END = new Date('2026-01-18T00:00:00.000Z');
const FIXED_PREV_START = new Date('2025-12-19T00:00:00.000Z');

// 7-day window for trend tests
const FIXED_7D_START = new Date('2026-02-10T00:00:00.000Z');
const FIXED_7D_END = new Date('2026-02-17T00:00:00.000Z');
const FIXED_7D_PREV_START = new Date('2026-02-03T00:00:00.000Z');
const FIXED_7D_PREV_END = new Date('2026-02-10T00:00:00.000Z');

// 90-day window for trend tests
const FIXED_90D_START = new Date('2025-11-19T00:00:00.000Z');
const FIXED_90D_END = new Date('2026-02-17T00:00:00.000Z');
const FIXED_90D_PREV_START = new Date('2025-08-21T00:00:00.000Z');
const FIXED_90D_PREV_END = new Date('2025-11-19T00:00:00.000Z');

function setupDefaultTimeRange() {
  mockedResolveTimeRange.mockReturnValue({
    start: FIXED_START,
    end: FIXED_END,
    previousStart: FIXED_PREV_START,
    previousEnd: FIXED_PREV_END,
  });
}

// ---------------------------------------------------------------------------
// Platform deployment row factory
// ---------------------------------------------------------------------------

let deploymentCounter = 0;

function makeDeployment(overrides: Partial<PlatformDeploymentRow> = {}): PlatformDeploymentRow {
  deploymentCounter += 1;
  const base: PlatformDeploymentRow = {
    id: `deploy-${deploymentCounter}`,
    service: 'tenant-dashboard',
    environment: 'production',
    status: 'success',
    commit_sha: `sha-${deploymentCounter}`,
    commit_message: `commit ${deploymentCounter}`,
    branch: 'main',
    failure_reason: null,
    duration_ms: 120_000, // 2 minutes = 0.0333 hours
    triggered_by: 'github-actions',
    pipeline_url: null,
    first_commit_at: null,
    started_at: '2026-01-20T00:00:00.000Z',
    completed_at: '2026-01-20T01:00:00.000Z',
    created_at: '2026-01-20T00:00:00.000Z',
  };
  return { ...base, ...overrides } as PlatformDeploymentRow;
}

// ---------------------------------------------------------------------------
// Mock Supabase client builder
//
// Handles the chained `.from(table).select().gte().lt().in().order().eq()`
// pattern the service uses. Supports both `platform_deployment` and
// `platform_incident` tables. Incidents default to an empty array when not
// specified, so deployment-only cases can omit them.
// ---------------------------------------------------------------------------

interface MockSupabaseOptions {
  deploymentData?: PlatformDeploymentRow[];
  deploymentError?: { message: string } | null;
  incidentData?: PlatformIncidentRow[];
  incidentError?: { message: string } | null;
}

function createMockSupabase(opts: MockSupabaseOptions = {}) {
  const {
    deploymentData = [],
    deploymentError = null,
    incidentData = [],
    incidentError = null,
  } = opts;

  // Track calls for assertions
  const eqCalls: Array<{ column: string; value: unknown }> = [];

  function createChain(result: { data: any; error: any }) {
    const chain: Record<string, any> = {};

    chain.select = vi.fn().mockReturnValue(chain);
    chain.gte = vi.fn().mockReturnValue(chain);
    chain.lt = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn((...args: any[]) => {
      eqCalls.push({ column: args[0], value: args[1] });
      return chain;
    });

    chain.then = (resolve: any) => resolve(result);

    return chain;
  }

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === 'platform_deployment') {
      return createChain({ data: deploymentData, error: deploymentError });
    }
    if (table === 'platform_incident') {
      return createChain({ data: incidentData, error: incidentError });
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    client: { from: fromMock } as any,
    fromMock,
    eqCalls,
  };
}

// ---------------------------------------------------------------------------
// Helper: generate N successful deployments spread over the current period
// ---------------------------------------------------------------------------

function makeSuccessfulDeployments(count: number, service = 'tenant-dashboard'): PlatformDeploymentRow[] {
  const rows: PlatformDeploymentRow[] = [];
  const startMs = FIXED_START.getTime();
  const endMs = FIXED_END.getTime();
  const intervalMs = (endMs - startMs) / count;

  for (let i = 0; i < count; i++) {
    const startedAt = new Date(startMs + intervalMs * i).toISOString();
    rows.push(
      makeDeployment({
        service,
        status: 'success',
        started_at: startedAt,
        duration_ms: 120_000,
      }),
    );
  }
  return rows;
}

function makeFailedDeployment(overrides: Partial<PlatformDeploymentRow> = {}): PlatformDeploymentRow {
  return makeDeployment({
    status: 'failure',
    failure_reason: 'build error',
    duration_ms: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Platform incident row factory
// ---------------------------------------------------------------------------

let incidentCounter = 0;

function makeIncident(overrides: Partial<PlatformIncidentRow> = {}): PlatformIncidentRow {
  incidentCounter += 1;
  const base: PlatformIncidentRow = {
    id: `incident-${incidentCounter}`,
    service: 'tenant-dashboard',
    status: 'resolved',
    deployment_id: null,
    started_at: '2026-01-20T00:00:00.000Z',
    resolved_at: '2026-01-20T02:00:00.000Z',
    resolution_ms: 7_200_000, // 2 hours
  };
  return { ...base, ...overrides };
}

// ===========================================================================
// Tests
// ===========================================================================

beforeEach(() => {
  vi.clearAllMocks();
  deploymentCounter = 0;
  incidentCounter = 0;
  setupDefaultTimeRange();
});

// ---------------------------------------------------------------------------
// describe('getMetrics')
// ---------------------------------------------------------------------------

describe('getMetrics', () => {
  it('should return all four metrics with correct structure', async () => {
    const deployments = makeSuccessfulDeployments(10);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // All four metrics present
    expect(result.metrics).toHaveProperty('deploymentFrequency');
    expect(result.metrics).toHaveProperty('leadTime');
    expect(result.metrics).toHaveProperty('changeFailureRate');
    expect(result.metrics).toHaveProperty('mttr');

    // Each metric has the required shape
    for (const key of [
      'deploymentFrequency',
      'leadTime',
      'changeFailureRate',
      'mttr',
    ] as const) {
      const metric = result.metrics[key];
      expect(metric).toHaveProperty('value');
      expect(metric).toHaveProperty('unit');
      expect(metric).toHaveProperty('performanceLevel');
      expect(metric).toHaveProperty('trend');
      expect(metric.trend).toHaveProperty('direction');
      expect(metric.trend).toHaveProperty('changePercent');
      expect(metric).toHaveProperty('sampleSize');
    }

    // Period boundaries returned correctly
    expect(result.period.start).toBe(FIXED_START.toISOString());
    expect(result.period.end).toBe(FIXED_END.toISOString());
    expect(result.comparisonPeriod.start).toBe(FIXED_PREV_START.toISOString());
    expect(result.comparisonPeriod.end).toBe(FIXED_PREV_END.toISOString());
  });

  it('should query platform_deployment and platform_incident tables', async () => {
    const { client, fromMock } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d');

    // Verify from() calls target only expected tables
    const tableNames = fromMock.mock.calls.map((call: any[]) => call[0]);
    const deploymentCalls = tableNames.filter((t: string) => t === 'platform_deployment');
    const incidentCalls = tableNames.filter((t: string) => t === 'platform_incident');

    // Two deployment fetches (current + previous) and two incident fetches
    expect(deploymentCalls).toHaveLength(2);
    expect(incidentCalls).toHaveLength(2);
  });

  it('should count only SUCCESSFUL deploys for deployment frequency', async () => {
    // Four Keys / dora.dev practice: DF counts deployments that reached
    // production. 8 success (+2 ignored failures) over 30 days = 0.27/day.
    const deployments = [
      ...makeSuccessfulDeployments(8),
      makeFailedDeployment({ started_at: '2026-01-22T00:00:00.000Z' }),
      makeFailedDeployment({ started_at: '2026-01-28T00:00:00.000Z' }),
    ];
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // 8 successful / 30 days
    expect(result.metrics.deploymentFrequency.value).toBe(0.27);
    expect(result.metrics.deploymentFrequency.unit).toBe('deploys/day');
    // Sample size is the successful-deploy count.
    expect(result.metrics.deploymentFrequency.sampleSize).toBe(8);
  });

  it('should compute DF as exactly 1.6 for 8 success + 2 failure over 5 days', async () => {
    // Pin the canonical fixture: 8 successful deploys / 5 days = 1.6/day
    // (the 2 pipeline failures never reached production).
    mockedResolveTimeRange.mockReturnValue({
      start: new Date('2026-02-12T00:00:00.000Z'),
      end: new Date('2026-02-17T00:00:00.000Z'), // 5-day window
      previousStart: new Date('2026-02-07T00:00:00.000Z'),
      previousEnd: new Date('2026-02-12T00:00:00.000Z'),
    });
    const deployments = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeDeployment({
          status: 'success',
          started_at: new Date(`2026-02-1${(i % 4) + 2}T0${i % 8}:00:00.000Z`).toISOString(),
        }),
      ),
      makeFailedDeployment({ started_at: '2026-02-13T05:00:00.000Z' }),
      makeFailedDeployment({ started_at: '2026-02-14T05:00:00.000Z' }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('7d');

    expect(result.metrics.deploymentFrequency.value).toBe(1.6);
    expect(result.metrics.deploymentFrequency.sampleSize).toBe(8);
  });

  it('should NOT let pipeline failures inflate change failure rate (no incidents)', async () => {
    // 3 pipeline failures + 27 successes, zero incidents. Pipeline failures
    // never shipped, so CFR = 0 and the denominator is successful deploys.
    const successes = makeSuccessfulDeployments(27);
    const failures = [
      makeFailedDeployment({ started_at: '2026-01-20T00:00:00.000Z' }),
      makeFailedDeployment({ started_at: '2026-01-25T00:00:00.000Z' }),
      makeFailedDeployment({ started_at: '2026-02-01T00:00:00.000Z' }),
    ];
    const deployments = [...successes, ...failures];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.changeFailureRate.value).toBe(0);
    expect(result.metrics.changeFailureRate.unit).toBe('%');
    // Denominator = successful deploys, not total.
    expect(result.metrics.changeFailureRate.sampleSize).toBe(27);
  });

  it('should handle no deployments gracefully with all zeros', async () => {
    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.value).toBe(0);
    expect(result.metrics.leadTime.value).toBe(0);
    expect(result.metrics.changeFailureRate.value).toBe(0);
    expect(result.metrics.mttr.value).toBe(0);
  });

  it('should count all-pipeline-failures for neither DF nor CFR (none shipped)', async () => {
    const failures = [
      makeFailedDeployment({ started_at: '2026-01-20T00:00:00.000Z' }),
      makeFailedDeployment({ started_at: '2026-01-25T00:00:00.000Z' }),
      makeFailedDeployment({ started_at: '2026-02-01T00:00:00.000Z' }),
    ];

    const { client } = createMockSupabase({ deploymentData: failures });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // CFR: zero successful deploys → rate 0, sample size 0.
    expect(result.metrics.changeFailureRate.value).toBe(0);
    expect(result.metrics.changeFailureRate.sampleSize).toBe(0);
    // DF: zero successful deploys → 0/day; failed attempts don't count.
    expect(result.metrics.deploymentFrequency.value).toBe(0);
    expect(result.metrics.deploymentFrequency.sampleSize).toBe(0);
  });

  it('should handle no failures with CFR of 0% and MTTR of 0', async () => {
    const deployments = makeSuccessfulDeployments(10);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.changeFailureRate.value).toBe(0);
    expect(result.metrics.mttr.value).toBe(0);
  });

  it('should filter by service when provided', async () => {
    const deployments = makeSuccessfulDeployments(5);
    const { client, eqCalls } = createMockSupabase({
      deploymentData: deployments,
    });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d', 'gateway');

    // The service calls fetchDeployments + fetchIncidents twice each
    // (current + previous period). All four calls add .eq('service', 'gateway').
    const serviceFilters = eqCalls.filter(
      (c) => c.column === 'service' && c.value === 'gateway',
    );
    expect(serviceFilters).toHaveLength(4);
  });

  it('should calculate trend direction as up when current exceeds previous by more than 5%', async () => {
    const currentDeploys = makeSuccessfulDeployments(20);
    const previousDeploys = makeSuccessfulDeployments(5);

    let deployCallCount = 0;

    function makeDeployChain() {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lt = vi.fn().mockReturnValue(chain);
      chain.in = vi.fn().mockReturnValue(chain);
      chain.order = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.then = vi.fn().mockImplementation((resolve: any) => {
        deployCallCount += 1;
        if (deployCallCount === 1) {
          return resolve({ data: currentDeploys, error: null });
        }
        return resolve({ data: previousDeploys, error: null });
      });
      return chain;
    }

    function makeEmptyChain() {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lt = vi.fn().mockReturnValue(chain);
      chain.order = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.then = (resolve: any) => resolve({ data: [], error: null });
      return chain;
    }

    const client = {
      from: vi.fn().mockImplementation((table: string) =>
        table === 'platform_incident' ? makeEmptyChain() : makeDeployChain(),
      ),
    } as any;

    const service = createDoraMetricsService(client);
    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.trend.direction).toBe('up');
    expect(result.metrics.deploymentFrequency.trend.changePercent).toBeGreaterThan(5);
  });

  it('should calculate trend direction as stable when change is within 5%', async () => {
    const deployments = makeSuccessfulDeployments(10);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.trend.direction).toBe('stable');
    expect(result.metrics.deploymentFrequency.trend.changePercent).toBe(0);
  });

  it('should set isProxy to true for lead time', async () => {
    const deployments = makeSuccessfulDeployments(5);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.leadTime.isProxy).toBe(true);
  });

  it('should calculate lead time as median of duration_ms converted to hours', async () => {
    const MS_PER_HOUR = 3_600_000;
    const deployments = [
      makeDeployment({ duration_ms: 1 * MS_PER_HOUR, started_at: '2026-01-20T00:00:00.000Z' }),
      makeDeployment({ duration_ms: 3 * MS_PER_HOUR, started_at: '2026-01-21T00:00:00.000Z' }),
      makeDeployment({ duration_ms: 2 * MS_PER_HOUR, started_at: '2026-01-22T00:00:00.000Z' }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.leadTime.value).toBe(2);
    expect(result.metrics.leadTime.unit).toBe('hours');
  });

  it('should exclude null and zero duration_ms from lead time calculation', async () => {
    const MS_PER_HOUR = 3_600_000;
    const deployments = [
      makeDeployment({ duration_ms: null, started_at: '2026-01-20T00:00:00.000Z' }),
      makeDeployment({ duration_ms: 0, started_at: '2026-01-21T00:00:00.000Z' }),
      makeDeployment({ duration_ms: 4 * MS_PER_HOUR, started_at: '2026-01-22T00:00:00.000Z' }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.leadTime.value).toBe(4);
    expect(result.metrics.leadTime.sampleSize).toBe(1);
  });

  it('should compute MTTR as average recovery time from failure to next success for same service', async () => {
    const deployments = [
      makeFailedDeployment({
        service: 'tenant-dashboard',
        started_at: '2026-01-20T00:00:00.000Z',
      }),
      makeDeployment({
        service: 'tenant-dashboard',
        status: 'success',
        started_at: '2026-01-20T06:00:00.000Z',
      }),
      makeFailedDeployment({
        service: 'tenant-dashboard',
        started_at: '2026-01-20T12:00:00.000Z',
      }),
      makeDeployment({
        service: 'tenant-dashboard',
        status: 'success',
        started_at: '2026-01-20T18:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.mttr.value).toBe(6);
    expect(result.metrics.mttr.unit).toBe('hours');
  });

  it('should not pair failures with successes from different services for MTTR', async () => {
    const deployments = [
      makeFailedDeployment({
        service: 'tenant-dashboard',
        started_at: '2026-01-20T00:00:00.000Z',
      }),
      makeDeployment({
        service: 'gateway',
        status: 'success',
        started_at: '2026-01-20T06:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.mttr.value).toBe(0);
  });

  it('should throw when Supabase returns an error for platform deployments', async () => {
    const { client } = createMockSupabase({
      deploymentError: { message: 'connection refused' },
    });
    const service = createDoraMetricsService(client);

    await expect(service.getMetrics('30d')).rejects.toThrow(
      'Failed to fetch platform deployments: connection refused',
    );
  });
});

// ---------------------------------------------------------------------------
// describe('getTrends')
// ---------------------------------------------------------------------------

describe('getTrends', () => {
  it('should return time series for all four metrics', async () => {
    const deployments = makeSuccessfulDeployments(10);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('30d');

    expect(result.trends).toHaveProperty('deploymentFrequency');
    expect(result.trends).toHaveProperty('leadTime');
    expect(result.trends).toHaveProperty('changeFailureRate');
    expect(result.trends).toHaveProperty('mttr');

    for (const key of [
      'deploymentFrequency',
      'leadTime',
      'changeFailureRate',
      'mttr',
    ] as const) {
      expect(result.trends[key]).toHaveProperty('series');
      expect(result.trends[key]).toHaveProperty('granularity');
      expect(Array.isArray(result.trends[key].series)).toBe(true);
    }

    expect(result.period.start).toBe(FIXED_START.toISOString());
    expect(result.period.end).toBe(FIXED_END.toISOString());
  });

  it('should use daily granularity for 30d range', async () => {
    const deployments = makeSuccessfulDeployments(5);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('30d');

    expect(result.granularity).toBe('day');
    expect(result.trends.deploymentFrequency.granularity).toBe('day');
    expect(result.trends.deploymentFrequency.series.length).toBe(30);
  });

  it('should use weekly granularity for 90d range', async () => {
    mockedResolveTimeRange.mockReturnValue({
      start: FIXED_90D_START,
      end: FIXED_90D_END,
      previousStart: FIXED_90D_PREV_START,
      previousEnd: FIXED_90D_PREV_END,
    });

    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('90d');

    expect(result.granularity).toBe('week');
    expect(result.trends.deploymentFrequency.granularity).toBe('week');
    expect(result.trends.deploymentFrequency.series.length).toBe(13);
  });

  it('should handle empty data with empty series arrays of correct bucket count', async () => {
    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('30d');

    expect(result.trends.deploymentFrequency.series.length).toBe(30);
    for (const point of result.trends.deploymentFrequency.series) {
      expect(point.y).toBe(0);
    }
    for (const point of result.trends.changeFailureRate.series) {
      expect(point.y).toBe(0);
    }
  });

  it('should use daily granularity for 7d range', async () => {
    mockedResolveTimeRange.mockReturnValue({
      start: FIXED_7D_START,
      end: FIXED_7D_END,
      previousStart: FIXED_7D_PREV_START,
      previousEnd: FIXED_7D_PREV_END,
    });

    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('7d');

    expect(result.granularity).toBe('day');
    expect(result.trends.deploymentFrequency.series.length).toBe(7);
  });

  it('should correctly bucket deployments into daily intervals', async () => {
    const deployments = [
      makeDeployment({
        status: 'success',
        started_at: '2026-01-18T03:00:00.000Z',
        duration_ms: 60_000,
      }),
      makeDeployment({
        status: 'success',
        started_at: '2026-01-18T15:00:00.000Z',
        duration_ms: 60_000,
      }),
      makeDeployment({
        status: 'success',
        started_at: '2026-01-19T10:00:00.000Z',
        duration_ms: 60_000,
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('30d');

    const firstBucket = result.trends.deploymentFrequency.series[0];
    expect(firstBucket?.x).toBe('2026-01-18');
    expect(firstBucket?.y).toBe(2);

    const secondBucket = result.trends.deploymentFrequency.series[1];
    expect(secondBucket?.x).toBe('2026-01-19');
    expect(secondBucket?.y).toBe(1);
  });

  it('should null out MTTR buckets with no resolved incident when the window is incident-based', async () => {
    // The full 30d window has resolved incidents, so MTTR is incident-based for
    // EVERY bucket. A bucket whose interval has no resolved incident must be
    // null (a chart gap), NOT a deployment-recovery fallback.
    const deployments = [
      // A failure→success pair on 2026-01-18 that would yield a deployment-based
      // MTTR if the fallback ever leaked into a bucket. It must not.
      makeFailedDeployment({
        service: 'tenant-dashboard',
        started_at: '2026-01-18T00:00:00.000Z',
      }),
      makeDeployment({
        service: 'tenant-dashboard',
        status: 'success',
        started_at: '2026-01-18T06:00:00.000Z',
      }),
    ];
    // One resolved CHANGE-CAUSED incident on 2026-01-20 only (2h to resolve).
    // deployment_id is required: per the 2023+ DORA definition, recovery time
    // covers failures caused by software changes, so only correlated
    // incidents select incident-based MTTR.
    const incidents = [
      makeIncident({
        deployment_id: 'deploy-correlated-1',
        started_at: '2026-01-20T03:00:00.000Z',
        resolved_at: '2026-01-20T05:00:00.000Z',
        resolution_ms: 2 * 3_600_000, // 2 hours
      }),
    ];

    const { client } = createMockSupabase({
      deploymentData: deployments,
      incidentData: incidents,
    });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('30d');
    const mttr = result.trends.mttr.series;

    const jan18 = mttr.find((p) => p.x === '2026-01-18');
    const jan20 = mttr.find((p) => p.x === '2026-01-20');

    // 2026-01-20 has a resolved incident -> 2h.
    expect(jan20?.y).toBe(2);
    // 2026-01-18 has a failure→success deploy pair but NO resolved incident.
    // Incident-based mode means this bucket is null, not the 6h recovery time.
    expect(jan18?.y).toBeNull();
    // Every other (empty) bucket is also null.
    const otherBuckets = mttr.filter((p) => p.x !== '2026-01-20');
    for (const b of otherBuckets) {
      expect(b.y).toBeNull();
    }
  });

  it('attributes a deployment-mode recovery that spans two buckets to the failure-day bucket', async () => {
    // Deployment-recovery MTTR: a failed deploy and its recovering success are,
    // by definition, two different rows — and the recovery routinely crosses a
    // day boundary. Here the failure is on 2026-01-20 (23:00Z) and the recovery
    // success is on 2026-01-21 (01:00Z): a 2h recovery spanning the UTC-midnight
    // bucket edge. The whole-window rankings see the pair, so the trend must too
    // (attributed to the FAILURE day), not silently drop it into two empty
    // single-row buckets. No incidents -> window is deployment-based MTTR.
    const deployments = [
      makeFailedDeployment({
        service: 'tenant-dashboard',
        started_at: '2026-01-20T23:00:00.000Z',
      }),
      makeDeployment({
        service: 'tenant-dashboard',
        status: 'success',
        started_at: '2026-01-21T01:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getTrends('30d');
    const mttr = result.trends.mttr.series;

    // The 2h recovery is attributed to the failure-day bucket (2026-01-20).
    expect(mttr.find((p) => p.x === '2026-01-20')?.y).toBe(2);
    // The recovery-success day is NOT a second MTTR point.
    expect(mttr.find((p) => p.x === '2026-01-21')?.y).toBeNull();
    // Exactly one non-null point in the whole series.
    expect(mttr.filter((p) => p.y != null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// describe('getRankings')
// ---------------------------------------------------------------------------

describe('getRankings', () => {
  it('should return rankings grouped by platform service', async () => {
    const deployments = [
      makeDeployment({ service: 'tenant-dashboard', status: 'success', started_at: '2026-01-20T00:00:00.000Z' }),
      makeDeployment({ service: 'tenant-dashboard', status: 'success', started_at: '2026-01-21T00:00:00.000Z' }),
      makeDeployment({ service: 'gateway', status: 'success', started_at: '2026-01-22T00:00:00.000Z' }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getRankings('30d', 'deploymentFrequency', 'desc');

    expect(result.rankings.length).toBe(2);

    // Sorted desc by deploymentFrequency: tenant-dashboard has 2 deploys, gateway has 1
    expect(result.rankings[0]?.serviceName).toBe('tenant-dashboard');
    expect(result.rankings[0]?.totalDeployments).toBe(2);

    expect(result.rankings[1]?.serviceName).toBe('gateway');
    expect(result.rankings[1]?.totalDeployments).toBe(1);

    // Each ranking has all four metrics with value and performanceLevel
    for (const ranking of result.rankings) {
      for (const metricKey of [
        'deploymentFrequency',
        'leadTime',
        'changeFailureRate',
        'mttr',
      ] as const) {
        expect(ranking.metrics[metricKey]).toHaveProperty('value');
        expect(ranking.metrics[metricKey]).toHaveProperty('performanceLevel');
      }
    }
  });

  it('should sort by specified metric in ascending order', async () => {
    const deployments = [
      // tenant-dashboard: 3 deploys -> higher frequency
      makeDeployment({ service: 'tenant-dashboard', status: 'success', started_at: '2026-01-20T00:00:00.000Z' }),
      makeDeployment({ service: 'tenant-dashboard', status: 'success', started_at: '2026-01-21T00:00:00.000Z' }),
      makeDeployment({ service: 'tenant-dashboard', status: 'success', started_at: '2026-01-22T00:00:00.000Z' }),
      // gateway: 1 deploy -> lower frequency
      makeDeployment({ service: 'gateway', status: 'success', started_at: '2026-01-23T00:00:00.000Z' }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getRankings('30d', 'deploymentFrequency', 'asc');

    // Ascending: lower frequency first
    expect(result.rankings[0]?.serviceName).toBe('gateway');
    expect(result.rankings[1]?.serviceName).toBe('tenant-dashboard');
  });

  it('should handle empty data with empty rankings array', async () => {
    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getRankings('30d', 'deploymentFrequency', 'desc');

    expect(result.rankings).toEqual([]);
    expect(result.period.start).toBe(FIXED_START.toISOString());
    expect(result.period.end).toBe(FIXED_END.toISOString());
  });

  it('should throw when Supabase returns an error for platform deployments', async () => {
    const { client } = createMockSupabase({
      deploymentError: { message: 'permission denied' },
    });
    const service = createDoraMetricsService(client);

    await expect(
      service.getRankings('30d', 'deploymentFrequency', 'desc'),
    ).rejects.toThrow('Failed to fetch platform deployments: permission denied');
  });
});

// ---------------------------------------------------------------------------
// describe('trend computation edge cases')
// ---------------------------------------------------------------------------

describe('trend computation edge cases', () => {
  it('should return 100% change when previous value is 0 and current is non-zero', async () => {
    const currentDeploys = makeSuccessfulDeployments(10);

    let deployCallCount = 0;

    function makeDeployChain() {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lt = vi.fn().mockReturnValue(chain);
      chain.in = vi.fn().mockReturnValue(chain);
      chain.order = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.then = vi.fn().mockImplementation((resolve: any) => {
        deployCallCount += 1;
        if (deployCallCount === 1) {
          return resolve({ data: currentDeploys, error: null });
        }
        return resolve({ data: [], error: null });
      });
      return chain;
    }

    function makeEmptyChain() {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lt = vi.fn().mockReturnValue(chain);
      chain.order = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.then = (resolve: any) => resolve({ data: [], error: null });
      return chain;
    }

    const client = {
      from: vi.fn().mockImplementation((table: string) =>
        table === 'platform_incident' ? makeEmptyChain() : makeDeployChain(),
      ),
    } as any;
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.trend.changePercent).toBe(100);
    expect(result.metrics.deploymentFrequency.trend.direction).toBe('up');
  });

  it('should return 0% change when both current and previous are 0', async () => {
    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.trend.changePercent).toBe(0);
    expect(result.metrics.deploymentFrequency.trend.direction).toBe('stable');
  });

  it('should return down direction when current period has fewer deploys than previous', async () => {
    const fewDeploys = makeSuccessfulDeployments(3);
    const manyDeploys = makeSuccessfulDeployments(20);

    let deployCallCount = 0;

    function makeDeployChain() {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lt = vi.fn().mockReturnValue(chain);
      chain.in = vi.fn().mockReturnValue(chain);
      chain.order = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.then = vi.fn().mockImplementation((resolve: any) => {
        deployCallCount += 1;
        if (deployCallCount === 1) {
          return resolve({ data: fewDeploys, error: null });
        }
        return resolve({ data: manyDeploys, error: null });
      });
      return chain;
    }

    function makeEmptyChain() {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.gte = vi.fn().mockReturnValue(chain);
      chain.lt = vi.fn().mockReturnValue(chain);
      chain.order = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.then = (resolve: any) => resolve({ data: [], error: null });
      return chain;
    }

    const client = {
      from: vi.fn().mockImplementation((table: string) =>
        table === 'platform_incident' ? makeEmptyChain() : makeDeployChain(),
      ),
    } as any;
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.trend.direction).toBe('down');
    expect(result.metrics.deploymentFrequency.trend.changePercent).toBeLessThan(-5);
  });
});

// ---------------------------------------------------------------------------
// describe('performance level classification')
// ---------------------------------------------------------------------------

describe('performance level classification', () => {
  it('should classify elite deployment frequency when >= 1 deploy/day', async () => {
    const deployments = makeSuccessfulDeployments(30);
    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.performanceLevel).toBe('elite');
  });

  it('should classify low deployment frequency when below monthly threshold', async () => {
    const { client } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    expect(result.metrics.deploymentFrequency.performanceLevel).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// describe('lead time with first_commit_at')
// ---------------------------------------------------------------------------

describe('lead time with first_commit_at', () => {
  const MS_PER_HOUR = 3_600_000;

  it('should compute lead time from first_commit_at to completed_at when both are present', async () => {
    // first_commit_at is exactly 24 hours before completed_at
    const deployments = [
      makeDeployment({
        first_commit_at: '2026-01-19T00:00:00.000Z',
        completed_at: '2026-01-20T00:00:00.000Z',
        duration_ms: 120_000, // 2 minutes — should be ignored when first_commit_at is available
        started_at: '2026-01-20T00:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // 24 hours from first_commit_at to completed_at
    expect(result.metrics.leadTime.value).toBe(24);
    expect(result.metrics.leadTime.unit).toBe('hours');
    expect(result.metrics.leadTime.sampleSize).toBe(1);
  });

  it('should fall back to duration_ms when first_commit_at is null', async () => {
    const deployments = [
      makeDeployment({
        first_commit_at: null,
        completed_at: '2026-01-20T02:00:00.000Z',
        duration_ms: 2 * MS_PER_HOUR, // 2 hours
        started_at: '2026-01-20T00:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // Falls back to duration_ms: 7,200,000 ms = 2 hours
    expect(result.metrics.leadTime.value).toBe(2);
    expect(result.metrics.leadTime.unit).toBe('hours');
    expect(result.metrics.leadTime.sampleSize).toBe(1);
  });

  it('should NOT blend commit-based and duration-based lead times in one median', async () => {
    // The window has at least one deploy with first_commit_at, so the whole
    // window uses commit-based lead time and isProxy=false. The deploy WITHOUT
    // first_commit_at is excluded entirely — its duration is never blended in.
    //
    // Deploy A: first_commit_at -> 10 hours (counted)
    // Deploy B: no first_commit_at, duration 6h -> EXCLUDED (no blending)
    // Deploy C: first_commit_at -> 2 hours (counted)
    // Commit-only lead times: [2h, 10h] -> median = 6h, sampleSize = 2.
    const deployments = [
      makeDeployment({
        first_commit_at: '2026-01-19T14:00:00.000Z',
        completed_at: '2026-01-20T00:00:00.000Z', // 10 hours later
        duration_ms: 120_000,
        started_at: '2026-01-20T00:00:00.000Z',
      }),
      makeDeployment({
        first_commit_at: null,
        completed_at: '2026-01-21T06:00:00.000Z',
        duration_ms: 6 * MS_PER_HOUR, // would be 6h if blended — it must not be
        started_at: '2026-01-21T00:00:00.000Z',
      }),
      makeDeployment({
        first_commit_at: '2026-01-21T22:00:00.000Z',
        completed_at: '2026-01-22T00:00:00.000Z', // 2 hours later
        duration_ms: 120_000,
        started_at: '2026-01-22T00:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // Median of commit-only [2h, 10h] = 6h. Sample size is 2 (B excluded),
    // proving the duration-based row was not blended in.
    expect(result.metrics.leadTime.value).toBe(6);
    expect(result.metrics.leadTime.sampleSize).toBe(2);
    expect(result.metrics.leadTime.isProxy).toBe(false);
  });

  it('should fall back to duration_ms with isProxy=true only when NO deploy has first_commit_at', async () => {
    const deployments = [
      makeDeployment({
        first_commit_at: null,
        duration_ms: 2 * MS_PER_HOUR,
        started_at: '2026-01-20T00:00:00.000Z',
      }),
      makeDeployment({
        first_commit_at: null,
        duration_ms: 6 * MS_PER_HOUR,
        started_at: '2026-01-21T00:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // Median of duration-based [2h, 6h] = 4h, flagged as a proxy.
    expect(result.metrics.leadTime.value).toBe(4);
    expect(result.metrics.leadTime.sampleSize).toBe(2);
    expect(result.metrics.leadTime.isProxy).toBe(true);
  });

  it('should ignore negative lead time values when first_commit_at is after completed_at', async () => {
    // Deploy A: first_commit_at AFTER completed_at -> negative, should be excluded
    // Deploy B: valid first_commit_at -> lead time = 4 hours
    const deployments = [
      makeDeployment({
        first_commit_at: '2026-01-20T06:00:00.000Z', // 6 hours AFTER completed_at
        completed_at: '2026-01-20T00:00:00.000Z',
        duration_ms: 120_000,
        started_at: '2026-01-19T23:00:00.000Z',
      }),
      makeDeployment({
        first_commit_at: '2026-01-20T20:00:00.000Z',
        completed_at: '2026-01-21T00:00:00.000Z', // 4 hours later
        duration_ms: 120_000,
        started_at: '2026-01-21T00:00:00.000Z',
      }),
    ];

    const { client } = createMockSupabase({ deploymentData: deployments });
    const service = createDoraMetricsService(client);

    const result = await service.getMetrics('30d');

    // Only the valid deployment contributes: 4 hours
    expect(result.metrics.leadTime.value).toBe(4);
    expect(result.metrics.leadTime.sampleSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// describe('incident-based metrics')
// ---------------------------------------------------------------------------

describe('incident-based metrics', () => {
  const MS_PER_HOUR = 3_600_000;

  // -------------------------------------------------------------------------
  // MTTR with incidents
  // -------------------------------------------------------------------------

  describe('MTTR with incidents', () => {
    it('should compute MTTR as median of incident resolution_ms when incidents have resolution times', async () => {
      // 3 resolved CHANGE-CAUSED (deployment-correlated) incidents with
      // resolution times: 1h, 3h, 5h. Median = 3h.
      const incidents = [
        makeIncident({ deployment_id: 'dep-1', resolution_ms: 1 * MS_PER_HOUR }),
        makeIncident({ deployment_id: 'dep-2', resolution_ms: 3 * MS_PER_HOUR }),
        makeIncident({ deployment_id: 'dep-3', resolution_ms: 5 * MS_PER_HOUR }),
      ];
      const deployments = makeSuccessfulDeployments(5);

      const { client } = createMockSupabase({
        deploymentData: deployments,
        incidentData: incidents,
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      expect(result.metrics.mttr.value).toBe(3);
      expect(result.metrics.mttr.unit).toBe('hours');
    });

    it('should use only resolved incidents for MTTR when mix of resolved and unresolved', async () => {
      // Resolved correlated incidents: 2h, 4h -> median = 3h
      // Unresolved incident: resolution_ms = null -> excluded
      const incidents = [
        makeIncident({ deployment_id: 'dep-1', resolution_ms: 2 * MS_PER_HOUR, status: 'resolved' }),
        makeIncident({ deployment_id: 'dep-2', resolution_ms: null, resolved_at: null, status: 'triggered' }),
        makeIncident({ deployment_id: 'dep-3', resolution_ms: 4 * MS_PER_HOUR, status: 'resolved' }),
      ];
      const deployments = makeSuccessfulDeployments(5);

      const { client } = createMockSupabase({
        deploymentData: deployments,
        incidentData: incidents,
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      // Median of [2h, 4h] = 3h
      expect(result.metrics.mttr.value).toBe(3);
      expect(result.metrics.mttr.unit).toBe('hours');
    });

    it('should fall back to deployment-based MTTR when no incidents have resolution_ms', async () => {
      // All incidents have null resolution_ms -> fallback to deployment pairing
      const incidents = [
        makeIncident({ resolution_ms: null, resolved_at: null, status: 'triggered' }),
        makeIncident({ resolution_ms: null, resolved_at: null, status: 'triggered' }),
      ];
      // Failure at T+0, success at T+6h -> recovery = 6h
      const deployments = [
        makeFailedDeployment({
          service: 'tenant-dashboard',
          started_at: '2026-01-20T00:00:00.000Z',
        }),
        makeDeployment({
          service: 'tenant-dashboard',
          status: 'success',
          started_at: '2026-01-20T06:00:00.000Z',
        }),
      ];

      const { client } = createMockSupabase({
        deploymentData: deployments,
        incidentData: incidents,
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      // Deployment-based fallback: 6 hours
      expect(result.metrics.mttr.value).toBe(6);
      expect(result.metrics.mttr.unit).toBe('hours');
    });

    it('should fall back to deployment-based MTTR when incidents array is empty', async () => {
      // No incidents at all -> deployment-based MTTR
      // Failure at T+0, success at T+12h -> recovery = 12h
      const deployments = [
        makeFailedDeployment({
          service: 'tenant-dashboard',
          started_at: '2026-01-20T00:00:00.000Z',
        }),
        makeDeployment({
          service: 'tenant-dashboard',
          status: 'success',
          started_at: '2026-01-20T12:00:00.000Z',
        }),
      ];

      const { client } = createMockSupabase({
        deploymentData: deployments,
        incidentData: [],
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      // Deployment-based fallback: 12 hours
      expect(result.metrics.mttr.value).toBe(12);
      expect(result.metrics.mttr.unit).toBe('hours');
    });
  });

  // -------------------------------------------------------------------------
  // CFR with incidents
  // -------------------------------------------------------------------------

  describe('CFR with incidents', () => {
    it('should count a successful deployment with a correlated incident as a change failure', async () => {
      // Deploy A: status='success' but has an incident pointing to its ID
      const deployA = makeDeployment({
        id: 'deploy-cfr-1',
        status: 'success',
        started_at: '2026-01-20T00:00:00.000Z',
      });
      const deployB = makeDeployment({
        id: 'deploy-cfr-2',
        status: 'success',
        started_at: '2026-01-21T00:00:00.000Z',
      });
      const incidents = [
        makeIncident({ deployment_id: 'deploy-cfr-1' }),
      ];

      const { client } = createMockSupabase({
        deploymentData: [deployA, deployB],
        incidentData: incidents,
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      // 1 of 2 successful deploys is incident-correlated = 50%.
      expect(result.metrics.changeFailureRate.value).toBe(50);
      expect(result.metrics.changeFailureRate.sampleSize).toBe(2);
    });

    it('should exclude pipeline failures from BOTH numerator and denominator of CFR', async () => {
      // Deploy A: status='failure' AND has a correlated incident — but it never
      //   shipped, so it counts as NEITHER a change failure NOR part of the
      //   successful-deploy denominator.
      // Deploy B: status='success', no incident.
      // Deploy C: status='success', correlated incident -> the only change failure.
      const deployA = makeDeployment({
        id: 'deploy-mixed-1',
        status: 'failure',
        failure_reason: 'build error',
        started_at: '2026-01-20T00:00:00.000Z',
      });
      const deployB = makeDeployment({
        id: 'deploy-mixed-2',
        status: 'success',
        started_at: '2026-01-21T00:00:00.000Z',
      });
      const deployC = makeDeployment({
        id: 'deploy-mixed-3',
        status: 'success',
        started_at: '2026-01-22T00:00:00.000Z',
      });
      const incidents = [
        makeIncident({ deployment_id: 'deploy-mixed-1' }), // on a pipeline failure — ignored
        makeIncident({ deployment_id: 'deploy-mixed-3' }), // on a shipped deploy — counts
      ];

      const { client } = createMockSupabase({
        deploymentData: [deployA, deployB, deployC],
        incidentData: incidents,
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      // Successful deploys: B, C (2). Incident-correlated successful: C (1).
      // CFR = 1/2 = 50%. The failure+incident deploy A does not inflate it.
      expect(result.metrics.changeFailureRate.value).toBe(50);
      expect(result.metrics.changeFailureRate.sampleSize).toBe(2);
    });

    it('should be 0% CFR when there are failures but no incidents correlate to a shipped deploy', async () => {
      // 8 successes + 2 pipeline failures, no incidents. Nothing shipped broke.
      const successes = makeSuccessfulDeployments(8);
      const failures = [
        makeFailedDeployment({ started_at: '2026-01-20T00:00:00.000Z' }),
        makeFailedDeployment({ started_at: '2026-01-25T00:00:00.000Z' }),
      ];
      const deployments = [...successes, ...failures];

      const { client } = createMockSupabase({
        deploymentData: deployments,
        incidentData: [],
      });
      const service = createDoraMetricsService(client);

      const result = await service.getMetrics('30d');

      expect(result.metrics.changeFailureRate.value).toBe(0);
      // Denominator = successful deploys (8), not total (10).
      expect(result.metrics.changeFailureRate.sampleSize).toBe(8);
    });
  });
});

// ---------------------------------------------------------------------------
// describe('environment filtering')
// ---------------------------------------------------------------------------

describe('environment filtering', () => {
  beforeEach(() => {
    setupDefaultTimeRange();
    deploymentCounter = 0;
  });

  it('getMetrics: defaults to production environment filter on fetchDeployments', async () => {
    const { client, eqCalls } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d');

    // fetchDeployments AND fetchIncidents are each called twice (current +
    // previous); all four queries add eq('environment', 'production')
    const envFilters = eqCalls.filter(
      (c) => c.column === 'environment' && c.value === 'production',
    );
    expect(envFilters).toHaveLength(4);
  });

  it('getMetrics: passes custom environment filter when specified', async () => {
    const { client, eqCalls } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d', null, 'staging');

    const envFilters = eqCalls.filter(
      (c) => c.column === 'environment' && c.value === 'staging',
    );
    expect(envFilters).toHaveLength(4);
    // No 'production' filter applied
    const prodFilters = eqCalls.filter(
      (c) => c.column === 'environment' && c.value === 'production',
    );
    expect(prodFilters).toHaveLength(0);
  });

  it('getMetrics: passes null environment filter when explicitly null (all environments)', async () => {
    const { client, eqCalls } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d', null, null);

    // No environment eq filter applied at all
    const envFilters = eqCalls.filter((c) => c.column === 'environment');
    expect(envFilters).toHaveLength(0);
  });

  it('getTrends: defaults to production environment filter on fetchDeployments', async () => {
    mockedResolveTimeRange.mockReturnValue({
      start: FIXED_7D_START,
      end: FIXED_7D_END,
      previousStart: FIXED_7D_PREV_START,
      previousEnd: FIXED_7D_PREV_END,
    });

    const { client, eqCalls } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getTrends('7d');

    // getTrends calls fetchDeployments and fetchIncidents once each
    const envFilters = eqCalls.filter(
      (c) => c.column === 'environment' && c.value === 'production',
    );
    expect(envFilters).toHaveLength(2);
  });

  it('getRankings: defaults to production environment filter on fetchDeployments', async () => {
    setupDefaultTimeRange();

    const { client, eqCalls } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getRankings('30d', 'deploymentFrequency', 'desc');

    // getRankings calls fetchDeployments and fetchIncidents once each
    const envFilters = eqCalls.filter(
      (c) => c.column === 'environment' && c.value === 'production',
    );
    expect(envFilters).toHaveLength(2);
  });

  it('fetchIncidents IS filtered by environment — staging incidents must not pollute production MTTR/CFR', async () => {
    const { client, fromMock, eqCalls } = createMockSupabase({ deploymentData: [] });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d');

    // Environment eq filter on all four queries: 2 deployments + 2 incidents
    const envFilterCount = eqCalls.filter((c) => c.column === 'environment').length;
    expect(envFilterCount).toBe(4);

    // All 4 from() calls: 2 deployments + 2 incidents
    const tableNames = fromMock.mock.calls.map((call: any[]) => call[0]);
    expect(tableNames.filter((t: string) => t === 'platform_deployment')).toHaveLength(2);
    expect(tableNames.filter((t: string) => t === 'platform_incident')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// describe('row-cap warning')
//
// PostgREST silently caps result sets. The fetchers set an explicit limit and
// must warn when the result count equals that limit, since the data may be
// truncated and the metrics therefore wrong.
// ---------------------------------------------------------------------------

describe('row-cap warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function rows(count: number): PlatformDeploymentRow[] {
    return Array.from({ length: count }, (_, i) =>
      makeDeployment({
        id: `bulk-${i}`,
        status: 'success',
        started_at: '2026-01-20T00:00:00.000Z',
      }),
    );
  }

  it('should warn when exactly ROW_LIMIT deployment rows return', async () => {
    const { client } = createMockSupabase({ deploymentData: rows(ROW_LIMIT) });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d');

    expect(warnSpy).toHaveBeenCalledWith(
      '[dora-metrics] row limit hit — metrics may be truncated',
      expect.objectContaining({ table: 'platform_deployment', limit: ROW_LIMIT }),
    );
  });

  it('should NOT warn when fewer than ROW_LIMIT rows return', async () => {
    const { client } = createMockSupabase({ deploymentData: rows(ROW_LIMIT - 1) });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d');

    expect(warnSpy).not.toHaveBeenCalledWith(
      '[dora-metrics] row limit hit — metrics may be truncated',
      expect.anything(),
    );
  });

  it('should warn when exactly ROW_LIMIT incident rows return', async () => {
    const incidentRows: PlatformIncidentRow[] = Array.from({ length: ROW_LIMIT }, (_, i) =>
      makeIncident({ id: `inc-${i}`, resolution_ms: 3_600_000 }),
    );
    const { client } = createMockSupabase({
      deploymentData: rows(3),
      incidentData: incidentRows,
    });
    const service = createDoraMetricsService(client);

    await service.getMetrics('30d');

    expect(warnSpy).toHaveBeenCalledWith(
      '[dora-metrics] row limit hit — metrics may be truncated',
      expect.objectContaining({ table: 'platform_incident', limit: ROW_LIMIT }),
    );
  });
});
