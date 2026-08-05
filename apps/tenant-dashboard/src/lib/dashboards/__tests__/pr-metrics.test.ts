/**
 * PR-lifecycle metric math — pure functions, no I/O.
 *
 * These pin the metric DEFINITIONS: decided-cohort merge rate (open PRs are
 * undecided, not failures), attribution via pr-link number OR session
 * branch, merge-date bucketing for cycle time, and R-7 linear-interpolation
 * percentiles. If one of these assertions has to change, the metric's
 * meaning changed — treat it as a product decision, not a refactor.
 */

import {
  computeAgentPrCycleTimeBreakdown,
  computeAgentPrCycleTimeTrend,
  computeAgentPrMergeRate,
  computeAgentPrReopenRate,
  computeAgentPrRevertRate,
  computeAgentCleanJobRate,
  computeAgentPrUnreviewedMergeRate,
  computeAgentShareOfMergedPrs,
  computeAgentVsHumanFirstPassCi,
  computeShippedAutonomyLadder,
  computeAgentPrOutcomeByScore,
  computeAgentVsHumanPrComparison,
  computeAgentVsHumanPrSize,
  computeMergedPrSizeTrend,
  computeDirectCostPerMergedPr,
  computeFullyLoadedCostPerMergedPr,
  computeUnshippedSpendShare,
  countAgentMergedPrs,
  type PrCostAttributionRow,
  isAgentPr,
  percentile,
  priorWindow,
  type AgentPrAttribution,
  type PrLifecycleRow,
} from '../pr-metrics';

const ATTR: AgentPrAttribution = {
  branches: ['agent/feat-x', 'agent/feat-y'],
  prNumbers: [512],
};

function pr(over: Partial<PrLifecycleRow>): PrLifecycleRow {
  return {
    pr_number: 1,
    head_branch: 'agent/feat-x',
    state: 'merged',
    opened_at: '2026-07-01T09:00:00+00:00',
    closed_at: '2026-07-02T09:00:00+00:00',
    merged_at: '2026-07-02T09:00:00+00:00',
    ...over,
  };
}

const WINDOW = { start: '2026-07-01', end: '2026-07-07' };

describe('isAgentPr', () => {
  it('attributes via explicit pr-link number even when the branch is unknown', () => {
    expect(isAgentPr({ pr_number: 512, head_branch: 'human/rename' }, ATTR)).toBe(true);
  });

  it('attributes via session branch even without a pr-link', () => {
    expect(isAgentPr({ pr_number: 999, head_branch: 'agent/feat-y' }, ATTR)).toBe(true);
  });

  it('does not attribute a PR matching neither', () => {
    expect(isAgentPr({ pr_number: 999, head_branch: 'human/rename' }, ATTR)).toBe(false);
  });
});

describe('priorWindow', () => {
  it('is the immediately preceding window of equal length (same math as computePriorPeriod)', () => {
    // 7-day window → the 7 days before it, ending the day before start.
    expect(priorWindow({ start: '2026-07-08', end: '2026-07-14' })).toEqual({
      start: '2026-07-01',
      end: '2026-07-07',
    });
    // Single-day window → the single prior day.
    expect(priorWindow({ start: '2026-07-14', end: '2026-07-14' })).toEqual({
      start: '2026-07-13',
      end: '2026-07-13',
    });
  });
});

describe('percentile (R-7 linear interpolation)', () => {
  it('interpolates between ranks and pins the exact convention', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.95)).toBeCloseTo(19.5, 10);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([3, 1, 2], 1)).toBe(3); // unsorted input, max
    expect(percentile([], 0.5)).toBe(0); // never NaN into a widget
  });
});

describe('computeAgentPrMergeRate', () => {
  it('computes decided-cohort rates for current AND prior windows in one pass', () => {
    const rows: PrLifecycleRow[] = [
      // current window: 2 merged + 1 closed-unmerged agent PRs → 2/3
      pr({ pr_number: 1, closed_at: '2026-07-02T09:00:00Z', merged_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, closed_at: '2026-07-03T09:00:00Z', merged_at: '2026-07-03T09:00:00Z' }),
      pr({ pr_number: 3, state: 'closed', merged_at: null, closed_at: '2026-07-04T09:00:00Z' }),
      // prior window (Jun 24–30): 1 closed-unmerged agent PR → 0/1
      pr({ pr_number: 4, state: 'closed', merged_at: null, closed_at: '2026-06-25T09:00:00Z' }),
      // non-agent PR in current window: never counted
      pr({ pr_number: 5, head_branch: 'human/fix', closed_at: '2026-07-02T10:00:00Z' }),
      // open agent PR: undecided, never counted
      pr({ pr_number: 6, state: 'open', closed_at: null, merged_at: null }),
      // decided OUTSIDE both windows: never counted
      pr({ pr_number: 7, closed_at: '2026-05-01T09:00:00Z', merged_at: '2026-05-01T09:00:00Z' }),
    ];

    expect(computeAgentPrMergeRate(rows, ATTR, WINDOW)).toEqual({
      current: { merged: 2, closedUnmerged: 1, rate: 2 / 3 },
      prior: { merged: 0, closedUnmerged: 1, rate: 0 },
    });
  });

  it('counts a pr-link-attributed PR from an unknown branch (explicit link beats branch match)', () => {
    const rows = [
      pr({ pr_number: 512, head_branch: 'human/branch', closed_at: '2026-07-02T09:00:00Z', merged_at: '2026-07-02T09:00:00Z' }),
    ];
    expect(computeAgentPrMergeRate(rows, ATTR, WINDOW).current).toEqual({ merged: 1, closedUnmerged: 0, rate: 1 });
  });

  it('returns rate 0 (not NaN) when nothing was decided', () => {
    expect(computeAgentPrMergeRate([], ATTR, WINDOW)).toEqual({
      current: { merged: 0, closedUnmerged: 0, rate: 0 },
      prior: { merged: 0, closedUnmerged: 0, rate: 0 },
    });
  });

  it('buckets by UTC day of closed_at inclusively at both window edges', () => {
    const rows = [
      pr({ pr_number: 1, closed_at: '2026-07-01T00:00:00Z', merged_at: '2026-07-01T00:00:00Z' }),
      pr({ pr_number: 2, closed_at: '2026-07-07T23:59:59Z', merged_at: '2026-07-07T23:59:59Z' }),
    ];
    expect(computeAgentPrMergeRate(rows, ATTR, WINDOW).current.merged).toBe(2);
  });
});

describe('computeAgentPrCycleTimeTrend', () => {
  it('buckets by merge date with exact p50/p95 hours and per-day merge counts', () => {
    const rows: PrLifecycleRow[] = [
      // July 2: cycle times 24h and 48h
      pr({ pr_number: 1, opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, opened_at: '2026-06-30T10:00:00Z', merged_at: '2026-07-02T10:00:00Z', closed_at: '2026-07-02T10:00:00Z' }),
      // July 4: single 6h merge
      pr({ pr_number: 3, opened_at: '2026-07-04T03:00:00Z', merged_at: '2026-07-04T09:00:00Z', closed_at: '2026-07-04T09:00:00Z' }),
      // non-agent merge the same day: excluded
      pr({ pr_number: 4, head_branch: 'human/fix', opened_at: '2026-07-04T00:00:00Z', merged_at: '2026-07-04T09:00:00Z', closed_at: '2026-07-04T09:00:00Z' }),
      // closed-unmerged: not a cycle-time sample
      pr({ pr_number: 5, state: 'closed', merged_at: null, closed_at: '2026-07-04T09:00:00Z' }),
      // merged outside the window: excluded
      pr({ pr_number: 6, opened_at: '2026-06-20T09:00:00Z', merged_at: '2026-06-21T09:00:00Z', closed_at: '2026-06-21T09:00:00Z' }),
    ];

    expect(computeAgentPrCycleTimeTrend(rows, ATTR, WINDOW)).toEqual({
      points: [
        { date: '2026-07-02', p50Hours: 36, p95Hours: 46.8, merged: 2 },
        { date: '2026-07-04', p50Hours: 6, p95Hours: 6, merged: 1 },
      ],
    });
  });

  it('skips rows with missing timestamps or merged-before-opened (never plots negative hours)', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 1, opened_at: null, merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, opened_at: '2026-07-03T09:00:00Z', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
    ];
    expect(computeAgentPrCycleTimeTrend(rows, ATTR, WINDOW)).toEqual({ points: [] });
  });

  it('returns points ascending by date regardless of input order', () => {
    const rows = [
      pr({ pr_number: 1, opened_at: '2026-07-05T00:00:00Z', merged_at: '2026-07-05T02:00:00Z', closed_at: '2026-07-05T02:00:00Z' }),
      pr({ pr_number: 2, opened_at: '2026-07-02T00:00:00Z', merged_at: '2026-07-02T02:00:00Z', closed_at: '2026-07-02T02:00:00Z' }),
    ];
    const { points } = computeAgentPrCycleTimeTrend(rows, ATTR, WINDOW);
    expect(points.map((p) => p.date)).toEqual(['2026-07-02', '2026-07-05']);
  });
});

describe('computeAgentPrCycleTimeBreakdown', () => {
  it('splits the merged cohort into per-phase median hours, in chronological order', () => {
    const rows: PrLifecycleRow[] = [
      // A: coding 2h, pickup 4h, review 4h, merge 2h
      pr({
        pr_number: 1,
        opened_at: '2026-07-01T00:00:00Z',
        ready_for_review_at: '2026-07-01T02:00:00Z',
        first_review_at: '2026-07-01T06:00:00Z',
        first_approved_at: '2026-07-01T10:00:00Z',
        merged_at: '2026-07-01T12:00:00Z',
        closed_at: '2026-07-01T12:00:00Z',
      }),
      // B: coding 4h, pickup 6h, review 8h, merge 4h
      pr({
        pr_number: 2,
        opened_at: '2026-07-02T00:00:00Z',
        ready_for_review_at: '2026-07-02T04:00:00Z',
        first_review_at: '2026-07-02T10:00:00Z',
        first_approved_at: '2026-07-02T18:00:00Z',
        merged_at: '2026-07-02T22:00:00Z',
        closed_at: '2026-07-02T22:00:00Z',
      }),
      // non-agent: excluded from every phase
      pr({
        pr_number: 3,
        head_branch: 'human/fix',
        opened_at: '2026-07-02T00:00:00Z',
        ready_for_review_at: '2026-07-02T01:00:00Z',
        first_review_at: '2026-07-02T02:00:00Z',
        first_approved_at: '2026-07-02T03:00:00Z',
        merged_at: '2026-07-02T04:00:00Z',
        closed_at: '2026-07-02T04:00:00Z',
      }),
      // merged outside the window: excluded
      pr({
        pr_number: 4,
        opened_at: '2026-06-20T00:00:00Z',
        ready_for_review_at: '2026-06-20T02:00:00Z',
        first_review_at: '2026-06-20T06:00:00Z',
        first_approved_at: '2026-06-20T10:00:00Z',
        merged_at: '2026-06-21T00:00:00Z',
        closed_at: '2026-06-21T00:00:00Z',
      }),
    ];

    // p50 of [2,4]=3 (coding), [4,6]=5 (pickup), [4,8]=6 (review), [2,4]=3 (merge)
    expect(computeAgentPrCycleTimeBreakdown(rows, ATTR, WINDOW)).toEqual({
      phases: [
        { phase: 'coding', p50Hours: 3, sampleSize: 2 },
        { phase: 'pickup', p50Hours: 5, sampleSize: 2 },
        { phase: 'review', p50Hours: 6, sampleSize: 2 },
        { phase: 'merge', p50Hours: 3, sampleSize: 2 },
      ],
    });
  });

  it('measures only the phases a PR actually reached — an unreviewed merge feeds coding, never pickup/review/merge', () => {
    const rows: PrLifecycleRow[] = [
      pr({
        pr_number: 1,
        opened_at: '2026-07-03T00:00:00Z',
        ready_for_review_at: '2026-07-03T03:00:00Z',
        first_review_at: null,
        first_approved_at: null,
        merged_at: '2026-07-03T05:00:00Z',
        closed_at: '2026-07-03T05:00:00Z',
      }),
    ];

    // coding = 3h from one PR; the merge phase needs first_approved_at, which is
    // absent — so it stays sampleSize 0, NOT (merged − opened). Per-phase
    // samples are independent; a missing milestone is "not measurable", not 0.
    expect(computeAgentPrCycleTimeBreakdown(rows, ATTR, WINDOW)).toEqual({
      phases: [
        { phase: 'coding', p50Hours: 3, sampleSize: 1 },
        { phase: 'pickup', p50Hours: 0, sampleSize: 0 },
        { phase: 'review', p50Hours: 0, sampleSize: 0 },
        { phase: 'merge', p50Hours: 0, sampleSize: 0 },
      ],
    });
  });

  it('COALESCEs a null ready_for_review_at to opened_at for the pickup baseline (draft time = 0)', () => {
    const rows: PrLifecycleRow[] = [
      pr({
        pr_number: 1,
        opened_at: '2026-07-04T00:00:00Z',
        ready_for_review_at: null,
        first_review_at: '2026-07-04T03:00:00Z',
        first_approved_at: null,
        merged_at: '2026-07-04T05:00:00Z',
        closed_at: '2026-07-04T05:00:00Z',
      }),
    ];

    const { phases } = computeAgentPrCycleTimeBreakdown(rows, ATTR, WINDOW);
    // coding = ready(=opened) − opened = 0h (a measured 0, sampleSize 1)
    expect(phases[0]).toEqual({ phase: 'coding', p50Hours: 0, sampleSize: 1 });
    // pickup baselines at opened (not "unknown"): 3h
    expect(phases[1]).toEqual({ phase: 'pickup', p50Hours: 3, sampleSize: 1 });
  });

  it('skips clock-skewed rows (merged before opened) entirely, like the blended trend', () => {
    const rows: PrLifecycleRow[] = [
      pr({
        pr_number: 1,
        opened_at: '2026-07-05T09:00:00Z',
        first_review_at: '2026-07-05T05:00:00Z',
        first_approved_at: '2026-07-05T06:00:00Z',
        merged_at: '2026-07-05T08:00:00Z', // before opened
        closed_at: '2026-07-05T08:00:00Z',
      }),
    ];
    expect(computeAgentPrCycleTimeBreakdown(rows, ATTR, WINDOW).phases.every((p) => p.sampleSize === 0)).toBe(true);
  });

  it('returns all-zero, all-empty phases (never NaN) when no agent PR merged in the window', () => {
    expect(computeAgentPrCycleTimeBreakdown([], ATTR, WINDOW)).toEqual({
      phases: [
        { phase: 'coding', p50Hours: 0, sampleSize: 0 },
        { phase: 'pickup', p50Hours: 0, sampleSize: 0 },
        { phase: 'review', p50Hours: 0, sampleSize: 0 },
        { phase: 'merge', p50Hours: 0, sampleSize: 0 },
      ],
    });
  });
});

describe('countAgentMergedPrs', () => {
  it('counts agent PRs merged in the window and the prior window, by merge date', () => {
    const rows: PrLifecycleRow[] = [
      // current window (Jul 1–7): 2 merged agent PRs
      pr({ pr_number: 1, merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z' }),
      // prior window (Jun 24–30): 1 merged agent PR
      pr({ pr_number: 3, merged_at: '2026-06-27T09:00:00Z', closed_at: '2026-06-27T09:00:00Z' }),
      // non-agent merged in window: excluded
      pr({ pr_number: 4, head_branch: 'human/fix', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      // agent closed-unmerged in window: not a merge
      pr({ pr_number: 5, state: 'closed', merged_at: null, closed_at: '2026-07-04T09:00:00Z' }),
      // agent merged outside both windows: excluded
      pr({ pr_number: 6, merged_at: '2026-05-01T09:00:00Z', closed_at: '2026-05-01T09:00:00Z' }),
    ];
    expect(countAgentMergedPrs(rows, ATTR, WINDOW)).toEqual({ current: 2, prior: 1 });
  });

  it('buckets by merge_at (not closed_at) and honors inclusive UTC-day window edges', () => {
    const rows = [
      pr({ pr_number: 1, merged_at: '2026-07-01T00:00:00Z', closed_at: '2026-07-01T00:00:00Z' }),
      pr({ pr_number: 2, merged_at: '2026-07-07T23:59:59Z', closed_at: '2026-07-07T23:59:59Z' }),
    ];
    expect(countAgentMergedPrs(rows, ATTR, WINDOW)).toEqual({ current: 2, prior: 0 });
  });
});

describe('computeFullyLoadedCostPerMergedPr', () => {
  it('divides total agent spend by merged-PR count for both periods', () => {
    expect(
      computeFullyLoadedCostPerMergedPr({ current: 4, prior: 2 }, { current: 100, prior: 40 }),
    ).toEqual({ current: 25, prior: 20, currentUnavailable: false });
  });

  it('flags currentUnavailable (never a fabricated $0) when nothing merged this window', () => {
    // Spend but zero merges: the ratio has no denominator. current stays a 0
    // placeholder BUT currentUnavailable is set so callers render "—", not $0.
    expect(
      computeFullyLoadedCostPerMergedPr({ current: 0, prior: 3 }, { current: 50, prior: 30 }),
    ).toEqual({ current: 0, prior: 10, currentUnavailable: true });
  });

  it('is unavailable (not $0) even with zero spend and zero merges', () => {
    expect(
      computeFullyLoadedCostPerMergedPr({ current: 0, prior: 0 }, { current: 0, prior: 0 }),
    ).toEqual({ current: 0, prior: 0, currentUnavailable: true });
  });
});

describe('computeDirectCostPerMergedPr', () => {
  it('attributes cost explicit-link-first, then by branch, and drops unattributed sessions', () => {
    const rows: PrLifecycleRow[] = [
      // PR #1 on agent/feat-x, merged in window
      pr({ pr_number: 1, head_branch: 'agent/feat-x', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      // PR #512 agent-attributed by pr-link, on a human-renamed branch, merged in window
      pr({ pr_number: 512, head_branch: 'human/renamed', merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z' }),
    ];
    const costRows: PrCostAttributionRow[] = [
      { branch: 'agent/feat-x', prNumber: 0, costUsd: 10 }, // branch match → PR #1
      { branch: 'agent/feat-x', prNumber: 1, costUsd: 5 }, // explicit #1 → PR #1
      { branch: 'someotherbranch', prNumber: 512, costUsd: 20 }, // explicit #512 → PR #512 (branch ignored)
      { branch: 'unrelated', prNumber: 0, costUsd: 99 }, // matches neither → unattributed, excluded
    ];
    // attributed = 10 + 5 + 20 = 35, over 2 merged PRs → 17.5
    expect(computeDirectCostPerMergedPr(rows, ATTR, costRows, WINDOW)).toEqual({
      current: 17.5,
      prior: 0,
      currentUnavailable: false,
    });
  });

  it('computes current and prior periods independently by merge date', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 1, head_branch: 'agent/feat-x', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, head_branch: 'agent/feat-y', merged_at: '2026-06-27T09:00:00Z', closed_at: '2026-06-27T09:00:00Z' }),
    ];
    const costRows: PrCostAttributionRow[] = [
      { branch: 'agent/feat-x', prNumber: 0, costUsd: 10 }, // → current PR #1
      { branch: 'agent/feat-y', prNumber: 0, costUsd: 6 }, // → prior PR #2
    ];
    expect(computeDirectCostPerMergedPr(rows, ATTR, costRows, WINDOW)).toEqual({
      current: 10,
      prior: 6,
      currentUnavailable: false,
    });
  });

  it('is unavailable (not $0) when no agent PR merged in the current window, even with attributable spend', () => {
    const rows: PrLifecycleRow[] = [
      // only a prior-window merge
      pr({ pr_number: 1, head_branch: 'agent/feat-x', merged_at: '2026-06-27T09:00:00Z', closed_at: '2026-06-27T09:00:00Z' }),
    ];
    const costRows: PrCostAttributionRow[] = [{ branch: 'agent/feat-x', prNumber: 0, costUsd: 8 }];
    expect(computeDirectCostPerMergedPr(rows, ATTR, costRows, WINDOW)).toEqual({
      current: 0,
      prior: 8,
      currentUnavailable: true,
    });
  });
});

describe('computeAgentPrUnreviewedMergeRate', () => {
  it('counts merged agent PRs with neither a human review nor approval, current + prior', () => {
    const rows: PrLifecycleRow[] = [
      // current window: reviewed (first_review_at)
      pr({ pr_number: 1, merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z', first_review_at: '2026-07-02T08:00:00Z' }),
      // current: approved-only (no review) still counts as reviewed
      pr({ pr_number: 2, merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z', first_approved_at: '2026-07-03T08:00:00Z' }),
      // current: neither → unreviewed
      pr({ pr_number: 3, merged_at: '2026-07-04T09:00:00Z', closed_at: '2026-07-04T09:00:00Z' }),
      // prior window: neither → unreviewed
      pr({ pr_number: 4, merged_at: '2026-06-27T09:00:00Z', closed_at: '2026-06-27T09:00:00Z' }),
      // non-agent unreviewed merge in window: excluded
      pr({ pr_number: 5, head_branch: 'human/fix', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      // closed-unmerged agent PR: not in the merged cohort
      pr({ pr_number: 6, state: 'closed', merged_at: null, closed_at: '2026-07-04T09:00:00Z' }),
    ];
    // current: 3 merged, 1 unreviewed → 1/3; prior: 1 merged, 1 unreviewed → 1
    expect(computeAgentPrUnreviewedMergeRate(rows, ATTR, WINDOW)).toEqual({
      current: { merged: 3, unreviewed: 1, rate: 1 / 3 },
      prior: { merged: 1, unreviewed: 1, rate: 1 },
    });
  });

  it('returns rate 0 (not NaN) when nothing merged', () => {
    expect(computeAgentPrUnreviewedMergeRate([], ATTR, WINDOW)).toEqual({
      current: { merged: 0, unreviewed: 0, rate: 0 },
      prior: { merged: 0, unreviewed: 0, rate: 0 },
    });
  });
});

describe('computeAgentPrReopenRate', () => {
  it('counts decided agent PRs reopened at least once, current + prior, by closed_at', () => {
    const rows: PrLifecycleRow[] = [
      // current window: reopened (count 2)
      pr({ pr_number: 1, closed_at: '2026-07-02T09:00:00Z', reopen_count: 2 }),
      // current: never reopened (explicit 0)
      pr({ pr_number: 2, closed_at: '2026-07-03T09:00:00Z', reopen_count: 0 }),
      // current: reopen_count absent → treated as not reopened
      pr({ pr_number: 3, closed_at: '2026-07-04T09:00:00Z' }),
      // prior window: reopened
      pr({ pr_number: 4, closed_at: '2026-06-27T09:00:00Z', reopen_count: 1 }),
      // non-agent reopened in window: excluded
      pr({ pr_number: 5, head_branch: 'human/fix', closed_at: '2026-07-02T09:00:00Z', reopen_count: 3 }),
      // open agent PR (reopened, still open): undecided, not counted
      pr({ pr_number: 6, state: 'open', closed_at: null, merged_at: null, reopen_count: 1 }),
    ];
    // current: 3 decided, 1 reopened → 1/3; prior: 1 decided, 1 reopened → 1
    expect(computeAgentPrReopenRate(rows, ATTR, WINDOW)).toEqual({
      current: { decided: 3, reopened: 1, rate: 1 / 3 },
      prior: { decided: 1, reopened: 1, rate: 1 },
    });
  });

  it('returns rate 0 (not NaN) when nothing was decided', () => {
    expect(computeAgentPrReopenRate([], ATTR, WINDOW)).toEqual({
      current: { decided: 0, reopened: 0, rate: 0 },
      prior: { decided: 0, reopened: 0, rate: 0 },
    });
  });
});

describe('computeAgentPrRevertRate', () => {
  it('counts decided agent PRs later reverted (reverted_at not null), current + prior, by closed_at', () => {
    const rows: PrLifecycleRow[] = [
      // current window: merged then reverted
      pr({ pr_number: 1, closed_at: '2026-07-02T09:00:00Z', reverted_at: '2026-07-05T09:00:00Z' }),
      // current: merged, held (reverted_at explicitly null)
      pr({ pr_number: 2, closed_at: '2026-07-03T09:00:00Z', reverted_at: null }),
      // current: reverted_at absent → treated as held
      pr({ pr_number: 3, closed_at: '2026-07-04T09:00:00Z' }),
      // prior window: reverted
      pr({ pr_number: 4, closed_at: '2026-06-27T09:00:00Z', reverted_at: '2026-06-28T00:00:00Z' }),
      // non-agent reverted in window: excluded from the agent cohort
      pr({ pr_number: 5, head_branch: 'human/fix', closed_at: '2026-07-02T09:00:00Z', reverted_at: '2026-07-06T09:00:00Z' }),
      // open agent PR: undecided, not counted even if somehow flagged
      pr({ pr_number: 6, state: 'open', closed_at: null, merged_at: null, reverted_at: '2026-07-02T09:00:00Z' }),
    ];
    // current: 3 decided, 1 reverted → 1/3; prior: 1 decided, 1 reverted → 1
    expect(computeAgentPrRevertRate(rows, ATTR, WINDOW)).toEqual({
      current: { decided: 3, reverted: 1, rate: 1 / 3 },
      prior: { decided: 1, reverted: 1, rate: 1 },
    });
  });

  it('returns rate 0 (not NaN) when nothing was decided', () => {
    expect(computeAgentPrRevertRate([], ATTR, WINDOW)).toEqual({
      current: { decided: 0, reverted: 0, rate: 0 },
      prior: { decided: 0, reverted: 0, rate: 0 },
    });
  });
});

describe('computeAgentCleanJobRate', () => {
  it('counts only merged + not-reverted + not-steered agent PRs as clean jobs', () => {
    const attr: AgentPrAttribution = { ...ATTR, steeredPrNumbers: [11] };
    const rows: PrLifecycleRow[] = [
      // clean: merged, not reverted, not steered
      pr({ pr_number: 10, closed_at: '2026-07-02T09:00:00Z', state: 'merged', reverted_at: null }),
      // NOT clean: steered (linked session had > 1 user turn)
      pr({ pr_number: 11, closed_at: '2026-07-03T09:00:00Z', state: 'merged', reverted_at: null }),
      // NOT clean: reverted
      pr({ pr_number: 12, closed_at: '2026-07-04T09:00:00Z', state: 'merged', reverted_at: '2026-07-06T09:00:00Z' }),
      // NOT clean: closed unmerged (didn't land)
      pr({ pr_number: 13, closed_at: '2026-07-05T09:00:00Z', state: 'closed', merged_at: null }),
      // prior window: one clean
      pr({ pr_number: 14, closed_at: '2026-06-27T09:00:00Z', state: 'merged', reverted_at: null }),
      // non-agent clean-looking PR: excluded from the cohort
      pr({ pr_number: 15, head_branch: 'human/fix', closed_at: '2026-07-02T09:00:00Z', state: 'merged' }),
      // open agent PR: undecided, not counted
      pr({ pr_number: 16, state: 'open', closed_at: null, merged_at: null }),
    ];
    // current: 4 decided (10,11,12,13), 1 clean (10) → 1/4; prior: 1 decided, 1 clean → 1
    expect(computeAgentCleanJobRate(rows, attr, WINDOW)).toEqual({
      current: { decided: 4, clean: 1, rate: 1 / 4 },
      prior: { decided: 1, clean: 1, rate: 1 },
    });
  });

  it('treats a PR with no linked (steered) session as un-steered — never asserts unobserved steering', () => {
    // steeredPrNumbers omitted entirely (undefined): a merged, held PR is clean.
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 20, closed_at: '2026-07-02T09:00:00Z', state: 'merged', reverted_at: null }),
    ];
    expect(computeAgentCleanJobRate(rows, ATTR, WINDOW)).toEqual({
      current: { decided: 1, clean: 1, rate: 1 },
      prior: { decided: 0, clean: 0, rate: 0 },
    });
  });

  it('returns rate 0 (not NaN) when nothing was decided', () => {
    expect(computeAgentCleanJobRate([], ATTR, WINDOW)).toEqual({
      current: { decided: 0, clean: 0, rate: 0 },
      prior: { decided: 0, clean: 0, rate: 0 },
    });
  });
});

describe('computeAgentVsHumanPrComparison', () => {
  it('computes both populations with the standalone metrics’ exact cohorts (decided by closed_at, cycle time by merged_at)', () => {
    const rows: PrLifecycleRow[] = [
      // Agent population: two merged (24h and 48h cycles), one closed-unmerged, one reverted.
      pr({ pr_number: 512, head_branch: 'human/rename', opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, head_branch: 'agent/feat-x', opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z', reverted_at: '2026-07-04T00:00:00Z' }),
      pr({ pr_number: 3, head_branch: 'agent/feat-y', state: 'closed', merged_at: null, closed_at: '2026-07-03T09:00:00Z' }),
      // Human population: one merged (12h cycle), one closed-unmerged.
      pr({ pr_number: 4, head_branch: 'human/one', opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-01T21:00:00Z', closed_at: '2026-07-01T21:00:00Z' }),
      pr({ pr_number: 5, head_branch: 'human/two', state: 'closed', merged_at: null, closed_at: '2026-07-02T09:00:00Z' }),
    ];
    expect(computeAgentVsHumanPrComparison(rows, ATTR, WINDOW)).toEqual({
      agent: { decided: 3, merged: 2, mergeRate: 2 / 3, revertRate: 1 / 3, cycleTimeP50Hours: 36 },
      human: { decided: 2, merged: 1, mergeRate: 1 / 2, revertRate: 0, cycleTimeP50Hours: 12 },
    });
  });

  it('excludes open PRs from the decided cohort and out-of-window merges from the cycle cohort', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 512, state: 'open', closed_at: null, merged_at: null }),
      // Merged BEFORE the window: in neither cohort.
      pr({ pr_number: 2, head_branch: 'agent/feat-x', opened_at: '2026-06-20T09:00:00Z', merged_at: '2026-06-21T09:00:00Z', closed_at: '2026-06-21T09:00:00Z' }),
    ];
    expect(computeAgentVsHumanPrComparison(rows, ATTR, WINDOW)).toEqual({
      agent: { decided: 0, merged: 0, mergeRate: 0, revertRate: 0, cycleTimeP50Hours: 0 },
      human: { decided: 0, merged: 0, mergeRate: 0, revertRate: 0, cycleTimeP50Hours: 0 },
    });
  });

  it('skew-guards the cycle sample (merged_at < opened_at) without dropping the row from the decided cohort', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 512, opened_at: '2026-07-03T09:00:00Z', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
    ];
    const result = computeAgentVsHumanPrComparison(rows, ATTR, WINDOW);
    // Still a decided, merged PR for the rate legs — just no cycle-time sample.
    expect(result.agent).toEqual({ decided: 1, merged: 0, mergeRate: 1, revertRate: 0, cycleTimeP50Hours: 0 });
  });
});

describe('computeAgentPrOutcomeByScore', () => {
  it('splits agent PRs into pass/fail cohorts by the score-verdict map, using the same decided/merged cohorts as the vs-human comparison', () => {
    const rows: PrLifecycleRow[] = [
      // Agent, verdict pass: two merged (24h, 48h), one closed-unmerged.
      pr({ pr_number: 512, head_branch: 'human/rename', opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, head_branch: 'agent/feat-x', opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z', reverted_at: '2026-07-04T00:00:00Z' }),
      pr({ pr_number: 3, head_branch: 'agent/feat-y', state: 'closed', merged_at: null, closed_at: '2026-07-03T09:00:00Z' }),
      // Agent, verdict fail: one merged (12h).
      pr({ pr_number: 6, head_branch: 'agent/feat-x', opened_at: '2026-07-01T09:00:00Z', merged_at: '2026-07-01T21:00:00Z', closed_at: '2026-07-01T21:00:00Z' }),
    ];
    const verdicts = new Map([
      [512, true],
      [2, true],
      [3, true],
      [6, false],
    ]);
    expect(computeAgentPrOutcomeByScore(rows, ATTR, verdicts, WINDOW)).toEqual({
      pass: { decided: 3, merged: 2, mergeRate: 2 / 3, revertRate: 1 / 3, cycleTimeP50Hours: 36 },
      fail: { decided: 1, merged: 1, mergeRate: 1, revertRate: 0, cycleTimeP50Hours: 12 },
    });
  });

  it('excludes PRs not agent-attributed, even when the verdict map has an entry for their number', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 999, head_branch: 'human/rename', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
    ];
    const verdicts = new Map([[999, true]]);
    expect(computeAgentPrOutcomeByScore(rows, ATTR, verdicts, WINDOW)).toEqual({
      pass: { decided: 0, merged: 0, mergeRate: 0, revertRate: 0, cycleTimeP50Hours: 0 },
      fail: { decided: 0, merged: 0, mergeRate: 0, revertRate: 0, cycleTimeP50Hours: 0 },
    });
  });

  it('excludes an agent PR with no verdict entry from BOTH cohorts — absence is "no signal", never a fail', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 512, head_branch: 'agent/feat-x', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
    ];
    expect(computeAgentPrOutcomeByScore(rows, ATTR, new Map(), WINDOW)).toEqual({
      pass: { decided: 0, merged: 0, mergeRate: 0, revertRate: 0, cycleTimeP50Hours: 0 },
      fail: { decided: 0, merged: 0, mergeRate: 0, revertRate: 0, cycleTimeP50Hours: 0 },
    });
  });

  it('skew-guards the cycle sample without dropping the row from the decided cohort', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 512, head_branch: 'agent/feat-x', opened_at: '2026-07-03T09:00:00Z', merged_at: '2026-07-02T09:00:00Z', closed_at: '2026-07-02T09:00:00Z' }),
    ];
    const result = computeAgentPrOutcomeByScore(rows, ATTR, new Map([[512, true]]), WINDOW);
    expect(result.pass).toEqual({ decided: 1, merged: 0, mergeRate: 1, revertRate: 0, cycleTimeP50Hours: 0 });
  });
});

describe('computeAgentShareOfMergedPrs', () => {
  it('buckets merged PRs by merge date into current/prior and splits by attribution', () => {
    const rows: PrLifecycleRow[] = [
      // Current window: 2 agent-attributed + 1 human.
      pr({ pr_number: 512, head_branch: 'human/rename', merged_at: '2026-07-02T09:00:00Z' }),
      pr({ pr_number: 2, head_branch: 'agent/feat-y', merged_at: '2026-07-03T09:00:00Z' }),
      pr({ pr_number: 3, head_branch: 'human/one', merged_at: '2026-07-04T09:00:00Z' }),
      // Prior window (Jun 24–30): 1 human only.
      pr({ pr_number: 4, head_branch: 'human/two', merged_at: '2026-06-25T09:00:00Z', closed_at: '2026-06-25T09:00:00Z' }),
      // Closed-unmerged: never counted in a merged-cohort metric.
      pr({ pr_number: 5, head_branch: 'agent/feat-x', state: 'closed', merged_at: null, closed_at: '2026-07-02T09:00:00Z' }),
    ];
    expect(computeAgentShareOfMergedPrs(rows, ATTR, WINDOW)).toEqual({
      current: { agentMerged: 2, totalMerged: 3, share: 2 / 3 },
      prior: { agentMerged: 0, totalMerged: 1, share: 0 },
    });
  });

  it('returns share 0 (not NaN) when nothing merged', () => {
    expect(computeAgentShareOfMergedPrs([], ATTR, WINDOW)).toEqual({
      current: { agentMerged: 0, totalMerged: 0, share: 0 },
      prior: { agentMerged: 0, totalMerged: 0, share: 0 },
    });
  });
});

describe('computeUnshippedSpendShare', () => {
  const mergedRows: PrLifecycleRow[] = [
    pr({ pr_number: 512, head_branch: 'agent/feat-x', merged_at: '2026-07-02T09:00:00Z' }),
  ];

  it('is 1 − attributed÷total, attributing by explicit pr-link then head-branch, each cost row counted once', () => {
    const costRows: PrCostAttributionRow[] = [
      // Explicit link to the merged PR.
      { branch: '', prNumber: 512, costUsd: 40 },
      // Branch match to the same merged PR — a different session group, also counted.
      { branch: 'agent/feat-x', prNumber: 0, costUsd: 20 },
      // Neither: a branch that merged nothing this window.
      { branch: 'agent/feat-y', prNumber: 0, costUsd: 15 },
    ];
    const result = computeUnshippedSpendShare(mergedRows, ATTR, costRows, { current: 100, prior: 0 }, WINDOW);
    expect(result.current).toBeCloseTo(0.4, 10); // 1 - 60/100
    expect(result.currentUnavailable).toBe(false);
  });

  it('clamps to 0 when attributed spend exceeds the window total (cost groups are not date-windowed)', () => {
    const costRows: PrCostAttributionRow[] = [{ branch: '', prNumber: 512, costUsd: 250 }];
    const result = computeUnshippedSpendShare(mergedRows, ATTR, costRows, { current: 100, prior: 0 }, WINDOW);
    expect(result.current).toBe(0);
  });

  it('flags currentUnavailable when there is no spend — 0% unshipped would read as a perfect score', () => {
    const result = computeUnshippedSpendShare(mergedRows, ATTR, [], { current: 0, prior: 50 }, WINDOW);
    expect(result.currentUnavailable).toBe(true);
    expect(result.current).toBe(0);
  });

  it('computes the prior period against PRs merged in the prior window only', () => {
    const rows: PrLifecycleRow[] = [
      ...mergedRows,
      // Prior-window merge on the other agent branch.
      pr({ pr_number: 6, head_branch: 'agent/feat-y', merged_at: '2026-06-25T09:00:00Z', closed_at: '2026-06-25T09:00:00Z' }),
    ];
    const costRows: PrCostAttributionRow[] = [
      { branch: 'agent/feat-y', prNumber: 0, costUsd: 30 },
      { branch: 'agent/feat-x', prNumber: 0, costUsd: 10 },
    ];
    const result = computeUnshippedSpendShare(rows, ATTR, costRows, { current: 100, prior: 60 }, WINDOW);
    // Current attributes only feat-x (10): 1 - 10/100. Prior attributes only feat-y (30): 1 - 30/60.
    expect(result.current).toBeCloseTo(0.9, 10);
    expect(result.prior).toBeCloseTo(0.5, 10);
  });
});

describe('computeMergedPrSizeTrend', () => {
  it('emits a daily median of additions+deletions over ALL merged PRs, skipping rows without line counts', () => {
    const rows: PrLifecycleRow[] = [
      // July 2: agent 100+50, human 20+10, and one merged row with NO size
      // data (NULL = unknown — excluded from the sample, never a 0).
      pr({ pr_number: 1, additions: 100, deletions: 50 }),
      pr({ pr_number: 4, head_branch: 'human/one', additions: 20, deletions: 10 }),
      pr({ pr_number: 5, head_branch: 'human/two', additions: null, deletions: null }),
      // July 3: single sized merge.
      pr({ pr_number: 2, merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z', additions: 7, deletions: 3 }),
      // Outside the window: never a point.
      pr({ pr_number: 3, merged_at: '2026-06-20T09:00:00Z', closed_at: '2026-06-20T09:00:00Z', additions: 999, deletions: 999 }),
      // Closed-unmerged: sized but not merged — excluded.
      pr({ pr_number: 6, state: 'closed', merged_at: null, additions: 40, deletions: 40 }),
    ];
    expect(computeMergedPrSizeTrend(rows, WINDOW)).toEqual({
      points: [
        // median of [150, 30] = 90; the null-sized merge is NOT a third sample.
        { date: '2026-07-02', medianLinesChanged: 90, merged: 2 },
        { date: '2026-07-03', medianLinesChanged: 10, merged: 1 },
      ],
    });
  });

  it('returns no points at all when nothing sized merged (empty state, not a zero line)', () => {
    const rows: PrLifecycleRow[] = [pr({ pr_number: 1, additions: null, deletions: null })];
    expect(computeMergedPrSizeTrend(rows, WINDOW)).toEqual({ points: [] });
  });
});

describe('computeAgentVsHumanPrSize', () => {
  it('computes per-population medians over the merged-in-window cohort, sized rows only', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 1, additions: 100, deletions: 100 }), // agent, 200
      pr({ pr_number: 2, head_branch: 'agent/feat-x', merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z', additions: 50, deletions: 50 }), // agent, 100
      pr({ pr_number: 4, head_branch: 'human/one', additions: 10, deletions: 10 }), // human, 20
      // Agent merge without size data: not a sample.
      pr({ pr_number: 5, head_branch: 'agent/feat-x', additions: null, deletions: null }),
    ];
    expect(computeAgentVsHumanPrSize(rows, ATTR, WINDOW)).toEqual({
      agent: { sized: 2, medianLinesChanged: 150 },
      human: { sized: 1, medianLinesChanged: 20 },
    });
  });
});

describe('computeAgentVsHumanFirstPassCi', () => {
  it('computes failure rate over MEASURED decided rows only — no CI verdict is excluded, never a pass', () => {
    const rows: PrLifecycleRow[] = [
      // Agent: one first-pass failure, one pass, one unmeasured.
      pr({ pr_number: 1, first_ci_status: 'failure' }),
      pr({ pr_number: 2, head_branch: 'agent/feat-x', first_ci_status: 'success' }),
      pr({ pr_number: 3, head_branch: 'agent/feat-y', first_ci_status: null }),
      // Human: one pass.
      pr({ pr_number: 4, head_branch: 'human/one', first_ci_status: 'success' }),
    ];
    expect(computeAgentVsHumanFirstPassCi(rows, ATTR, WINDOW)).toEqual({
      agent: { measured: 2, failed: 1, failureRate: 0.5 },
      human: { measured: 1, failed: 0, failureRate: 0 },
    });
  });

  it('uses the decided cohort (by closed_at) — open PRs and out-of-window decisions never count', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 1, state: 'open', closed_at: null, merged_at: null, first_ci_status: 'failure' }),
      pr({ pr_number: 2, head_branch: 'agent/feat-x', closed_at: '2026-06-20T09:00:00Z', merged_at: '2026-06-20T09:00:00Z', first_ci_status: 'failure' }),
    ];
    expect(computeAgentVsHumanFirstPassCi(rows, ATTR, WINDOW)).toEqual({
      agent: { measured: 0, failed: 0, failureRate: 0 },
      human: { measured: 0, failed: 0, failureRate: 0 },
    });
  });
});

describe('computeShippedAutonomyLadder', () => {
  const items = [
    // Two groups matching PR 1's branch: delegated (3) and supervised (2) —
    // the PR inherits the MINIMUM (supervised).
    { branch: 'agent/feat-x', prNumber: 0, minLevel: 3, classifiedSessions: 2 },
    { branch: 'agent/feat-x', prNumber: 0, minLevel: 2, classifiedSessions: 1 },
    // Explicit pr-link group: autonomous.
    { branch: '', prNumber: 512, minLevel: 4, classifiedSessions: 1 },
    // Assisted group on its own branch.
    { branch: 'agent/z', prNumber: 0, minLevel: 1, classifiedSessions: 1 },
    // Unclassifiable group (legacy sessions only) — must never classify a PR.
    { branch: 'legacy/w', prNumber: 0, minLevel: 0, classifiedSessions: 0 },
  ];

  it('classifies merged PRs at the minimum matched level, splits daily counts, and computes the delegated+ share', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 1 }), // agent/x → min(3,2) = supervised, July 2
      pr({ pr_number: 512, head_branch: 'human/rename', merged_at: '2026-07-03T09:00:00Z', closed_at: '2026-07-03T09:00:00Z' }), // pr-link → autonomous, July 3
      pr({ pr_number: 2, head_branch: 'agent/z', merged_at: '2026-07-03T10:00:00Z', closed_at: '2026-07-03T10:00:00Z' }), // assisted, July 3
      pr({ pr_number: 3, head_branch: 'legacy/w' }), // only unclassifiable matches → unclassified
      pr({ pr_number: 4, head_branch: 'human/solo' }), // no match at all → unclassified
      pr({ pr_number: 5, state: 'closed', merged_at: null }), // not merged → out entirely
    ];
    const result = computeShippedAutonomyLadder(rows, items, WINDOW);
    expect(result.points).toEqual([
      { date: '2026-07-02', assisted: 0, supervised: 1, delegated: 0, autonomous: 0 },
      { date: '2026-07-03', assisted: 1, supervised: 0, delegated: 0, autonomous: 1 },
    ]);
    // 3 classified (supervised, autonomous, assisted); 1 of 3 at delegated-or-above.
    expect(result.current).toEqual({ classified: 3, unclassified: 2, delegatedShare: 1 / 3 });
  });

  it('buckets prior-window merges into the prior share, never the trend', () => {
    const rows: PrLifecycleRow[] = [
      pr({ pr_number: 1 }), // current window, supervised
      pr({ pr_number: 6, merged_at: '2026-06-25T09:00:00Z', closed_at: '2026-06-25T09:00:00Z' }), // prior window
    ];
    const result = computeShippedAutonomyLadder(rows, items, WINDOW);
    expect(result.prior).toEqual({ classified: 1, unclassified: 0, delegatedShare: 0 });
    expect(result.points).toHaveLength(1);
  });

  it('returns zero-shares (not NaN) when nothing classifiable merged', () => {
    const result = computeShippedAutonomyLadder([pr({ pr_number: 4, head_branch: 'human/solo' })], items, WINDOW);
    expect(result.current).toEqual({ classified: 0, unclassified: 1, delegatedShare: 0 });
    expect(result.points).toEqual([]);
  });
});
