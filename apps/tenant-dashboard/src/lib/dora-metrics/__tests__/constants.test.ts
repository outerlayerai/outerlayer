// ---------------------------------------------------------------------------
// DORA Metrics - Shared Pure Helpers Unit Tests
//
// These exercise the pure computation primitives in ../constants directly
// (no HTTP boundary, no clock), pinning the corrected DORA definitions:
//   - DF counts ALL completed deploys
//   - Lead time never blends commit and duration clocks
//   - CFR counts only incident-correlated SUCCESSFUL deploys, over successes
//   - MTTR uses one source per window; the chosen source yields null when a
//     population has no data, never a cross-source fallback
//   - Offset-based UTC bucketing matches between mock and real services
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
  MS_PER_HOUR,
  MS_PER_DAY,
  MS_PER_WEEK,
  TREND_THRESHOLD_PERCENT,
  median,
  roundTo,
  computeChangePercent,
  resolveLeadTimeMode,
  leadTimesMs,
  incidentDeploymentIds,
  resolveMttrMode,
  resolutionTimesMs,
  deploymentRecoveryHours,
  computeMetrics,
  bucketByTime,
  formatDateLabel,
  trendDirectionFromChange,
  type DeploymentLike,
  type IncidentLike,
} from '../constants';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let dCounter = 0;
function d(overrides: Partial<DeploymentLike> = {}): DeploymentLike {
  dCounter += 1;
  return {
    id: `d-${dCounter}`,
    service: 'svc',
    status: 'success',
    duration_ms: 60 * 60 * 1000,
    first_commit_at: null,
    completed_at: '2026-01-20T01:00:00.000Z',
    started_at: '2026-01-20T00:00:00.000Z',
    ...overrides,
  };
}

let iCounter = 0;
function inc(overrides: Partial<IncidentLike> = {}): IncidentLike {
  iCounter += 1;
  return {
    deployment_id: `d-${iCounter}`,
    resolution_ms: 2 * MS_PER_HOUR,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('time constants', () => {
  it('should relate hour/day/week by the calendar', () => {
    expect(MS_PER_HOUR).toBe(3_600_000);
    expect(MS_PER_DAY).toBe(24 * MS_PER_HOUR);
    expect(MS_PER_WEEK).toBe(7 * MS_PER_DAY);
    expect(TREND_THRESHOLD_PERCENT).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// median / roundTo / computeChangePercent
// ---------------------------------------------------------------------------

describe('median', () => {
  it('should return the middle value for odd-length input', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('should average the two middle values for even-length input', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('should return 0 for an empty array', () => {
    expect(median([])).toBe(0);
  });
});

describe('roundTo', () => {
  it('should round to the requested decimals', () => {
    expect(roundTo(0.3333, 2)).toBe(0.33);
    expect(roundTo(2.005, 2)).toBe(2.01);
  });
});

describe('computeChangePercent', () => {
  it('should be 0 when both are 0', () => {
    expect(computeChangePercent(0, 0)).toBe(0);
  });
  it('should be 100 when previous is 0 and current is non-zero', () => {
    expect(computeChangePercent(5, 0)).toBe(100);
  });
  it('should compute signed percent change to one decimal', () => {
    expect(computeChangePercent(12, 10)).toBe(20);
    expect(computeChangePercent(8, 10)).toBe(-20);
  });
});

describe('trendDirectionFromChange', () => {
  it('should classify by the 5% threshold', () => {
    expect(trendDirectionFromChange(6)).toBe('up');
    expect(trendDirectionFromChange(-6)).toBe('down');
    expect(trendDirectionFromChange(5)).toBe('stable');
    expect(trendDirectionFromChange(-5)).toBe('stable');
  });
});

// ---------------------------------------------------------------------------
// Lead time
// ---------------------------------------------------------------------------

describe('resolveLeadTimeMode', () => {
  it('should be commit when ANY deploy has first_commit_at', () => {
    expect(resolveLeadTimeMode([d({ first_commit_at: null }), d({ first_commit_at: '2026-01-19T00:00:00.000Z' })])).toBe('commit');
  });
  it('should be duration when NO deploy has first_commit_at', () => {
    expect(resolveLeadTimeMode([d({ first_commit_at: null }), d({ first_commit_at: null })])).toBe('duration');
  });
});

describe('leadTimesMs', () => {
  it('should use only commit gaps in commit mode and exclude rows without first_commit_at', () => {
    const rows = [
      d({ first_commit_at: '2026-01-19T14:00:00.000Z', completed_at: '2026-01-20T00:00:00.000Z' }), // 10h
      d({ first_commit_at: null, duration_ms: 6 * MS_PER_HOUR }), // excluded — never blended
      d({ first_commit_at: '2026-01-21T22:00:00.000Z', completed_at: '2026-01-22T00:00:00.000Z' }), // 2h
    ];
    expect(leadTimesMs(rows, 'commit')).toEqual([10 * MS_PER_HOUR, 2 * MS_PER_HOUR]);
  });
  it('should drop non-positive commit gaps', () => {
    const rows = [
      d({ first_commit_at: '2026-01-20T06:00:00.000Z', completed_at: '2026-01-20T00:00:00.000Z' }), // negative
      d({ first_commit_at: '2026-01-20T20:00:00.000Z', completed_at: '2026-01-21T00:00:00.000Z' }), // 4h
    ];
    expect(leadTimesMs(rows, 'commit')).toEqual([4 * MS_PER_HOUR]);
  });
  it('should use only positive duration_ms in duration mode', () => {
    const rows = [
      d({ duration_ms: null }),
      d({ duration_ms: 0 }),
      d({ duration_ms: 4 * MS_PER_HOUR }),
    ];
    expect(leadTimesMs(rows, 'duration')).toEqual([4 * MS_PER_HOUR]);
  });
});

// ---------------------------------------------------------------------------
// CFR
// ---------------------------------------------------------------------------

describe('incidentDeploymentIds', () => {
  it('should collect non-null correlated deployment ids', () => {
    const ids = incidentDeploymentIds([
      inc({ deployment_id: 'a' }),
      inc({ deployment_id: null }),
      inc({ deployment_id: 'b' }),
    ]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// MTTR
// ---------------------------------------------------------------------------

describe('resolveMttrMode', () => {
  it('should be incident when ANY incident has a positive resolution_ms', () => {
    expect(resolveMttrMode([inc({ resolution_ms: null }), inc({ resolution_ms: 3 * MS_PER_HOUR })])).toBe('incident');
  });
  it('should be deployment when NO incident is resolved', () => {
    expect(resolveMttrMode([inc({ resolution_ms: null }), inc({ resolution_ms: 0 })])).toBe('deployment');
    expect(resolveMttrMode([])).toBe('deployment');
  });
});

describe('resolutionTimesMs', () => {
  it('should keep only positive resolution times', () => {
    expect(
      resolutionTimesMs([
        inc({ resolution_ms: 2 * MS_PER_HOUR }),
        inc({ resolution_ms: null }),
        inc({ resolution_ms: 0 }),
        inc({ resolution_ms: 4 * MS_PER_HOUR }),
      ]),
    ).toEqual([2 * MS_PER_HOUR, 4 * MS_PER_HOUR]);
  });
});

describe('deploymentRecoveryHours', () => {
  it('should pair each failure with the next same-service success', () => {
    const rows = [
      d({ service: 'svc', status: 'failure', started_at: '2026-01-20T00:00:00.000Z' }),
      d({ service: 'svc', status: 'success', started_at: '2026-01-20T06:00:00.000Z' }),
      d({ service: 'svc', status: 'failure', started_at: '2026-01-20T12:00:00.000Z' }),
      d({ service: 'svc', status: 'success', started_at: '2026-01-20T18:00:00.000Z' }),
    ];
    expect(deploymentRecoveryHours(rows)).toEqual([6, 6]);
  });
  it('should NOT pair across services', () => {
    const rows = [
      d({ service: 'a', status: 'failure', started_at: '2026-01-20T00:00:00.000Z' }),
      d({ service: 'b', status: 'success', started_at: '2026-01-20T06:00:00.000Z' }),
    ];
    expect(deploymentRecoveryHours(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — the integrated definition
// ---------------------------------------------------------------------------

describe('computeMetrics', () => {
  it('should count only SUCCESSFUL deploys for DF (8 success + 2 failure over 5 days = 1.6)', () => {
    // Four Keys / dora.dev practice: deployment frequency counts deployments
    // that reached production. Failed attempts are pipeline health, not
    // delivery throughput.
    const rows = [
      ...Array.from({ length: 8 }, () => d({ status: 'success' })),
      d({ status: 'failure', duration_ms: null }),
      d({ status: 'failure', duration_ms: null }),
    ];
    const m = computeMetrics(rows, 5, [], 'duration', 'deployment');
    expect(m.deploymentFrequency).toBe(1.6);
    expect(m.sampleSizes.deploymentFrequency).toBe(8);
  });

  it('should compute CFR over successful deploys only, ignoring pipeline failures', () => {
    const rows = [
      d({ id: 'a', status: 'failure' }), // never shipped
      d({ id: 'b', status: 'success' }),
      d({ id: 'c', status: 'success' }),
    ];
    // Incident on the failed deploy (ignored) + incident on a shipped deploy.
    const incidents = [inc({ deployment_id: 'a' }), inc({ deployment_id: 'c' })];
    const m = computeMetrics(rows, 30, incidents, 'duration', 'incident');
    // Successful: b, c. Incident-correlated successful: c. CFR = 1/2 = 50%.
    expect(m.changeFailureRate).toBe(50);
    expect(m.sampleSizes.changeFailureRate).toBe(2);
  });

  it('should report CFR 0 and sample size 0 when there are no successful deploys', () => {
    const rows = [d({ id: 'a', status: 'failure' }), d({ id: 'b', status: 'failure' })];
    const m = computeMetrics(rows, 30, [inc({ deployment_id: 'a' })], 'duration', 'deployment');
    expect(m.changeFailureRate).toBe(0);
    expect(m.sampleSizes.changeFailureRate).toBe(0);
  });

  it('should set leadTimeIsProxy from the mode', () => {
    expect(computeMetrics([d()], 30, [], 'commit', 'deployment').leadTimeIsProxy).toBe(false);
    expect(computeMetrics([d()], 30, [], 'duration', 'deployment').leadTimeIsProxy).toBe(true);
  });

  it('should yield null MTTR (not a deployment fallback) for an incident-mode population with no resolved incident', () => {
    // A failure→success pair exists, which WOULD give a deployment MTTR, but
    // incident mode must ignore it and return null here.
    const rows = [
      d({ service: 'svc', status: 'failure', started_at: '2026-01-20T00:00:00.000Z' }),
      d({ service: 'svc', status: 'success', started_at: '2026-01-20T06:00:00.000Z' }),
    ];
    const m = computeMetrics(rows, 1, [], 'duration', 'incident');
    expect(m.mttr).toBeNull();
    expect(m.sampleSizes.mttr).toBe(0);
  });

  it('should use incident median for MTTR in incident mode and count resolved incidents as the sample', () => {
    const incidents = [
      inc({ resolution_ms: 1 * MS_PER_HOUR }),
      inc({ resolution_ms: 3 * MS_PER_HOUR }),
      inc({ resolution_ms: 5 * MS_PER_HOUR }),
    ];
    const m = computeMetrics([d()], 30, incidents, 'duration', 'incident');
    expect(m.mttr).toBe(3);
    expect(m.sampleSizes.mttr).toBe(3);
  });

  it('should use deployment recovery MEDIAN (not mean) for MTTR in deployment mode', () => {
    // Three failure→success recoveries of 2h / 4h / 12h across services.
    // Median = 4h; the mean would be 6h — so this pins median, not mean,
    // matching incident-mode MTTR and DORA's skew-resistant convention.
    const rows = [
      d({ id: 'a1', service: 'svc-a', status: 'failure', started_at: '2026-01-20T00:00:00.000Z' }),
      d({ id: 'a2', service: 'svc-a', status: 'success', started_at: '2026-01-20T02:00:00.000Z' }),
      d({ id: 'b1', service: 'svc-b', status: 'failure', started_at: '2026-01-20T00:00:00.000Z' }),
      d({ id: 'b2', service: 'svc-b', status: 'success', started_at: '2026-01-20T04:00:00.000Z' }),
      d({ id: 'c1', service: 'svc-c', status: 'failure', started_at: '2026-01-20T00:00:00.000Z' }),
      d({ id: 'c2', service: 'svc-c', status: 'success', started_at: '2026-01-20T12:00:00.000Z' }),
    ];
    const m = computeMetrics(rows, 1, [], 'duration', 'deployment');
    expect(m.mttr).toBe(4);
    expect(m.sampleSizes.mttr).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// bucketByTime / formatDateLabel
// ---------------------------------------------------------------------------

describe('formatDateLabel', () => {
  it('should produce a UTC YYYY-MM-DD label', () => {
    expect(formatDateLabel(new Date('2026-01-18T23:59:59.000Z'))).toBe('2026-01-18');
  });
});

describe('bucketByTime', () => {
  const start = new Date('2026-01-18T00:00:00.000Z');
  const end = new Date('2026-01-21T00:00:00.000Z'); // 3 daily buckets

  it('should create one empty daily bucket per interval, in order', () => {
    const buckets = bucketByTime<number>([], (x) => x, start, end, 'day');
    expect([...buckets.keys()]).toEqual(['2026-01-18', '2026-01-19', '2026-01-20']);
    for (const v of buckets.values()) expect(v).toEqual([]);
  });

  it('should assign items by integer offset from start (UTC), grouping same-day items', () => {
    const items = [
      new Date('2026-01-18T03:00:00.000Z').getTime(),
      new Date('2026-01-18T15:00:00.000Z').getTime(),
      new Date('2026-01-19T10:00:00.000Z').getTime(),
    ];
    const buckets = bucketByTime(items, (x) => x, start, end, 'day');
    expect(buckets.get('2026-01-18')).toHaveLength(2);
    expect(buckets.get('2026-01-19')).toHaveLength(1);
    expect(buckets.get('2026-01-20')).toHaveLength(0);
  });

  it('should drop items before the window start', () => {
    const items = [new Date('2026-01-17T12:00:00.000Z').getTime()];
    const buckets = bucketByTime(items, (x) => x, start, end, 'day');
    for (const v of buckets.values()) expect(v).toEqual([]);
  });

  it('should bucket weekly when granularity is week', () => {
    const wkEnd = new Date('2026-02-08T00:00:00.000Z'); // 3 weekly buckets from 01-18
    const buckets = bucketByTime<number>([], (x) => x, start, wkEnd, 'week');
    expect([...buckets.keys()]).toEqual(['2026-01-18', '2026-01-25', '2026-02-01']);
  });
});
