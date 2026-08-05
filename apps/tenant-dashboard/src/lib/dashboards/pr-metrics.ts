/**
 * PR-lifecycle metric aggregation — pure functions.
 *
 * The `pull_request` table (Postgres) is the source of truth for PR
 * lifecycle; ClickHouse contributes only the session→PR attribution set
 * (`getAgentPrAttribution`). The widget route feeds both in; everything
 * here is deterministic math with no I/O, so the metric definitions live in
 * one hard-tested place.
 *
 * Definitions (pinned by tests):
 * - A PR is AGENT-ATTRIBUTED when a session explicitly linked it
 *   (`pr_number ∈ prNumbers`, the `pr-link` outcome) OR a session ran on its
 *   head branch (`head_branch ∈ branches`).
 * - MERGE RATE = merged ÷ (merged + closed-unmerged) over agent PRs DECIDED
 *   in the window (by `closed_at`). The decided-cohort avoids right-censoring:
 *   a PR opened yesterday and still open is undecided, not a failure.
 * - CYCLE TIME (blended) = `merged_at − opened_at` for agent PRs MERGED in the
 *   window, daily p50/p95 in hours, bucketed by merge date (cohort-by-merge —
 *   the same key cost-per-merged-PR uses).
 * - CYCLE TIME (decomposed) = the same merged cohort split into the four
 *   LinearB/Swarmia phases — coding (draft) → pickup → review → merge — each
 *   reported as a median over the PRs where THAT phase is measurable (both of
 *   its boundary timestamps present, non-negative). Per-phase medians are
 *   independent samples and deliberately DON'T sum to the blended median: a PR
 *   merged with no human review contributes to `coding`/`merge` but not
 *   `pickup`/`review` — we don't fabricate a duration for a phase we never
 *   observed. The blended trend is the "how long overall"; this is the "where
 *   the time goes" (improve-the-agent vs. staff-review-capacity).
 */

export interface PrLifecycleRow {
  pr_number: number;
  head_branch: string;
  state: 'open' | 'closed' | 'merged';
  opened_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  // Cycle-time phase boundaries (decomposed cycle time). Optional so the
  // merge-rate / blended-trend fixtures — which don't need them — still type.
  // Semantics + monotonicity guarantees live on the `pull_request` schema
  // (66-pull-request.sql): FIRST-OCCURRENCE, human-only review milestones;
  // `ready_for_review_at` is draft-aware and readers COALESCE it with
  // `opened_at`. GitLab populates only `first_approved_at`.
  ready_for_review_at?: string | null;
  first_review_at?: string | null;
  first_approved_at?: string | null;
  // Times reopened after a close (reopen-rate metric). NOT NULL DEFAULT 0 in the
  // schema; optional here so fixtures that predate it still type. Webhook-fed
  // only — backfilled rows carry 0 (see the schema comment).
  reopen_count?: number | null;
  // When a later merged PR/MR reverted this one (revert-rate / durability
  // metric). NULL = not reverted. Optional here so fixtures that predate it
  // still type. Webhook-fed only — see the schema comment for the undercount.
  reverted_at?: string | null;
  // Diff size (batch-size guardrail). NULL = not captured — unknown, NEVER
  // zero: size math must skip NULL rows, not count them as empty PRs.
  // GitLab rows can carry changed_files without line counts (see the schema
  // comment). Optional so fixtures that predate them still type.
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  // First-pass CI verdict (sha-locked, failure-sticky — see the schema
  // comment). NULL = no completed CI observed: excluded from the failure
  // rate's denominator, never counted as a pass.
  first_ci_status?: 'success' | 'failure' | null;
}

export interface AgentPrAttribution {
  branches: readonly string[];
  prNumbers: readonly number[];
  /** PRs whose linked agent session(s) needed mid-session steering
   * (UserTurnCount > 1) — the steering leg of `computeAgentCleanJobRate`.
   * Optional so merge/reopen/revert fixtures that don't exercise it still type;
   * absent/empty means "no PR was steered" (never asserts unobserved steering). */
  steeredPrNumbers?: readonly number[];
}

/** Inclusive `YYYY-MM-DD` day window (matches the widget DateRange shape). */
interface DayWindow {
  start: string;
  end: string;
}

interface MergeRatePeriod {
  merged: number;
  closedUnmerged: number;
  /** merged / (merged + closedUnmerged); 0 when nothing was decided. */
  rate: number;
}

interface AgentPrMergeRateResult {
  current: MergeRatePeriod;
  prior: MergeRatePeriod;
}

interface CycleTimeTrendPoint {
  /** Merge date (`YYYY-MM-DD`, UTC). */
  date: string;
  p50Hours: number;
  p95Hours: number;
  merged: number;
}

/** UTC calendar day of a timestamp, or null when absent/unparseable. */
function dayOf(ts: string | null): string | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function inWindow(day: string | null, window: DayWindow): boolean {
  return day !== null && day >= window.start && day <= window.end;
}

/**
 * The immediately preceding window of equal length — same semantics as
 * `computePriorPeriod` in `@repo/observability-service`'s agent-fleet
 * queries (kept in lockstep by test, not by import: the package doesn't
 * export it, and 6 lines of UTC day math don't warrant widening its API).
 */
export function priorWindow(window: DayWindow): DayWindow {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const start = Date.parse(`${window.start}T00:00:00Z`);
  const end = Date.parse(`${window.end}T00:00:00Z`);
  const periodMs = Math.max(end - start, 0);
  const priorEnd = start - DAY_MS;
  return {
    start: new Date(priorEnd - periodMs).toISOString().slice(0, 10),
    end: new Date(priorEnd).toISOString().slice(0, 10),
  };
}

export function isAgentPr(row: Pick<PrLifecycleRow, 'pr_number' | 'head_branch'>, attribution: AgentPrAttribution): boolean {
  return attribution.prNumbers.includes(row.pr_number) || attribution.branches.includes(row.head_branch);
}

/**
 * Linear-interpolation percentile (R-7, numpy default) over an unsorted
 * sample. Returns 0 for an empty sample — callers only ask on non-empty
 * buckets, but a widget must never render NaN.
 */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/**
 * Merge rate over agent-attributed PRs decided in `window`, with the
 * immediately preceding equal-length window for the stat tile's change
 * indicator. Open PRs never count (undecided ≠ failed).
 */
export function computeAgentPrMergeRate(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentPrMergeRateResult {
  const prior = priorWindow(window);
  const zero = (): { merged: number; closedUnmerged: number } => ({ merged: 0, closedUnmerged: 0 });
  const buckets = { current: zero(), prior: zero() };

  for (const row of rows) {
    if (row.state === 'open') continue;
    if (!isAgentPr(row, attribution)) continue;
    const decidedDay = dayOf(row.closed_at);
    const bucket = inWindow(decidedDay, window)
      ? buckets.current
      : inWindow(decidedDay, prior)
        ? buckets.prior
        : null;
    if (!bucket) continue;
    if (row.state === 'merged') bucket.merged += 1;
    else bucket.closedUnmerged += 1;
  }

  const withRate = (b: { merged: number; closedUnmerged: number }): MergeRatePeriod => {
    const decided = b.merged + b.closedUnmerged;
    return { ...b, rate: decided > 0 ? b.merged / decided : 0 };
  };
  return { current: withRate(buckets.current), prior: withRate(buckets.prior) };
}

/**
 * Daily p50/p95 cycle time (hours) for agent-attributed PRs merged in
 * `window`, ascending by merge date. Days with no merges produce no point
 * (sparse series, matching how a chart should show "nothing merged"). Rows
 * missing either timestamp, or with merged_at before opened_at (clock skew,
 * bad backfill), are skipped rather than plotted as negative hours.
 */
export function computeAgentPrCycleTimeTrend(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): { points: CycleTimeTrendPoint[] } {
  const byDay = new Map<string, number[]>();

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!isAgentPr(row, attribution)) continue;
    const mergeDay = dayOf(row.merged_at);
    if (!inWindow(mergeDay, window)) continue;
    const openedMs = row.opened_at ? Date.parse(row.opened_at) : NaN;
    const mergedMs = row.merged_at ? Date.parse(row.merged_at) : NaN;
    if (!Number.isFinite(openedMs) || !Number.isFinite(mergedMs) || mergedMs < openedMs) continue;
    const hours = (mergedMs - openedMs) / (60 * 60 * 1000);
    const list = byDay.get(mergeDay!) ?? [];
    list.push(hours);
    byDay.set(mergeDay!, list);
  }

  const round = (h: number) => Math.round(h * 100) / 100;
  return {
    points: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, hours]) => ({
        date,
        p50Hours: round(percentile(hours, 0.5)),
        p95Hours: round(percentile(hours, 0.95)),
        merged: hours.length,
      })),
  };
}

/**
 * The decomposed cycle-time phases, in chronological order. The order is the
 * contract — the widget renders one bar per phase in exactly this sequence, so
 * a reader sees `coding → pickup → review → merge` left-to-right.
 */
const PR_CYCLE_PHASES = ['coding', 'pickup', 'review', 'merge'] as const;
export type PrCyclePhase = (typeof PR_CYCLE_PHASES)[number];

interface PrCyclePhaseStat {
  phase: PrCyclePhase;
  /** Median (p50) hours spent in this phase over the PRs where it's measurable. */
  p50Hours: number;
  /**
   * How many merged agent PRs contributed a measurable duration to this phase.
   * A low sample size is why a phase median can be noisy — surfaced so callers
   * can label it, and so `p50Hours: 0` from "no PR reached this phase" is
   * distinguishable from a genuine near-zero median.
   */
  sampleSize: number;
}

/** Milliseconds of a timestamp, or NaN when absent/unparseable. */
function msOf(ts: string | null | undefined): number {
  return ts ? Date.parse(ts) : NaN;
}

/**
 * Decomposed cycle time for agent-attributed PRs merged in `window` (same
 * cohort-by-merge-date as the blended trend). Each phase's median is taken
 * over only the PRs whose two boundary timestamps are both present and
 * ordered (end ≥ start) — a phase never invents a duration from a missing
 * milestone. Phases with no measurable PR return `p50Hours: 0, sampleSize: 0`.
 * See the file header for why per-phase medians don't sum to the blended one.
 *
 * Boundaries (`ready` = COALESCE(ready_for_review_at, opened_at), per the
 * schema reader contract):
 *   coding = ready − opened     (time in draft; ~0 for non-draft PRs)
 *   pickup = first_review − ready
 *   review = first_approved − first_review
 *   merge  = merged − first_approved
 */
export function computeAgentPrCycleTimeBreakdown(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): { phases: PrCyclePhaseStat[] } {
  const HOUR_MS = 60 * 60 * 1000;
  const samples: Record<PrCyclePhase, number[]> = { coding: [], pickup: [], review: [], merge: [] };

  const add = (bucket: number[], startMs: number, endMs: number): void => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
    bucket.push((endMs - startMs) / HOUR_MS);
  };

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!isAgentPr(row, attribution)) continue;
    if (!inWindow(dayOf(row.merged_at), window)) continue;

    const opened = msOf(row.opened_at);
    const merged = msOf(row.merged_at);
    // Gate the whole PR on a sane open→merge span, matching the blended trend —
    // a clock-skewed row shouldn't leak a bogus duration into any phase.
    if (!Number.isFinite(opened) || !Number.isFinite(merged) || merged < opened) continue;

    const readyRaw = msOf(row.ready_for_review_at);
    const ready = Number.isFinite(readyRaw) ? readyRaw : opened;
    const firstReview = msOf(row.first_review_at);
    const firstApproved = msOf(row.first_approved_at);

    add(samples.coding, opened, ready);
    add(samples.pickup, ready, firstReview);
    add(samples.review, firstReview, firstApproved);
    add(samples.merge, firstApproved, merged);
  }

  const round = (h: number) => Math.round(h * 100) / 100;
  return {
    phases: PR_CYCLE_PHASES.map((phase) => ({
      phase,
      p50Hours: round(percentile(samples[phase], 0.5)),
      sampleSize: samples[phase].length,
    })),
  };
}

/**
 * Count agent-attributed PRs MERGED in `window` and in the immediately
 * preceding equal-length window — the denominator for cost-per-merged-PR.
 * Cohort-by-MERGE-DATE (`merged_at`), matching the cycle-time trend, NOT the
 * merge-rate tile's decided-by-`closed_at` cohort: a merged PR's `merged_at`
 * is the moment its cost stops accruing, so pairing spend with merges by that
 * same date is what keeps the ratio honest.
 */
export function countAgentMergedPrs(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): { current: number; prior: number } {
  const prior = priorWindow(window);
  let current = 0;
  let priorCount = 0;
  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!isAgentPr(row, attribution)) continue;
    const mergeDay = dayOf(row.merged_at);
    if (inWindow(mergeDay, window)) current += 1;
    else if (inWindow(mergeDay, prior)) priorCount += 1;
  }
  return { current, prior: priorCount };
}

interface FullyLoadedCostPerMergedPr {
  /** All agent spend in the window ÷ agent PRs merged in it. */
  current: number;
  prior: number;
  /**
   * No agent PR merged in the current window, so `current` has no
   * denominator. The value is 0 only as a placeholder — callers must render
   * "unavailable", never "$0": spend with nothing merged is the WORST case,
   * and a $0 tile reads as the best. (The prior period gets no such flag;
   * its only consumer is the change indicator, which a missing baseline
   * already suppresses.)
   */
  currentUnavailable: boolean;
}

/**
 * FULLY-LOADED cost-per-merged-PR: total agent spend (every session, incl.
 * ones that produced no PR and follow-up fix sessions) divided by the count
 * of agent PRs that merged. The "fully-loaded" framing is deliberate — the
 * gap between this and a future direct/attributed variant IS the waste
 * signal. This is the denominator-safe half: it never
 * needs the session↔PR join, only two scalars this function combines.
 *
 * Goodhart caveat (documented, not yet guarded): splitting work into more
 * PRs lowers this number without lowering real cost — a size/complexity
 * dimension is the intended guard and isn't built yet.
 */
export function computeFullyLoadedCostPerMergedPr(
  mergedCounts: { current: number; prior: number },
  totalCost: { current: number; prior: number },
): FullyLoadedCostPerMergedPr {
  return {
    current: mergedCounts.current > 0 ? totalCost.current / mergedCounts.current : 0,
    prior: mergedCounts.prior > 0 ? totalCost.prior / mergedCounts.prior : 0,
    currentUnavailable: mergedCounts.current === 0,
  };
}

/**
 * One `(GitBranch, PrNumber)` session-cost group from ClickHouse (see
 * `getAgentPrCostAttribution`). A session lands in exactly one group, so a
 * disjoint subset of these rows sums without double-counting.
 */
export interface PrCostAttributionRow {
  branch: string;
  prNumber: number;
  costUsd: number;
}

/**
 * Cost attributed to a set of merged PRs, explicit-link-wins. Each cost row is
 * assigned to at most one PR: by explicit `pr-link` number if that number is
 * in `mergedNumbers`, else by head-branch match. A row matching neither is
 * unattributed — that's the sessions whose work didn't land in a merged PR
 * this window (the overhead the fully-loaded-vs-direct gap exposes).
 */
function attributedCost(
  costRows: readonly PrCostAttributionRow[],
  mergedNumbers: ReadonlySet<number>,
  mergedBranches: ReadonlySet<string>,
): number {
  let total = 0;
  for (const r of costRows) {
    if (r.prNumber > 0 && mergedNumbers.has(r.prNumber)) total += r.costUsd;
    else if (r.branch !== '' && mergedBranches.has(r.branch)) total += r.costUsd;
  }
  return total;
}

interface DirectCostPerMergedPr {
  /** Attributed session spend ÷ agent PRs merged, per period. */
  current: number;
  prior: number;
  /** No agent PR merged this window — `current` has no denominator (render "unavailable", not $0). */
  currentUnavailable: boolean;
}

/**
 * DIRECT cost-per-merged-PR: only the spend of sessions
 * ATTRIBUTED to a merged PR (via explicit pr-link, else head-branch match),
 * divided by the merged-PR count — the same denominator as the fully-loaded
 * variant, so the gap between the two is the unattributed overhead (abandoned
 * work, non-PR sessions). Cohort by merge date, current + prior windows.
 *
 * A cost row is counted once, explicit-link beating branch match; the merged
 * PR sets are built here from `rows` so attribution is tied to THIS window's
 * merges, not the global attribution set. Cross-period note: the same cost
 * row can attribute to a current PR (by number) and, in the prior calc, a
 * prior PR sharing its branch — periods are compared not summed, so this only
 * nudges the change indicator in the rare branch-reuse case.
 */
export function computeDirectCostPerMergedPr(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  costRows: readonly PrCostAttributionRow[],
  window: DayWindow,
): DirectCostPerMergedPr {
  const prior = priorWindow(window);
  const mk = () => ({ numbers: new Set<number>(), branches: new Set<string>(), count: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!isAgentPr(row, attribution)) continue;
    const day = dayOf(row.merged_at);
    const bucket = inWindow(day, window) ? cur : inWindow(day, prior) ? pri : null;
    if (!bucket) continue;
    bucket.numbers.add(row.pr_number);
    if (row.head_branch !== '') bucket.branches.add(row.head_branch);
    bucket.count += 1;
  }

  return {
    current: cur.count > 0 ? attributedCost(costRows, cur.numbers, cur.branches) / cur.count : 0,
    prior: pri.count > 0 ? attributedCost(costRows, pri.numbers, pri.branches) / pri.count : 0,
    currentUnavailable: cur.count === 0,
  };
}

interface UnreviewedRatePeriod {
  merged: number;
  unreviewed: number;
  /** unreviewed / merged; 0 when nothing merged (never NaN into a widget). */
  rate: number;
}

interface AgentPrUnreviewedMergeRateResult {
  current: UnreviewedRatePeriod;
  prior: UnreviewedRatePeriod;
}

/**
 * Share of agent PRs MERGED in `window` that landed with NO human review or
 * approval (review-quality metric). The `first_review_at` /
 * `first_approved_at` milestones are HUMAN-only by construction (self- and
 * bot-reviews never set them — see the `pull_request` schema), so a merged PR
 * with neither is one no human is recorded as having looked at before it
 * landed. Cohort-by-merge-date, current + prior windows, like the other
 * merged-cohort metrics.
 *
 * Direction is unambiguous: you want this LOW (up = worse), so the tile treats
 * an increase as bad. Cross-provider note: GitHub sets `first_review_at` on a
 * review and `first_approved_at` on approval; GitLab sets only
 * `first_approved_at` (review events are deferred) — so on a GitLab repo this
 * reads as "merged without approval". Widgets are dominant-repo scoped, so a
 * given tile is one provider and the reading stays consistent.
 */
export function computeAgentPrUnreviewedMergeRate(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentPrUnreviewedMergeRateResult {
  const prior = priorWindow(window);
  const mk = (): { merged: number; unreviewed: number } => ({ merged: 0, unreviewed: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!isAgentPr(row, attribution)) continue;
    const bucket = inWindow(dayOf(row.merged_at), window) ? cur : inWindow(dayOf(row.merged_at), prior) ? pri : null;
    if (!bucket) continue;
    bucket.merged += 1;
    const reviewed = Boolean(row.first_review_at) || Boolean(row.first_approved_at);
    if (!reviewed) bucket.unreviewed += 1;
  }

  const withRate = (b: { merged: number; unreviewed: number }): UnreviewedRatePeriod => ({
    ...b,
    rate: b.merged > 0 ? b.unreviewed / b.merged : 0,
  });
  return { current: withRate(cur), prior: withRate(pri) };
}

interface ReopenRatePeriod {
  decided: number;
  reopened: number;
  /** reopened / decided; 0 when nothing decided (never NaN into a widget). */
  rate: number;
}

interface AgentPrReopenRateResult {
  current: ReopenRatePeriod;
  prior: ReopenRatePeriod;
}

/**
 * Share of agent PRs DECIDED in `window` (closed or merged, by `closed_at`)
 * that were REOPENED at least once (rework/churn). Same
 * decided-cohort shape as merge rate — open PRs are undecided, never counted.
 * `reopen_count` is webhook-fed only (see the `pull_request` schema): the
 * backfill can't reconstruct reopen history, so PRs closed before the app was
 * connected carry 0 and this UNDERCOUNTS for a freshly-connected repo. A
 * missing/NULL count is treated as 0 (not reopened).
 *
 * Direction is unambiguous: you want this LOW (up = more churn = worse), so
 * the tile treats an increase as bad.
 */
export function computeAgentPrReopenRate(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentPrReopenRateResult {
  const prior = priorWindow(window);
  const mk = (): { decided: number; reopened: number } => ({ decided: 0, reopened: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state === 'open') continue;
    if (!isAgentPr(row, attribution)) continue;
    const decidedDay = dayOf(row.closed_at);
    const bucket = inWindow(decidedDay, window) ? cur : inWindow(decidedDay, prior) ? pri : null;
    if (!bucket) continue;
    bucket.decided += 1;
    if ((row.reopen_count ?? 0) > 0) bucket.reopened += 1;
  }

  const withRate = (b: { decided: number; reopened: number }): ReopenRatePeriod => ({
    ...b,
    rate: b.decided > 0 ? b.reopened / b.decided : 0,
  });
  return { current: withRate(cur), prior: withRate(pri) };
}

interface RevertRatePeriod {
  decided: number;
  reverted: number;
  /** reverted / decided; 0 when nothing decided (never NaN into a widget). */
  rate: number;
}

interface AgentPrRevertRateResult {
  current: RevertRatePeriod;
  prior: RevertRatePeriod;
}

/**
 * Share of agent PRs DECIDED in `window` (closed or merged, by `closed_at`)
 * that were later REVERTED — the durability leg of autonomy ("did the agent's
 * work stick?"). This is what reverts are FOR that reopen/merge-rate can't
 * catch: a PR can merge clean and still be wrong. Same decided-cohort shape as
 * reopen rate; open PRs are undecided, never counted. A PR reverted by anyone
 * (human or agent) counts — the question is whether the WORK held, not who
 * undid it. `reverted_at` is webhook-fed only (see the `pull_request` schema):
 * a manual `git revert` with no PR-number reference, or a revert predating the
 * app's connection, leaves the target looking un-reverted, so this UNDERCOUNTS.
 *
 * Direction is unambiguous: you want this LOW (up = more reverted work = worse),
 * so the tile treats an increase as bad.
 */
export function computeAgentPrRevertRate(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentPrRevertRateResult {
  const prior = priorWindow(window);
  const mk = (): { decided: number; reverted: number } => ({ decided: 0, reverted: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state === 'open') continue;
    if (!isAgentPr(row, attribution)) continue;
    const decidedDay = dayOf(row.closed_at);
    const bucket = inWindow(decidedDay, window) ? cur : inWindow(decidedDay, prior) ? pri : null;
    if (!bucket) continue;
    bucket.decided += 1;
    if (row.reverted_at != null) bucket.reverted += 1;
  }

  const withRate = (b: { decided: number; reverted: number }): RevertRatePeriod => ({
    ...b,
    rate: b.decided > 0 ? b.reverted / b.decided : 0,
  });
  return { current: withRate(cur), prior: withRate(pri) };
}

/** A cohort's delivery stats, shared by the agent-vs-human comparison and
 * the score-outcome-correlation comparison — same fields, different split. */
interface VsHumanPopulationStats {
  /** PRs decided in the window (merged + closed-unmerged, by `closed_at`). */
  decided: number;
  /** PRs merged in the window (by `merged_at` — the cycle-time cohort). */
  merged: number;
  /** merged ÷ decided; 0 when nothing decided (never NaN into a widget). */
  mergeRate: number;
  /** reverted ÷ decided; 0 when nothing decided. */
  revertRate: number;
  /** Median `merged_at − opened_at` hours over the merged-in-window cohort; 0 when none. */
  cycleTimeP50Hours: number;
}

interface AgentVsHumanPrComparisonResult {
  agent: VsHumanPopulationStats;
  human: VsHumanPopulationStats;
}

/**
 * The within-org control group: the same delivery metrics computed over the
 * agent-attributed and NOT-attributed ("human-only") PR populations, same
 * repo, same window. "Shipping more efficiently with agents" is a
 * comparative claim, and this is the strongest honest comparison available
 * from lifecycle data alone. Two disclosed limits (documented, not solved):
 * (a) selection bias — teams route different work to agents, so this is a
 * comparison, not an RCT; (b) the "human-only" set is really "no synced
 * session touched it", so low session-sync coverage inflates the human
 * population (see `computeAgentShareOfMergedPrs`'s coverage framing).
 *
 * Cohorts mirror the standalone metrics exactly (pinned by test): cycle time
 * over PRs MERGED in the window (by `merged_at`, skew-guarded like
 * `computeAgentPrCycleTimeTrend`), merge/revert rate over PRs DECIDED in the
 * window (by `closed_at`) — so a population's number here never disagrees
 * with the standalone tile under the same label.
 */
export function computeAgentVsHumanPrComparison(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentVsHumanPrComparisonResult {
  const HOUR_MS = 60 * 60 * 1000;
  const mk = () => ({ decided: 0, merged: 0, reverted: 0, cycleHours: [] as number[] });
  const pops = { agent: mk(), human: mk() };

  for (const row of rows) {
    const pop = isAgentPr(row, attribution) ? pops.agent : pops.human;

    // Decided cohort (merge/revert rate) — open PRs are undecided, never counted.
    if (row.state !== 'open' && inWindow(dayOf(row.closed_at), window)) {
      pop.decided += 1;
      if (row.state === 'merged') pop.merged += 1;
      if (row.reverted_at != null) pop.reverted += 1;
    }

    // Merged cohort (cycle time) — same skew guard as the blended trend.
    if (row.state === 'merged' && inWindow(dayOf(row.merged_at), window)) {
      const openedMs = row.opened_at ? Date.parse(row.opened_at) : NaN;
      const mergedMs = row.merged_at ? Date.parse(row.merged_at) : NaN;
      if (Number.isFinite(openedMs) && Number.isFinite(mergedMs) && mergedMs >= openedMs) {
        pop.cycleHours.push((mergedMs - openedMs) / HOUR_MS);
      }
    }
  }

  const round = (h: number) => Math.round(h * 100) / 100;
  const finish = (p: ReturnType<typeof mk>): VsHumanPopulationStats => ({
    decided: p.decided,
    merged: p.cycleHours.length,
    mergeRate: p.decided > 0 ? p.merged / p.decided : 0,
    revertRate: p.decided > 0 ? p.reverted / p.decided : 0,
    cycleTimeP50Hours: round(percentile(p.cycleHours, 0.5)),
  });
  return { agent: finish(pops.agent), human: finish(pops.human) };
}

interface AgentPrOutcomeByScoreResult {
  pass: VsHumanPopulationStats;
  fail: VsHumanPopulationStats;
}

/**
 * The eval-score ↔ PR-outcome correlation, the online-evals validation
 * loop: the SAME delivery metrics as
 * `computeAgentVsHumanPrComparison`, but the population split is a
 * predictor-score verdict (pass/fail) on the PR's linked session(s) instead
 * of agent-vs-human attribution. Restricted to agent-attributed PRs — the
 * question is "do OUR eval scores predict OUR PR outcomes," not the whole
 * repo's traffic.
 *
 * `scoreVerdictByPr` carries `undefined`-by-absence: a PR with no confirmed
 * session link, or whose linked session(s) never emitted this score name,
 * contributes to NEITHER cohort — "no signal" is not "failed". This is what
 * keeps the correlation honest when only a fraction of PRs have been
 * scored (the issue's own "renders empty for essentially every tenant"
 * caveat, until online-eval writers exist).
 */
export function computeAgentPrOutcomeByScore(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  scoreVerdictByPr: ReadonlyMap<number, boolean>,
  window: DayWindow,
): AgentPrOutcomeByScoreResult {
  const HOUR_MS = 60 * 60 * 1000;
  const mk = () => ({ decided: 0, merged: 0, reverted: 0, cycleHours: [] as number[] });
  const pops = { pass: mk(), fail: mk() };

  for (const row of rows) {
    if (!isAgentPr(row, attribution)) continue;
    const verdict = scoreVerdictByPr.get(row.pr_number);
    if (verdict === undefined) continue;
    const pop = verdict ? pops.pass : pops.fail;

    // Decided cohort (merge/revert rate) — open PRs are undecided, never counted.
    if (row.state !== 'open' && inWindow(dayOf(row.closed_at), window)) {
      pop.decided += 1;
      if (row.state === 'merged') pop.merged += 1;
      if (row.reverted_at != null) pop.reverted += 1;
    }

    // Merged cohort (cycle time) — same skew guard as the blended trend.
    if (row.state === 'merged' && inWindow(dayOf(row.merged_at), window)) {
      const openedMs = row.opened_at ? Date.parse(row.opened_at) : NaN;
      const mergedMs = row.merged_at ? Date.parse(row.merged_at) : NaN;
      if (Number.isFinite(openedMs) && Number.isFinite(mergedMs) && mergedMs >= openedMs) {
        pop.cycleHours.push((mergedMs - openedMs) / HOUR_MS);
      }
    }
  }

  const round = (h: number) => Math.round(h * 100) / 100;
  const finish = (p: ReturnType<typeof mk>): VsHumanPopulationStats => ({
    decided: p.decided,
    merged: p.cycleHours.length,
    mergeRate: p.decided > 0 ? p.merged / p.decided : 0,
    revertRate: p.decided > 0 ? p.reverted / p.decided : 0,
    cycleTimeP50Hours: round(percentile(p.cycleHours, 0.5)),
  });
  return { pass: finish(pops.pass), fail: finish(pops.fail) };
}

interface MergedSharePeriod {
  agentMerged: number;
  totalMerged: number;
  /** agentMerged ÷ totalMerged; 0 when nothing merged (never NaN into a widget). */
  share: number;
}

interface AgentShareOfMergedPrsResult {
  current: MergedSharePeriod;
  prior: MergedSharePeriod;
}

/**
 * Share of ALL merged PRs that were agent-attributed, cohort-by-merge-date,
 * current + prior windows — the "how much of our shipping is agentic"
 * adoption curve. This number carries a second, deliberate reading: it is
 * also the DATA-COVERAGE floor. Attribution's only signal is synced agent
 * sessions, so a merged PR with no synced session reads as human-only
 * whether or not an agent touched it — when this is low, every other agent
 * metric on the dashboard describes only the observed slice of shipped work.
 * The metric description surfaces that caveat to the user.
 */
export function computeAgentShareOfMergedPrs(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentShareOfMergedPrsResult {
  const prior = priorWindow(window);
  const mk = (): { agentMerged: number; totalMerged: number } => ({ agentMerged: 0, totalMerged: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    const mergeDay = dayOf(row.merged_at);
    const bucket = inWindow(mergeDay, window) ? cur : inWindow(mergeDay, prior) ? pri : null;
    if (!bucket) continue;
    bucket.totalMerged += 1;
    if (isAgentPr(row, attribution)) bucket.agentMerged += 1;
  }

  const withShare = (b: { agentMerged: number; totalMerged: number }): MergedSharePeriod => ({
    ...b,
    share: b.totalMerged > 0 ? b.agentMerged / b.totalMerged : 0,
  });
  return { current: withShare(cur), prior: withShare(pri) };
}

interface UnshippedSpendShareResult {
  /** Share (0..1) of the period's agent spend NOT attributed to a PR that merged in it. */
  current: number;
  prior: number;
  /** No agent spend this window — the share has no denominator (render "unavailable", not 0%). */
  currentUnavailable: boolean;
}

/**
 * Share of the window's agent spend NOT attributed to any PR that merged in
 * that window — the waste lever the fully-loaded-vs-direct cost gap exposes,
 * as its own headline number: `1 − attributed ÷ total`. "Unshipped", not
 * "wasted": the unattributed slice includes legitimate non-PR work
 * (exploration, review, ops), so the target is a falling trend, not zero.
 *
 * Same attribution rule as direct cost-per-merged-PR (explicit pr-link wins,
 * else head-branch match, against the PRs merged in the period). Known
 * approximation, clamped rather than hidden: cost-attribution groups are not
 * date-windowed (a PR's spend spans sessions predating its merge), while
 * `totalCost` is window-scoped — so attributed spend can exceed the window's
 * total when a long-running branch merges. The share is clamped to [0, 1];
 * a clamped 0 honestly reads "everything this period shipped".
 */
export function computeUnshippedSpendShare(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  costRows: readonly PrCostAttributionRow[],
  totalCost: { current: number; prior: number },
  window: DayWindow,
): UnshippedSpendShareResult {
  const prior = priorWindow(window);
  const mk = () => ({ numbers: new Set<number>(), branches: new Set<string>() });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!isAgentPr(row, attribution)) continue;
    const day = dayOf(row.merged_at);
    const bucket = inWindow(day, window) ? cur : inWindow(day, prior) ? pri : null;
    if (!bucket) continue;
    bucket.numbers.add(row.pr_number);
    if (row.head_branch !== '') bucket.branches.add(row.head_branch);
  }

  const share = (total: number, sets: ReturnType<typeof mk>): number => {
    if (total <= 0) return 0;
    const attributed = attributedCost(costRows, sets.numbers, sets.branches);
    return Math.min(Math.max(1 - attributed / total, 0), 1);
  };

  return {
    current: share(totalCost.current, cur),
    prior: share(totalCost.prior, pri),
    currentUnavailable: totalCost.current <= 0,
  };
}

interface CleanJobRatePeriod {
  decided: number;
  clean: number;
  /** clean / decided; 0 when nothing decided (never NaN into a widget). */
  rate: number;
}

interface AgentCleanJobRateResult {
  current: CleanJobRatePeriod;
  prior: CleanJobRatePeriod;
}

/**
 * The autonomy composite: share of decided agent PRs that were a CLEAN JOB —
 * (a) merged, (b) not reverted, AND (c) needed no mid-session human steering.
 * This is the headline "can we trust the agent to work on its own?" number:
 * independence (no steering) AND correctness/durability (merged, stuck), in one
 * rate. Same decided-cohort denominator as merge/reopen/revert rate.
 *
 * Direction is up-is-GOOD (more clean jobs = more trustworthy autonomy), unlike
 * the reopen/revert rates — so the tile is NOT inverted.
 *
 * Honest reads of the legs (all documented on their own metrics): the steering
 * set is webhook/ingest-derived and a PR with no linked session counts as
 * un-steered (we never assert steering we can't see); revert/merge inherit the
 * decided-cohort + webhook-undercount caveats. So this is a FLOOR on trouble,
 * not a ceiling — it can only look worse than reality, not better.
 */
export function computeAgentCleanJobRate(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): AgentCleanJobRateResult {
  const prior = priorWindow(window);
  const steered = new Set(attribution.steeredPrNumbers ?? []);
  const mk = (): { decided: number; clean: number } => ({ decided: 0, clean: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state === 'open') continue;
    if (!isAgentPr(row, attribution)) continue;
    const decidedDay = dayOf(row.closed_at);
    const bucket = inWindow(decidedDay, window) ? cur : inWindow(decidedDay, prior) ? pri : null;
    if (!bucket) continue;
    bucket.decided += 1;
    const isClean =
      row.state === 'merged' && row.reverted_at == null && !steered.has(row.pr_number);
    if (isClean) bucket.clean += 1;
  }

  const withRate = (b: { decided: number; clean: number }): CleanJobRatePeriod => ({
    ...b,
    rate: b.decided > 0 ? b.clean / b.decided : 0,
  });
  return { current: withRate(cur), prior: withRate(pri) };
}

interface PrSizeTrendPoint {
  /** Merge date (`YYYY-MM-DD`, UTC). */
  date: string;
  /** Median additions + deletions over that day's SIZED merges. */
  medianLinesChanged: number;
  /** How many merged PRs that day carried size data (the median's sample). */
  merged: number;
}

/**
 * Daily median PR size (lines changed) over ALL merged PRs — the batch-size
 * guardrail that belongs next to throughput: rising delivery numbers paired
 * with swelling PRs is the instability mechanism, not acceleration. Org-wide
 * on purpose (agent AND human merges): batch-size inflation is a property of
 * the delivery stream, and the agent-vs-human split lives in
 * `computeAgentVsHumanPrSize`. Rows without line counts are SKIPPED (NULL =
 * unknown, never a 0-line PR) — days where nothing measurable merged emit no
 * point rather than a fabricated zero.
 */
export function computeMergedPrSizeTrend(
  rows: readonly PrLifecycleRow[],
  window: DayWindow,
): { points: PrSizeTrendPoint[] } {
  const byDay = new Map<string, number[]>();
  for (const row of rows) {
    if (row.state !== 'merged') continue;
    const mergeDay = dayOf(row.merged_at);
    if (!inWindow(mergeDay, window)) continue;
    if (typeof row.additions !== 'number' || typeof row.deletions !== 'number') continue;
    const sizes = byDay.get(mergeDay!) ?? [];
    sizes.push(row.additions + row.deletions);
    byDay.set(mergeDay!, sizes);
  }
  return {
    points: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, sizes]) => ({
        date,
        medianLinesChanged: Math.round(percentile(sizes, 0.5)),
        merged: sizes.length,
      })),
  };
}

interface PrSizePopulationStats {
  /** Merged-in-window PRs carrying line counts (the median's sample size). */
  sized: number;
  medianLinesChanged: number;
}

/**
 * Median merged-PR size, agent-attributed vs not — the DORA batch-size
 * mechanism as a within-org comparison: if agent PRs run systematically
 * larger, the throughput comparison is partly batch-size inflation. Same
 * merged-in-window cohort as the cycle-time comparison; same NULL-skipping
 * as `computeMergedPrSizeTrend` (unknown size is excluded, never zero).
 */
export function computeAgentVsHumanPrSize(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): { agent: PrSizePopulationStats; human: PrSizePopulationStats } {
  const pops = { agent: [] as number[], human: [] as number[] };
  for (const row of rows) {
    if (row.state !== 'merged') continue;
    if (!inWindow(dayOf(row.merged_at), window)) continue;
    if (typeof row.additions !== 'number' || typeof row.deletions !== 'number') continue;
    (isAgentPr(row, attribution) ? pops.agent : pops.human).push(row.additions + row.deletions);
  }
  const finish = (sizes: number[]): PrSizePopulationStats => ({
    sized: sizes.length,
    medianLinesChanged: Math.round(percentile(sizes, 0.5)),
  });
  return { agent: finish(pops.agent), human: finish(pops.human) };
}

interface FirstPassCiPopulationStats {
  /** Decided-in-window PRs with a recorded first-pass verdict (the denominator). */
  measured: number;
  failed: number;
  /** failed ÷ measured; 0 when nothing was measured (never NaN into a widget). */
  failureRate: number;
}

/**
 * First-pass CI failure rate, agent-attributed vs not — the customer-side
 * change-failure proxy: how often did the FIRST CI verdict on a PR come back
 * red? Decided-in-window cohort (by `closed_at`), matching merge/revert
 * rate. The denominator is MEASURED rows only — PRs with no completed CI
 * signal (no CI configured, verdict predates ingestion) are excluded, never
 * counted as passes; the widget surfaces `measured` so a thin sample reads
 * as thin rather than as a confident 0%.
 */
export function computeAgentVsHumanFirstPassCi(
  rows: readonly PrLifecycleRow[],
  attribution: AgentPrAttribution,
  window: DayWindow,
): { agent: FirstPassCiPopulationStats; human: FirstPassCiPopulationStats } {
  const mk = () => ({ measured: 0, failed: 0 });
  const pops = { agent: mk(), human: mk() };
  for (const row of rows) {
    if (row.state === 'open') continue;
    if (!inWindow(dayOf(row.closed_at), window)) continue;
    if (row.first_ci_status !== 'success' && row.first_ci_status !== 'failure') continue;
    const pop = isAgentPr(row, attribution) ? pops.agent : pops.human;
    pop.measured += 1;
    if (row.first_ci_status === 'failure') pop.failed += 1;
  }
  const finish = (p: { measured: number; failed: number }): FirstPassCiPopulationStats => ({
    ...p,
    failureRate: p.measured > 0 ? p.failed / p.measured : 0,
  });
  return { agent: finish(pops.agent), human: finish(pops.human) };
}

/** One `(branch, prNumber)` session group's ladder verdict — the repo-scoped
 * (app) or repo-namespaced (org, via `namespaceOrgPrData`) form of
 * `AgentAutonomyLadderItem`. `minLevel` 0 = no classifiable session. */
export interface AutonomyLadderItem {
  branch: string;
  prNumber: number;
  minLevel: number;
  classifiedSessions: number;
}

interface AutonomyLadderPeriod {
  /** Merged-in-window PRs with a classifiable session chain. */
  classified: number;
  /** Merged-in-window PRs with sessions but no classifiable level, or none at all —
   * surfaced, never guessed (the ladder's coverage caveat). */
  unclassified: number;
  /** (delegated + autonomous) ÷ classified; 0 when nothing classified. */
  delegatedShare: number;
}

interface ShippedAutonomyLadderResult {
  /** Daily merged-PR counts by level over the CURRENT window (stacked trend). */
  points: {
    date: string;
    assisted: number;
    supervised: number;
    delegated: number;
    autonomous: number;
  }[];
  current: AutonomyLadderPeriod;
  prior: AutonomyLadderPeriod;
}

/**
 * The Autonomy Ladder over SHIPPED work: every PR merged in the window is
 * classified at the MINIMUM autonomy level of the session groups that match
 * it (same branch-or-pr-link matching as `isAgentPr`) — steering anywhere in
 * the chain means the work wasn't delegated end-to-end. Merging is the
 * COHORT FILTER, deliberately not a level requirement: the level says how
 * the work ran, outcome quality stays a separate overlaid guardrail (Clean
 * Job Rate) per the no-composite-score rule.
 *
 * PRs whose matches are all unclassifiable (legacy sessions) or that match
 * nothing count into `unclassified` — excluded from the trend and the share,
 * reported alongside so thin coverage reads as thin, never as autonomous.
 */
export function computeShippedAutonomyLadder(
  rows: readonly PrLifecycleRow[],
  items: readonly AutonomyLadderItem[],
  window: DayWindow,
): ShippedAutonomyLadderResult {
  const prior = priorWindow(window);
  const byNumber = new Map<number, number[]>();
  const byBranch = new Map<string, number[]>();
  for (const item of items) {
    if (item.minLevel <= 0) continue;
    if (item.prNumber > 0) {
      byNumber.set(item.prNumber, [...(byNumber.get(item.prNumber) ?? []), item.minLevel]);
    }
    if (item.branch !== '') {
      byBranch.set(item.branch, [...(byBranch.get(item.branch) ?? []), item.minLevel]);
    }
  }

  const LEVEL_KEYS = ['assisted', 'supervised', 'delegated', 'autonomous'] as const;
  const byDay = new Map<string, number[]>();
  const mk = () => ({ classified: 0, unclassified: 0, delegatedPlus: 0 });
  const cur = mk();
  const pri = mk();

  for (const row of rows) {
    if (row.state !== 'merged') continue;
    const mergeDay = dayOf(row.merged_at);
    const bucket = inWindow(mergeDay, window) ? cur : inWindow(mergeDay, prior) ? pri : null;
    if (!bucket) continue;

    const levels = [...(byNumber.get(row.pr_number) ?? []), ...(byBranch.get(row.head_branch) ?? [])];
    if (levels.length === 0) {
      bucket.unclassified += 1;
      continue;
    }
    const level = Math.min(...levels);
    bucket.classified += 1;
    if (level >= 3) bucket.delegatedPlus += 1;

    if (bucket === cur) {
      const counts = byDay.get(mergeDay!) ?? [0, 0, 0, 0];
      // Levels are 1–4 by construction (0s were filtered building the maps);
      // the clamp keeps a malformed input from writing outside the tuple.
      const idx = Math.min(Math.max(level, 1), 4) - 1;
      counts[idx] = (counts[idx] ?? 0) + 1;
      byDay.set(mergeDay!, counts);
    }
  }

  const finish = (b: ReturnType<typeof mk>): AutonomyLadderPeriod => ({
    classified: b.classified,
    unclassified: b.unclassified,
    delegatedShare: b.classified > 0 ? b.delegatedPlus / b.classified : 0,
  });

  return {
    points: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, counts]) => ({
        date,
        ...(Object.fromEntries(LEVEL_KEYS.map((key, i) => [key, counts[i]])) as Record<
          (typeof LEVEL_KEYS)[number],
          number
        >),
      })),
    current: finish(cur),
    prior: finish(pri),
  };
}
