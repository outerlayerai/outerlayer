import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  outcomeScoreRows,
  type OutcomeScoreRow,
  type PrFateRow,
} from "./score-rows";

/**
 * Convergent PR-outcome score emission.
 *
 * `emitOutcomeScoresForPrs` is a pure converge: read the CURRENT lifecycle
 * record + CURRENT confirmed links for a set of PRs, emit the score rows that
 * state supports. It never tracks deltas, so it is safe to call from any
 * trigger, any number of times, in any arrival order — fate-then-link and
 * link-then-fate both end at the same rows (deterministic ids + anchored
 * CreatedAt make repeats collapse under ReplacingMergeTree).
 *
 * Only `confirmed` links emit. A `pending` link is a session-side claim with
 * no provider record — there is no fate to score; an `unmatched` link is a
 * ghost (rewritten history, wrong repo) that must never poison outcome rates.
 *
 * Triggers:
 *  - PR webhook (real-time): converge the event's PR after upsert+reconcile.
 *  - Cron sweep (`sweepOutcomeScores`): converge PRs whose lifecycle row
 *    changed recently (CI verdicts and revert flags arrive via non-PR
 *    webhooks and never fire the PR-event path) plus PRs whose links were
 *    reconciled recently (sessions sync minutes-to-days late). A wide
 *    `sinceHours` doubles as the historical backfill.
 */

const PULL_REQUEST_TABLE = "pull_request";
const PULL_REQUEST_SESSION_TABLE = "pull_request_session";

/** Bounded sweep scans. A saturated feed sets `truncated` on the counts —
 * live traffic converges on later ticks as rows keep changing, but a
 * wide-window historical backfill that reports `truncated: true` did NOT
 * cover everything and needs more passes. */
const MAX_SWEEP_PRS = 5_000;
const MAX_SWEEP_LINKS = 20_000;

const FATE_COLUMNS =
  "tenant_id, app_id, pr_number, state, opened_at, closed_at, merged_at, reverted_at, first_ci_status";

/** Injected insert seam (mirrors the reconciler's ChQueryFn): tests capture
 * exact rows; deployments without ClickHouse configured pass null and skip. */
export type ScoresInsertFn = (rows: OutcomeScoreRow[]) => Promise<void>;

interface EmitCounts {
  prs: number;
  links: number;
  scoreRows: number;
}

/** PR numbers per converge query — a sweep can hand this function thousands
 * of numbers, and an unbounded `in (...)` filter overruns URL limits. */
const CONVERGE_CHUNK = 500;

export async function emitOutcomeScoresForPrs(
  supabase: SupabaseClient,
  insertScores: ScoresInsertFn,
  input: { appId: string; prNumbers: number[]; now?: Date },
): Promise<EmitCounts> {
  const prNumbers = [...new Set(input.prNumbers)].filter((n) => Number.isFinite(n) && n > 0);
  const counts: EmitCounts = { prs: 0, links: 0, scoreRows: 0 };
  if (prNumbers.length === 0) return counts;
  const nowMs = (input.now ?? new Date()).getTime();

  for (let i = 0; i < prNumbers.length; i += CONVERGE_CHUNK) {
    const chunk = prNumbers.slice(i, i + CONVERGE_CHUNK);

    const { data: prs, error: prError } = await supabase
      .from(PULL_REQUEST_TABLE)
      .select(FATE_COLUMNS)
      .eq("app_id", input.appId)
      .in("pr_number", chunk);
    if (prError) throw new Error(`pull_request fate read failed: ${prError.message}`);
    if (!prs?.length) continue;

    const { data: links, error: linkError } = await supabase
      .from(PULL_REQUEST_SESSION_TABLE)
      .select("pr_number, trace_id")
      .eq("app_id", input.appId)
      .eq("verification", "confirmed")
      .in("pr_number", chunk);
    if (linkError) throw new Error(`pull_request_session read failed: ${linkError.message}`);

    const tracesByPr = new Map<number, string[]>();
    for (const link of links ?? []) {
      const pn = Number(link.pr_number);
      const list = tracesByPr.get(pn) ?? [];
      list.push(String(link.trace_id));
      tracesByPr.set(pn, list);
    }

    const rows = (prs as PrFateRow[]).flatMap((pr) =>
      outcomeScoreRows(pr, tracesByPr.get(Number(pr.pr_number)) ?? [], nowMs),
    );
    if (rows.length > 0) await insertScores(rows);
    counts.prs += prs.length;
    counts.links += links?.length ?? 0;
    counts.scoreRows += rows.length;
  }
  return counts;
}

export interface SweepCounts {
  apps: number;
  prs: number;
  scoreRows: number;
  /** True when any change feed hit its scan cap — coverage was partial. */
  truncated: boolean;
}

export async function sweepOutcomeScores(
  supabase: SupabaseClient,
  insertScores: ScoresInsertFn,
  input: { sinceHours: number; now?: Date },
): Promise<SweepCounts> {
  const now = input.now ?? new Date();
  const sinceIso = new Date(now.getTime() - input.sinceHours * 3_600_000).toISOString();

  // Lifecycle side: `updated_at` moves on every UPDATE (fate, CI verdict,
  // revert flag — trigger-maintained) but stays NULL on a row whose INSERT
  // was its only write, so freshly-inserted rows match on `created_at`.
  const { data: updatedPrs, error: updatedError } = await supabase
    .from(PULL_REQUEST_TABLE)
    .select("app_id, pr_number")
    .gte("updated_at", sinceIso)
    .limit(MAX_SWEEP_PRS);
  if (updatedError) throw new Error(`pull_request sweep read failed: ${updatedError.message}`);
  const { data: insertedPrs, error: insertedError } = await supabase
    .from(PULL_REQUEST_TABLE)
    .select("app_id, pr_number")
    .is("updated_at", null)
    .gte("created_at", sinceIso)
    .limit(MAX_SWEEP_PRS);
  if (insertedError) throw new Error(`pull_request sweep read failed: ${insertedError.message}`);

  // Link side: sessions sync late; a link confirmed after the PR settled is
  // the only signal that PR needs (re-)emission.
  const { data: recentLinks, error: linksError } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select("app_id, pr_number")
    .eq("verification", "confirmed")
    .gte("last_reconciled_at", sinceIso)
    .limit(MAX_SWEEP_LINKS);
  if (linksError) throw new Error(`pull_request_session sweep read failed: ${linksError.message}`);

  const byApp = new Map<string, Set<number>>();
  for (const row of [...(updatedPrs ?? []), ...(insertedPrs ?? []), ...(recentLinks ?? [])]) {
    const appId = String(row.app_id);
    const set = byApp.get(appId) ?? new Set<number>();
    set.add(Number(row.pr_number));
    byApp.set(appId, set);
  }

  const truncated =
    (updatedPrs?.length ?? 0) >= MAX_SWEEP_PRS ||
    (insertedPrs?.length ?? 0) >= MAX_SWEEP_PRS ||
    (recentLinks?.length ?? 0) >= MAX_SWEEP_LINKS;
  const counts: SweepCounts = { apps: byApp.size, prs: 0, scoreRows: 0, truncated };
  for (const [appId, prNumbers] of byApp) {
    const result = await emitOutcomeScoresForPrs(supabase, insertScores, {
      appId,
      prNumbers: [...prNumbers],
      now,
    });
    counts.prs += result.prs;
    counts.scoreRows += result.scoreRows;
  }
  return counts;
}
