import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";
import { OUTCOME_SCORE_NAMES, outcomeScoreId } from "@/lib/system/outcome-scores/score-rows";

/**
 * Outcome-score coverage reconciliation for online evals: every terminal-fated
 * PR with a confirmed session link
 * should carry `worker.*` outcome scores (`outcome-scores/emit.ts`) for that
 * session. This computes the gap directly instead of asking a human to
 * hand-write the comparison against staging.
 *
 * Coverage is checked at the exact (app, trace, PR, name) grain the writer
 * uses — by recomputing the SAME deterministic `Id` (`outcomeScoreId`) for
 * every candidate score name and querying `WHERE Id IN (...)`, not by
 * grouping on `ResourceId` (trace) alone. The `scores` table has no
 * `PrNumber` column — a session linked to multiple PRs writes multiple rows
 * that all share the same `ResourceId`, so a trace-only read cannot tell
 * which row belongs to which PR (confirmed with real staging data: one
 * dogfood session spanning 25 PRs made a naive per-trace "covered" check
 * report ALL 25 as covered even though only some of them actually had
 * scores). Recomputing `Id` sidesteps this — it's the same three-way key
 * (trace, PR, name) the writer already used to make the row unique.
 *
 * Read-only, cross-tenant (platform-admin) — the deployment's own
 * ClickHouse/Postgres connection is the isolation boundary (staging sees
 * staging, production sees production), not a query filter.
 *
 * The `Source = 'outcome'` filter is a spoofing guard: a row with a
 * coincidentally-matching `Id` but a different provenance must never count
 * as covered.
 */

const PULL_REQUEST_TABLE = "pull_request";
const PULL_REQUEST_SESSION_TABLE = "pull_request_session";
const OUTCOME_SOURCE = "outcome";

/** Bounded scans — a platform-admin report, not a full-table walk. */
const MAX_PRS = 5_000;
const MAX_LINKS = 20_000;
/** ClickHouse `IN (...)` chunk size — mirrors CONVERGE_CHUNK in outcome-scores/emit.ts. */
const QUERY_CHUNK = 500;
/** Cap on the "go hand-check these" sample returned to the caller. */
const MAX_MISSING_SAMPLES = 25;
/** Cap on the ground-truth-audit sample of COVERED links (DoD item 6: hand-check
 * ≥10 PRs against actual GitHub fate) — includes the actual score rows found,
 * not just identity, since that's what the audit needs to diff against reality. */
const MAX_COVERED_SAMPLES = 15;

interface MissingCoverageSample {
  appId: string;
  prNumber: number;
  traceId: string;
}

interface CoveredScoreRow {
  name: string;
  score: number;
  label: string;
}

interface CoveredCoverageSample {
  appId: string;
  prNumber: number;
  traceId: string;
  scores: CoveredScoreRow[];
}

interface ScoreCoverageResult {
  /** Confirmed (app, PR, session) links behind a terminal-fated PR. */
  confirmedLinks: number;
  /** Of those, how many have at least one `Source='outcome'` score row. */
  covered: number;
  missing: number;
  /** Up to MAX_MISSING_SAMPLES of the missing links, for hand-auditing. */
  missingSamples: MissingCoverageSample[];
  /** Up to MAX_COVERED_SAMPLES of the covered links WITH their actual score
   * rows, for the ground-truth audit — hand-check these against GitHub. */
  coveredSamples: CoveredCoverageSample[];
  /** True when a scan hit its cap — the count is a lower bound, not exact. */
  truncated: boolean;
}

interface TerminalPrRow {
  app_id: string;
  pr_number: number;
}

interface ConfirmedLinkRow {
  app_id: string;
  pr_number: number;
  trace_id: string;
}

export async function computeScoreCoverage(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: { appId?: string; prNumber?: number } = {},
): Promise<ScoreCoverageResult> {
  const empty: ScoreCoverageResult = {
    confirmedLinks: 0,
    covered: 0,
    missing: 0,
    missingSamples: [],
    coveredSamples: [],
    truncated: false,
  };

  let prQuery = supabase
    .from(PULL_REQUEST_TABLE)
    .select("app_id, pr_number")
    .in("state", ["merged", "closed"])
    .limit(MAX_PRS);
  if (input.appId) prQuery = prQuery.eq("app_id", input.appId);
  if (input.prNumber !== undefined) prQuery = prQuery.eq("pr_number", input.prNumber);
  const { data: prs, error: prError } = await prQuery;
  if (prError) throw new Error(`pull_request read failed: ${prError.message}`);
  const terminalPrs = (prs ?? []) as TerminalPrRow[];
  if (terminalPrs.length === 0) return empty;
  const terminalKeys = new Set(terminalPrs.map((p) => `${p.app_id}:${p.pr_number}`));

  let linkQuery = supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select("app_id, pr_number, trace_id")
    .eq("verification", "confirmed")
    .limit(MAX_LINKS);
  if (input.appId) linkQuery = linkQuery.eq("app_id", input.appId);
  if (input.prNumber !== undefined) linkQuery = linkQuery.eq("pr_number", input.prNumber);
  const { data: links, error: linkError } = await linkQuery;
  if (linkError) throw new Error(`pull_request_session read failed: ${linkError.message}`);
  const allLinks = (links ?? []) as ConfirmedLinkRow[];

  const confirmed = allLinks.filter((l) => terminalKeys.has(`${l.app_id}:${l.pr_number}`));
  if (confirmed.length === 0) return empty;

  const truncated = terminalPrs.length >= MAX_PRS || allLinks.length >= MAX_LINKS;

  const scoreNames = Object.values(OUTCOME_SCORE_NAMES);
  /** One entry per candidate (link, score name) — the exact grain the writer
   * emits at. A link's Id is unique per name, so this map is collision-free. */
  const idToCandidate = new Map<string, { link: ConfirmedLinkRow; name: string }>();
  for (const link of confirmed) {
    for (const name of scoreNames) {
      idToCandidate.set(outcomeScoreId(link.app_id, link.trace_id, link.pr_number, name), { link, name });
    }
  }
  const allIds = [...idToCandidate.keys()];

  const scoresByLink = new Map<string, CoveredScoreRow[]>();
  const coveredLinkKeys = new Set<string>();
  const linkKey = (l: ConfirmedLinkRow) => `${l.app_id}:${l.pr_number}:${l.trace_id}`;
  for (let i = 0; i < allIds.length; i += QUERY_CHUNK) {
    const chunk = allIds.slice(i, i + QUERY_CHUNK);
    const rows = await chQuery(
      `SELECT Id, Score, Label
FROM scores FINAL
WHERE Source = {source:String}
  AND IsDeleted = 0
  AND Id IN {ids:Array(String)}`,
      { source: OUTCOME_SOURCE, ids: chunk },
    );
    for (const row of rows) {
      const candidate = idToCandidate.get(String(row.Id));
      if (!candidate) continue; // stale/unrelated Id — shouldn't happen, defensive only
      const key = linkKey(candidate.link);
      coveredLinkKeys.add(key);
      const list = scoresByLink.get(key) ?? [];
      list.push({ name: candidate.name, score: Number(row.Score), label: String(row.Label) });
      scoresByLink.set(key, list);
    }
  }

  const missingLinks = confirmed.filter((l) => !coveredLinkKeys.has(linkKey(l)));
  const coveredLinks = confirmed.filter((l) => coveredLinkKeys.has(linkKey(l)));

  return {
    confirmedLinks: confirmed.length,
    covered: coveredLinks.length,
    missing: missingLinks.length,
    missingSamples: missingLinks.slice(0, MAX_MISSING_SAMPLES).map((l) => ({
      appId: l.app_id,
      prNumber: Number(l.pr_number),
      traceId: l.trace_id,
    })),
    coveredSamples: coveredLinks.slice(0, MAX_COVERED_SAMPLES).map((l) => ({
      appId: l.app_id,
      prNumber: Number(l.pr_number),
      traceId: l.trace_id,
      scores: scoresByLink.get(linkKey(l)) ?? [],
    })),
    truncated,
  };
}
