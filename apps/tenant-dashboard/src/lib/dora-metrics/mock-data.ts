/**
 * Mock Data Pool — DORA Metrics
 *
 * Generates deterministic platform deployment records for preview environments
 * where the platform_deployment table has no real data.
 *
 * Uses the same seeded-PRNG approach as the analytics mock-data.ts.
 */

// ============================================================================
// Seeded PRNG (Lehmer / Park-Miller) — identical to analytics mock
// ============================================================================

function createRng(seed: number) {
  let s = Math.abs(seed) || 1;
  return {
    next(): number {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    },
    nextInt(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.nextInt(0, arr.length - 1)] as T;
    },
  };
}

export interface MockDeployment {
  id: string;
  service: string;
  environment: string;
  status: 'success' | 'failure';
  commit_sha: string;
  commit_message: string;
  branch: string;
  failure_reason: string | null;
  duration_ms: number | null;
  triggered_by: string;
  pipeline_url: string;
  /** Present on the shape for parity with PlatformDeploymentRow. Mock data
   *  leaves this null so lead time stays a duration-based proxy (isProxy=true). */
  first_commit_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

/** Minimal incident shape the mock service feeds into the shared CFR/MTTR
 *  helpers. Mirrors the fields PlatformIncidentRow exposes to those helpers. */
export interface MockIncident {
  id: string;
  service: string | null;
  status: string;
  deployment_id: string | null;
  started_at: string;
  resolved_at: string | null;
  resolution_ms: number | null;
}

// ============================================================================
// Constants
// ============================================================================

const SERVICES = [
  'tenant-dashboard',
  'gateway',
  'docs',
  'marketing-site',
  'ingestion-worker',
] as const;

/** Base deploys/day rate per service — gives each a distinct DORA profile. */
const SERVICE_PROFILES: Record<string, { deploysPerDay: number; failureRate: number; avgDurationMs: number }> = {
  'tenant-dashboard': { deploysPerDay: 3.5, failureRate: 0.06, avgDurationMs: 180_000 },
  'gateway':          { deploysPerDay: 2.0, failureRate: 0.03, avgDurationMs: 90_000 },
  'docs':             { deploysPerDay: 0.8, failureRate: 0.02, avgDurationMs: 60_000 },
  'marketing-site':   { deploysPerDay: 0.4, failureRate: 0.08, avgDurationMs: 120_000 },
  'ingestion-worker': { deploysPerDay: 1.2, failureRate: 0.10, avgDurationMs: 150_000 },
};

const BRANCHES = ['main', 'main', 'main', 'staging', 'feature/auth-v2', 'fix/timeout'] as const;

const COMMIT_MESSAGES = [
  'feat: add user preferences page',
  'fix: resolve timeout in health check',
  'chore: bump dependencies',
  'feat: implement rate limiting',
  'fix: correct RLS policy for tenants',
  'refactor: extract shared utils',
  'feat: add webhook retry logic',
  'fix: handle null response from API',
  'chore: update CI workflow',
  'feat: add dark mode support',
  'fix: memory leak in connection pool',
  'feat: real-time notifications',
  'chore: migrate to new linter config',
  'fix: pagination offset error',
  'feat: add export to CSV',
] as const;

const FAILURE_REASONS = [
  'Type error in src/lib/auth.ts',
  'Integration test timeout',
  'Build OOM — exceeded 4GB memory limit',
  'Deployment health check failed (503)',
  'Database migration conflict',
  'Lint errors — unused import',
] as const;

// ============================================================================
// Generator
// ============================================================================

/**
 * Generate ~90 days of deployment data across all services.
 * Seeded for determinism — same data on every preview deploy.
 */
export function generateDeployments(seed = 42): MockDeployment[] {
  const rng = createRng(seed);
  const deployments: MockDeployment[] = [];
  const now = new Date();

  // Generate 100 days of history (covers 90d range + comparison period)
  const startDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

  for (const service of SERVICES) {
    const profile = SERVICE_PROFILES[service]!;
    const currentDate = new Date(startDate);

    while (currentDate < now) {
      // Probabilistically create deploys for this day based on rate
      const deploysToday = Math.floor(profile.deploysPerDay + (rng.next() - 0.3));

      for (let i = 0; i < Math.max(0, deploysToday); i++) {
        const isFailed = rng.next() < profile.failureRate;
        const hourOffset = rng.nextInt(8, 18); // business hours
        const minuteOffset = rng.nextInt(0, 59);

        const startedAt = new Date(currentDate);
        startedAt.setHours(hourOffset, minuteOffset, 0, 0);

        // Vary duration around the service average
        const durationVariance = 0.5 + rng.next(); // 0.5x to 1.5x
        const durationMs = Math.round(profile.avgDurationMs * durationVariance);

        const completedAt = new Date(startedAt.getTime() + durationMs);
        const sha = Array.from({ length: 8 }, () =>
          rng.nextInt(0, 15).toString(16)
        ).join('');

        deployments.push({
          id: crypto.randomUUID(),
          service,
          environment: rng.next() < 0.85 ? 'production' : 'staging',
          status: isFailed ? 'failure' : 'success',
          commit_sha: sha + sha.split('').reverse().join(''),
          commit_message: rng.pick(COMMIT_MESSAGES),
          branch: rng.pick(BRANCHES),
          failure_reason: isFailed ? rng.pick(FAILURE_REASONS) : null,
          duration_ms: durationMs,
          triggered_by: 'github-actions',
          pipeline_url: `https://github.com/agentmark-ai/app/actions/runs/${rng.nextInt(10000000, 99999999)}`,
          first_commit_at: null,
          started_at: startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          created_at: startedAt.toISOString(),
        });
      }

      // Advance one day
      currentDate.setDate(currentDate.getDate() + 1);
    }
  }

  // Sort by started_at ascending (same as real service query)
  deployments.sort((a, b) => a.started_at.localeCompare(b.started_at));

  return deployments;
}

// ============================================================================
// Cached Pool (regenerates daily, same as analytics mock)
// ============================================================================

let _pool: MockDeployment[] | null = null;
let _poolDate: string | null = null;

export function getMockDeployments(): MockDeployment[] {
  const today = new Date().toISOString().split('T')[0] as string;
  if (!_pool || _poolDate !== today) {
    _pool = generateDeployments();
    _poolDate = today;
  }
  return _pool;
}

// ============================================================================
// Incidents
// ============================================================================

/**
 * Generate incidents correlated to a subset of SUCCESSFUL deployments.
 *
 * Under the corrected DORA definitions, change failure rate counts successful
 * deploys that later caused a production incident — pipeline failures never
 * shipped, so they don't count. To give the mock a non-zero, realistic CFR and
 * MTTR, we correlate ~`failureRate` of each service's successful deploys with a
 * resolved incident. Deterministic (seeded) so preview data is stable.
 */
export function generateIncidents(
  deployments: MockDeployment[],
  seed = 1337,
): MockIncident[] {
  const rng = createRng(seed);
  const incidents: MockIncident[] = [];

  for (const d of deployments) {
    if (d.status !== 'success') continue;
    const profile = SERVICE_PROFILES[d.service];
    if (!profile) continue;
    // Correlate at the service's failure rate.
    if (rng.next() >= profile.failureRate) continue;

    const startedAt = new Date(d.completed_at ?? d.started_at);
    // Resolution between 15 minutes and 8 hours.
    const resolutionMs = rng.nextInt(15 * 60 * 1000, 8 * 60 * 60 * 1000);
    const resolvedAt = new Date(startedAt.getTime() + resolutionMs);

    incidents.push({
      id: crypto.randomUUID(),
      service: d.service,
      status: 'resolved',
      deployment_id: d.id,
      started_at: startedAt.toISOString(),
      resolved_at: resolvedAt.toISOString(),
      resolution_ms: resolutionMs,
    });
  }

  return incidents;
}

let _incidentPool: MockIncident[] | null = null;
let _incidentPoolDate: string | null = null;

export function getMockIncidents(): MockIncident[] {
  const today = new Date().toISOString().split('T')[0] as string;
  if (!_incidentPool || _incidentPoolDate !== today) {
    _incidentPool = generateIncidents(getMockDeployments());
    _incidentPoolDate = today;
  }
  return _incidentPool;
}
