import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";
import { isFateDerivedScoreName } from "@/lib/system/outcome-scores/score-rows";

/**
 * Predictor-score verdicts by PR, the online-evals validation loop: joins a
 * named ClickHouse `scores` row to the PRs its
 * writing session is confirmed-linked to, so `pr-metrics.ts` can segment
 * merge/cycle-time/revert-rate by eval pass-vs-fail.
 *
 * Anti-circularity is enforced by NAME, against the explicit
 * `FATE_DERIVED_SCORE_NAMES` set the writer declares — not by filtering on
 * `Source`. `Source` records who emitted a score, and every system score
 * here shares one emitter, so a Source filter could only separate fate from
 * predictor by inventing a source per exception. The named set also lets
 * callers fail LOUDLY (`worker.merged` is rejected with a reason) instead of
 * silently matching nothing, and its `Record<keyof …>` backing makes an
 * unclassified new score a compile error rather than a silent tautology.
 *
 * Two attribution ambiguities the coverage-grain bug already forced
 * a decision on, resolved the same way here:
 *
 *  - The `scores` table has no PR-number column, so a predictor score can
 *    only be read back by `ResourceId` (trace) — it carries no PR dimension
 *    at write time (unlike outcome scores, whose `Id` bakes the PR in). A
 *    trace confirmed-linked to N PRs therefore has its one verdict applied
 *    to EACH of those N PRs independently, same as the coverage check
 *    attributes outcome-score coverage per (trace, PR) link, not per trace.
 *  - A PR with MULTIPLE confirmed session links whose verdicts disagree
 *    resolves to fail — "failure sticky", the same philosophy already
 *    proven for `worker.ci_green` (a later pass never overwrites an
 *    observed first-run failure).
 */

const PULL_REQUEST_SESSION_TABLE = "pull_request_session";

/** ClickHouse `IN (...)` chunk size — mirrors `score-coverage/coverage.ts`. */
const QUERY_CHUNK = 500;
/** Bounded scan — a widget query, not a full-table walk. */
const MAX_LINKS = 20_000;

interface ConfirmedLinkRow {
  pr_number: number;
  trace_id: string;
}

interface ScoreRow {
  ResourceId: string;
  Score: number;
  CreatedAt: string;
}

/** The latest (by `CreatedAt`) predictor-score row per trace — a re-emitted
 * score (e.g. a re-run judge) supersedes its earlier verdict for this join,
 * the same "newest row wins" contract `ReplacingMergeTree` gives writers. */
function latestVerdictByTrace(rows: readonly ScoreRow[]): Map<string, boolean> {
  const latest = new Map<string, ScoreRow>();
  for (const row of rows) {
    const existing = latest.get(row.ResourceId);
    if (!existing || row.CreatedAt > existing.CreatedAt) {
      latest.set(row.ResourceId, row);
    }
  }
  return new Map([...latest.entries()].map(([traceId, row]) => [traceId, row.Score >= 1]));
}

/**
 * `prNumber -> pass` for every confirmed link whose trace carries a
 * `scoreName` verdict. PRs with no confirmed link, or whose linked trace(s)
 * never emitted this score, are absent from the map — callers must treat
 * absence as "no signal", never as a fail.
 *
 * Throws on a fate-derived `scoreName`. This is the data-layer half of the
 * anti-circularity guard: the route rejects it first with a user-facing
 * message, but a direct caller must not be able to slip past that.
 */
export async function fetchPredictorScoreVerdictsByPr(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: { tenantId: string; appId: string; scoreName: string },
): Promise<Map<number, boolean>> {
  if (isFateDerivedScoreName(input.scoreName)) {
    throw new Error(
      `"${input.scoreName}" is a PR-fate outcome, not a predictor — correlating it against PR outcomes would be circular.`,
    );
  }

  const { data: links, error } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select("pr_number, trace_id")
    .eq("tenant_id", input.tenantId)
    .eq("app_id", input.appId)
    .eq("verification", "confirmed")
    .limit(MAX_LINKS);
  if (error) throw new Error(`pull_request_session read failed: ${error.message}`);
  const confirmed = (links ?? []) as ConfirmedLinkRow[];
  if (confirmed.length === 0) return new Map();

  const traceIds = [...new Set(confirmed.map((l) => l.trace_id))];
  const scoreRows: ScoreRow[] = [];
  for (let i = 0; i < traceIds.length; i += QUERY_CHUNK) {
    const chunk = traceIds.slice(i, i + QUERY_CHUNK);
    const rows = await chQuery(
      `SELECT ResourceId, Score, CreatedAt
FROM scores FINAL
WHERE IsDeleted = 0
  AND Name = {name:String}
  AND ResourceId IN {ids:Array(String)}`,
      { name: input.scoreName, ids: chunk },
    );
    for (const row of rows) {
      scoreRows.push({
        ResourceId: String(row.ResourceId),
        Score: Number(row.Score),
        CreatedAt: String(row.CreatedAt),
      });
    }
  }
  const verdictByTrace = latestVerdictByTrace(scoreRows);

  const verdictByPr = new Map<number, boolean>();
  for (const link of confirmed) {
    const verdict = verdictByTrace.get(link.trace_id);
    if (verdict === undefined) continue;
    const prNumber = Number(link.pr_number);
    // Failure-sticky across multiple confirmed sessions on the same PR.
    const existing = verdictByPr.get(prNumber);
    verdictByPr.set(prNumber, existing === undefined ? verdict : existing && verdict);
  }
  return verdictByPr;
}
