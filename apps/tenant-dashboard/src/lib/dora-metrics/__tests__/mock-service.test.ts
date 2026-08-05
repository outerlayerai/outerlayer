/**
 * Tests: MockDoraMetricsService + mock data generation + factory switching
 *
 * Validates the mock data layer end-to-end:
 * - Deterministic data generation (seeded PRNG, seed=42)
 * - MockDoraMetricsService response shapes match type contracts
 * - All four DORA metrics produce valid, non-zero values
 * - Trend series have correct granularity and date labels
 * - Rankings sort correctly (asc/desc) and include all services
 * - Service filter narrows results
 * - getServices() returns expected set
 * - isPreviewMode() / getDoraMetricsService() factory switching
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { generateDeployments, generateIncidents, getMockDeployments } from '../mock-data';
import { MockDoraMetricsService } from '../mock-service';
import { isPreviewMode, getDoraMetricsService, DoraMetricsService } from '../service';

// ============================================================================
// Constants
// ============================================================================

const EXPECTED_SERVICES = [
  'docs',
  'gateway',
  'ingestion-worker',
  'marketing-site',
  'tenant-dashboard',
];

const VALID_PERFORMANCE_LEVELS = ['elite', 'high', 'medium', 'low'];
const VALID_TREND_DIRECTIONS = ['up', 'down', 'stable'];
const VALID_METRIC_UNITS = ['deploys/day', 'hours', '%'];

// ============================================================================
// Mock Data Generation
// ============================================================================

describe('generateDeployments', () => {
  it('should produce deterministic output for the same seed', () => {
    const run1 = generateDeployments(42);
    const run2 = generateDeployments(42);

    // Same count
    expect(run1.length).toBe(run2.length);
    expect(run1.length).toBeGreaterThan(100);

    // Same first/last entries (spot-check determinism)
    expect(run1[0]!.service).toBe(run2[0]!.service);
    expect(run1[0]!.started_at).toBe(run2[0]!.started_at);
    expect(run1[0]!.status).toBe(run2[0]!.status);
    expect(run1[0]!.commit_sha).toBe(run2[0]!.commit_sha);

    const last1 = run1[run1.length - 1]!;
    const last2 = run2[run2.length - 1]!;
    expect(last1.service).toBe(last2.service);
    expect(last1.started_at).toBe(last2.started_at);
  });

  it('should produce different output for different seeds', () => {
    const run1 = generateDeployments(42);
    const run2 = generateDeployments(99);

    // Could be same count by coincidence, but data should differ
    const sameStart = run1[0]!.started_at === run2[0]!.started_at
      && run1[0]!.service === run2[0]!.service
      && run1[0]!.status === run2[0]!.status;
    expect(sameStart).toBe(false);
  });

  it('should include all five expected services', () => {
    const deployments = generateDeployments(42);
    const services = [...new Set(deployments.map((d) => d.service))].sort();
    expect(services).toEqual(EXPECTED_SERVICES);
  });

  it('should produce both success and failure statuses', () => {
    const deployments = generateDeployments(42);
    const statuses = new Set(deployments.map((d) => d.status));
    expect(statuses.has('success')).toBe(true);
    expect(statuses.has('failure')).toBe(true);
  });

  it('should set failure_reason only for failures', () => {
    const deployments = generateDeployments(42);
    for (const d of deployments) {
      if (d.status === 'failure') {
        expect(typeof d.failure_reason).toBe('string');
        expect((d.failure_reason as string).length).toBeGreaterThan(0);
      } else {
        expect(d.failure_reason).toBeNull();
      }
    }
  });

  it('should sort deployments by started_at ascending', () => {
    const deployments = generateDeployments(42);
    for (let i = 1; i < deployments.length; i++) {
      expect(deployments[i]!.started_at >= deployments[i - 1]!.started_at).toBe(true);
    }
  });

  it('should have valid deployment record shapes', () => {
    const deployments = generateDeployments(42);
    const d = deployments[0]!;

    expect(typeof d.id).toBe('string');
    expect(typeof d.service).toBe('string');
    expect(['production', 'staging']).toContain(d.environment);
    expect(['success', 'failure']).toContain(d.status);
    expect(typeof d.commit_sha).toBe('string');
    expect(d.commit_sha.length).toBe(16);
    expect(typeof d.commit_message).toBe('string');
    expect(typeof d.branch).toBe('string');
    expect(typeof d.duration_ms).toBe('number');
    expect(d.duration_ms).toBeGreaterThan(0);
    expect(typeof d.triggered_by).toBe('string');
    expect(typeof d.pipeline_url).toBe('string');
    expect(typeof d.started_at).toBe('string');
    expect(typeof d.completed_at).toBe('string');
    expect(typeof d.created_at).toBe('string');
    // Verify ISO date format
    expect(new Date(d.started_at).toISOString()).toBe(d.started_at);
  });
});

describe('generateIncidents', () => {
  it('should correlate incidents only to SUCCESSFUL deploys (CFR numerator integrity)', () => {
    const deployments = generateDeployments(42);
    const incidents = generateIncidents(deployments, 1337);

    expect(incidents.length).toBeGreaterThan(0);

    const successIds = new Set(
      deployments.filter((d) => d.status === 'success').map((d) => d.id),
    );
    for (const i of incidents) {
      // Every incident must point at a shipped (successful) deploy, never a
      // pipeline failure — otherwise the mock CFR would diverge from the real
      // service's definition.
      expect(i.deployment_id).not.toBeNull();
      expect(successIds.has(i.deployment_id as string)).toBe(true);
      expect(i.resolution_ms).toBeGreaterThan(0);
      expect(i.status).toBe('resolved');
    }
  });

  it('should be deterministic for the same seed', () => {
    const deployments = generateDeployments(42);
    const a = generateIncidents(deployments, 1337);
    const b = generateIncidents(deployments, 1337);
    expect(a.length).toBe(b.length);
    expect(a.map((i) => i.deployment_id)).toEqual(b.map((i) => i.deployment_id));
  });
});

describe('getMockDeployments (caching)', () => {
  it('should return same reference on consecutive calls (cache hit)', () => {
    const pool1 = getMockDeployments();
    const pool2 = getMockDeployments();
    expect(pool1).toBe(pool2);
  });
});

// ============================================================================
// MockDoraMetricsService — getMetrics
// ============================================================================

describe('MockDoraMetricsService.getMetrics', () => {
  let service: MockDoraMetricsService;

  beforeEach(() => {
    service = new MockDoraMetricsService();
  });

  it('should return all four metrics with correct shape for 30d range', async () => {
    const result = await service.getMetrics('30d');

    // Top-level shape
    expect(result).toHaveProperty('metrics');
    expect(result).toHaveProperty('period');
    expect(result).toHaveProperty('comparisonPeriod');

    // Period dates are valid ISO strings
    expect(new Date(result.period.start).toISOString()).toBe(result.period.start);
    expect(new Date(result.period.end).toISOString()).toBe(result.period.end);
    expect(new Date(result.comparisonPeriod.start).toISOString()).toBe(result.comparisonPeriod.start);
    expect(new Date(result.comparisonPeriod.end).toISOString()).toBe(result.comparisonPeriod.end);

    // Current period should be after comparison period
    expect(new Date(result.period.start).getTime()).toBeGreaterThanOrEqual(
      new Date(result.comparisonPeriod.end).getTime(),
    );

    const { metrics } = result;

    // All four metrics present
    expect(metrics).toHaveProperty('deploymentFrequency');
    expect(metrics).toHaveProperty('leadTime');
    expect(metrics).toHaveProperty('changeFailureRate');
    expect(metrics).toHaveProperty('mttr');

    // Verify each metric value structure
    for (const key of ['deploymentFrequency', 'leadTime', 'changeFailureRate', 'mttr'] as const) {
      const mv = metrics[key];
      expect(typeof mv.value).toBe('number');
      expect(mv.value).toBeGreaterThanOrEqual(0);
      expect(VALID_METRIC_UNITS).toContain(mv.unit);
      expect(VALID_PERFORMANCE_LEVELS).toContain(mv.performanceLevel);
      expect(VALID_TREND_DIRECTIONS).toContain(mv.trend.direction);
      expect(typeof mv.trend.changePercent).toBe('number');
      expect(typeof mv.sampleSize).toBe('number');
      expect(mv.sampleSize).toBeGreaterThanOrEqual(0);
    }
  });

  it('should mark leadTime as proxy', async () => {
    const result = await service.getMetrics('30d');
    expect(result.metrics.leadTime.isProxy).toBe(true);
  });

  it('should produce non-zero values for deployment frequency (mock pool has data)', async () => {
    const result = await service.getMetrics('30d');
    expect(result.metrics.deploymentFrequency.value).toBeGreaterThan(0);
    expect(result.metrics.deploymentFrequency.sampleSize).toBeGreaterThan(0);
  });

  it('should work for all valid time ranges', async () => {
    for (const range of ['7d', '30d', '90d']) {
      const result = await service.getMetrics(range);
      expect(result.metrics.deploymentFrequency.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('should filter by service when serviceFilter is provided', async () => {
    const all = await service.getMetrics('30d');
    const filtered = await service.getMetrics('30d', 'gateway');

    // Filtered should have different values (gateway alone vs all services)
    // At minimum, the deployment frequency for one service should be less
    expect(filtered.metrics.deploymentFrequency.sampleSize).toBeLessThan(
      all.metrics.deploymentFrequency.sampleSize,
    );
  });

  it('should return zeros for a nonexistent service filter', async () => {
    const result = await service.getMetrics('30d', 'nonexistent-service');
    expect(result.metrics.deploymentFrequency.value).toBe(0);
    expect(result.metrics.deploymentFrequency.sampleSize).toBe(0);
  });
});

// ============================================================================
// MockDoraMetricsService — getTrends
// ============================================================================

describe('MockDoraMetricsService.getTrends', () => {
  let service: MockDoraMetricsService;

  beforeEach(() => {
    service = new MockDoraMetricsService();
  });

  it('should return daily granularity for 30d range', async () => {
    const result = await service.getTrends('30d');

    expect(result.granularity).toBe('day');
    expect(result).toHaveProperty('trends');
    expect(result).toHaveProperty('period');

    const { trends } = result;
    expect(trends.deploymentFrequency.granularity).toBe('day');
    expect(trends.leadTime.granularity).toBe('day');
    expect(trends.changeFailureRate.granularity).toBe('day');
    expect(trends.mttr.granularity).toBe('day');

    // Should have ~30 data points for 30d daily
    expect(trends.deploymentFrequency.series.length).toBeGreaterThanOrEqual(28);
    expect(trends.deploymentFrequency.series.length).toBeLessThanOrEqual(31);
  });

  it('should return weekly granularity for 90d range', async () => {
    const result = await service.getTrends('90d');

    expect(result.granularity).toBe('week');
    expect(result.trends.deploymentFrequency.granularity).toBe('week');

    // Should have ~13 data points for 90d weekly
    expect(result.trends.deploymentFrequency.series.length).toBeGreaterThanOrEqual(12);
    expect(result.trends.deploymentFrequency.series.length).toBeLessThanOrEqual(14);
  });

  it('should return daily granularity for 7d range', async () => {
    const result = await service.getTrends('7d');
    expect(result.granularity).toBe('day');
    expect(result.trends.deploymentFrequency.series.length).toBe(7);
  });

  it('should have valid series data points (x = date string, y = number or null)', async () => {
    const result = await service.getTrends('30d');

    for (const metricKey of ['deploymentFrequency', 'leadTime', 'changeFailureRate', 'mttr'] as const) {
      const { series } = result.trends[metricKey];
      expect(series.length).toBeGreaterThan(0);

      for (const point of series) {
        expect(typeof point.x).toBe('string');
        // x should be a YYYY-MM-DD date string
        expect(point.x).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // MTTR buckets are null when an interval has no resolved incident
        // (incident-based mode); other metrics are always numeric and >= 0.
        if (metricKey === 'mttr') {
          expect(point.y === null || typeof point.y === 'number').toBe(true);
          if (point.y !== null) expect(point.y).toBeGreaterThanOrEqual(0);
        } else {
          expect(typeof point.y).toBe('number');
          expect(point.y as number).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('should produce series with ascending dates', async () => {
    const result = await service.getTrends('30d');
    const dates = result.trends.deploymentFrequency.series.map((p) => p.x);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it('should filter trends by service', async () => {
    const all = await service.getTrends('30d');
    const filtered = await service.getTrends('30d', 'docs');

    // Should have same number of buckets
    expect(filtered.trends.deploymentFrequency.series.length).toBe(
      all.trends.deploymentFrequency.series.length,
    );

    // But values should generally be lower (one service vs all)
    const allSum = all.trends.deploymentFrequency.series.reduce((s, p) => s + (p.y ?? 0), 0);
    const filteredSum = filtered.trends.deploymentFrequency.series.reduce((s, p) => s + (p.y ?? 0), 0);
    expect(filteredSum).toBeLessThan(allSum);
  });
});

// ============================================================================
// MockDoraMetricsService — getRankings
// ============================================================================

describe('MockDoraMetricsService.getRankings', () => {
  let service: MockDoraMetricsService;

  beforeEach(() => {
    service = new MockDoraMetricsService();
  });

  it('should return rankings for all services', async () => {
    const result = await service.getRankings('30d', 'deploymentFrequency', 'desc');

    expect(result).toHaveProperty('rankings');
    expect(result).toHaveProperty('period');
    expect(result.rankings.length).toBe(5); // 5 mock services

    const serviceNames = result.rankings.map((r) => r.serviceName).sort();
    expect(serviceNames).toEqual(EXPECTED_SERVICES);
  });

  it('should have correct ranking entry shape', async () => {
    const result = await service.getRankings('30d', 'deploymentFrequency', 'desc');
    const entry = result.rankings[0]!;

    expect(typeof entry.serviceId).toBe('string');
    expect(typeof entry.serviceName).toBe('string');
    expect(typeof entry.totalDeployments).toBe('number');
    expect(entry.totalDeployments).toBeGreaterThan(0);

    for (const key of ['deploymentFrequency', 'leadTime', 'changeFailureRate', 'mttr'] as const) {
      const m = entry.metrics[key];
      expect(typeof m.value).toBe('number');
      expect(VALID_PERFORMANCE_LEVELS).toContain(m.performanceLevel);
    }
  });

  it('should sort by deploymentFrequency desc', async () => {
    const result = await service.getRankings('30d', 'deploymentFrequency', 'desc');
    const values = result.rankings.map((r) => r.metrics.deploymentFrequency.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });

  it('should sort by deploymentFrequency asc', async () => {
    const result = await service.getRankings('30d', 'deploymentFrequency', 'asc');
    const values = result.rankings.map((r) => r.metrics.deploymentFrequency.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('should sort by leadTime desc', async () => {
    const result = await service.getRankings('30d', 'leadTime', 'desc');
    const values = result.rankings.map((r) => r.metrics.leadTime.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });

  it('should sort by changeFailureRate asc', async () => {
    const result = await service.getRankings('30d', 'changeFailureRate', 'asc');
    const values = result.rankings.map((r) => r.metrics.changeFailureRate.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('should have valid period dates', async () => {
    const result = await service.getRankings('30d', 'deploymentFrequency', 'desc');
    expect(new Date(result.period.start).toISOString()).toBe(result.period.start);
    expect(new Date(result.period.end).toISOString()).toBe(result.period.end);
  });
});

// ============================================================================
// MockDoraMetricsService — getServices
// ============================================================================

describe('MockDoraMetricsService.getServices', () => {
  it('should return all five services sorted alphabetically', () => {
    const service = new MockDoraMetricsService();
    const services = service.getServices();
    expect(services).toEqual(EXPECTED_SERVICES);
  });
});

// ============================================================================
// Factory: isPreviewMode / getDoraMetricsService
// ============================================================================

describe('isPreviewMode', () => {
  const originalEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalEnv;
    }
  });

  it('should return true when VERCEL_ENV is "preview"', () => {
    process.env.VERCEL_ENV = 'preview';
    expect(isPreviewMode()).toBe(true);
  });

  it('should return false when VERCEL_ENV is "production"', () => {
    process.env.VERCEL_ENV = 'production';
    expect(isPreviewMode()).toBe(false);
  });

  it('should return false when VERCEL_ENV is undefined', () => {
    delete process.env.VERCEL_ENV;
    expect(isPreviewMode()).toBe(false);
  });

  it('should return false when VERCEL_ENV is empty string', () => {
    process.env.VERCEL_ENV = '';
    expect(isPreviewMode()).toBe(false);
  });
});

describe('getDoraMetricsService', () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalCi = process.env.CI;
  const originalGithubActions = process.env.GITHUB_ACTIONS;

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
  });

  it('should return MockDoraMetricsService in preview mode', () => {
    process.env.VERCEL_ENV = 'preview';
    const svc = getDoraMetricsService({} as any);
    expect(svc).toBeInstanceOf(MockDoraMetricsService);
  });

  it('should return MockDoraMetricsService in GitHub Actions CI', () => {
    delete process.env.VERCEL_ENV;
    process.env.GITHUB_ACTIONS = 'true';
    const svc = getDoraMetricsService({ from: vi.fn() } as any);
    expect(svc).toBeInstanceOf(MockDoraMetricsService);
  });

  it('should return the real DoraMetricsService when only ambient CI is set (mock-data leak guard)', () => {
    // A non-preview, non-GitHub-Actions environment that exports CI=true (e.g.
    // some PaaS build steps) must NOT receive mock data. Keying on
    // GITHUB_ACTIONS instead of CI prevents that leak.
    delete process.env.VERCEL_ENV;
    delete process.env.GITHUB_ACTIONS;
    process.env.CI = 'true';
    const mockSupabase = { from: vi.fn() } as any;
    const svc = getDoraMetricsService(mockSupabase);
    expect(svc).toBeInstanceOf(DoraMetricsService);
  });

  it('should return DoraMetricsService in production mode', () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    const mockSupabase = { from: vi.fn() } as any;
    const svc = getDoraMetricsService(mockSupabase);
    expect(svc).toBeInstanceOf(DoraMetricsService);
  });

  it('should return DoraMetricsService when VERCEL_ENV is undefined', () => {
    delete process.env.VERCEL_ENV;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    const mockSupabase = { from: vi.fn() } as any;
    const svc = getDoraMetricsService(mockSupabase);
    expect(svc).toBeInstanceOf(DoraMetricsService);
  });
});
