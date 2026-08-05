import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";
import { OUTCOME_SCORE_NAMES, outcomeScoreId } from "./score-rows";

/**
 * PR-outcome scores for a session, grouped by the PR they belong to. Answers
 * "for the PR(s) this session produced, did CI pass first try, did it merge,
 * was it reverted?" using the scores the outcome writer already emits.
 *
 * Grouped by PR on purpose. A session can produce several PRs (stacked PRs,
 * long seat sessions), and the `scores` table has no PR-number column — every
 * `worker.*` row for a session shares one `ResourceId` (the trace), so a plain
 * `WHERE ResourceId = {trace}` read collapses two PRs' outcomes into an
 * ambiguous pile. This recomputes the writer's own deterministic
 * `outcomeScoreId(app, trace, pr, name)` per (linked PR, score name) and
 * matches by `Id` — the same technique the coverage reconciler uses — so each
 * PR's outcome is attributed to exactly that PR.
 *
 * Two entry points share one core: `fetchSessionOutcomeScores` for a single
 * session (the detail view's strip) and `fetchOutcomesForTraces` for a whole
 * page of sessions in one round-trip (the Sessions list column) — the list
 * can't afford the single read run 50×.
 *
 * Tenant-scoped: the caller passes an RLS-scoped Supabase client and a
 * tenant-scoped ClickHouse `ChQueryFn`; both enforce the tenant boundary, so
 * this is a user-facing read, not the platform-admin coverage sweep.
 */

const PULL_REQUEST_SESSION_TABLE = "pull_request_session";
const OUTCOME_SOURCE = "outcome";

/** Confirmed links to scan in one batch — a page of sessions, not the world. */
const MAX_LINKS = 5000;
/** ClickHouse `IN (...)` chunk size — mirrors the coverage reconciler. */
const QUERY_CHUNK = 500;

/** A single score's value + its human label, or absent when never emitted. */
interface OutcomeFact {
  score: number;
  label: string;
}

export interface SessionPrOutcome {
  prNumber: number;
  /** The provider PR/MR page, for linking out. NULL when the provider payload
   * never carried a URL (older rows) — render the number without a link. */
  prUrl: string | null;
  /** First-pass CI verdict. Absent = no CI signal observed (not "red"). */
  ciGreen: OutcomeFact | null;
  /** Terminal fate. Absent while the PR is still open. */
  merged: OutcomeFact | null;
  /** Revert durability. Absent unless the PR merged. */
  reverted: OutcomeFact | null;
}

interface ConfirmedLinkRow {
  trace_id: string;
  pr_number: number;
}

const PULL_REQUEST_TABLE = "pull_request";

/**
 * `traceId -> outcomes-by-PR` for every given trace that produced a scored PR.
 * Traces with no confirmed PR link, or whose linked PRs aren't scored yet, are
 * absent from the map (callers default to []).
 */
export async function fetchOutcomesForTraces(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: { tenantId: string; appId: string; traceIds: readonly string[] },
): Promise<Map<string, SessionPrOutcome[]>> {
  // Duplicate/empty trace ids need no special-casing: the `.in(...)` set and
  // the deterministic-Id keying below both collapse them, and an empty page
  // yields an empty `.in()` that matches nothing.
  const { data: links, error } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select("trace_id, pr_number")
    .eq("tenant_id", input.tenantId)
    .eq("app_id", input.appId)
    .eq("verification", "confirmed")
    .in("trace_id", input.traceIds as string[])
    .limit(MAX_LINKS);
  if (error) throw new Error(`pull_request_session read failed: ${error.message}`);

  // Recompute the writer's deterministic Id per (trace, PR, score name) so
  // each score row maps back to exactly one (session, PR) — the row itself
  // carries neither the PR number nor which session grain it belongs to.
  const scoreNames = Object.values(OUTCOME_SCORE_NAMES);
  // Keyed by the deterministic score Id, so a (trace, PR) linked more than
  // once collapses to the same entries — no separate dedup needed.
  const idToCandidate = new Map<string, { traceId: string; prNumber: number; name: string }>();
  const prNumbers = new Set<number>();
  for (const link of (links ?? []) as ConfirmedLinkRow[]) {
    const traceId = String(link.trace_id);
    const prNumber = Number(link.pr_number);
    prNumbers.add(prNumber);
    for (const name of scoreNames) {
      idToCandidate.set(outcomeScoreId(input.appId, traceId, prNumber, name), { traceId, prNumber, name });
    }
  }
  const allIds = [...idToCandidate.keys()];

  // Provider URLs for the linked PRs (pr_number is unique per app) — so the UI
  // can link a PR number straight to GitHub. A missing url stays null.
  const urlByPr = new Map<number, string>();
  if (prNumbers.size > 0) {
    const { data: prs, error: prErr } = await supabase
      .from(PULL_REQUEST_TABLE)
      .select("pr_number, url")
      .eq("tenant_id", input.tenantId)
      .eq("app_id", input.appId)
      .in("pr_number", [...prNumbers]);
    if (prErr) throw new Error(`pull_request url read failed: ${prErr.message}`);
    for (const pr of (prs ?? []) as { pr_number: number; url: string | null }[]) {
      if (pr.url) urlByPr.set(Number(pr.pr_number), pr.url);
    }
  }

  // traceId -> prNumber -> outcome
  const byTrace = new Map<string, Map<number, SessionPrOutcome>>();
  const ensure = (traceId: string, prNumber: number): SessionPrOutcome => {
    let byPr = byTrace.get(traceId);
    if (!byPr) {
      byPr = new Map();
      byTrace.set(traceId, byPr);
    }
    let row = byPr.get(prNumber);
    if (!row) {
      row = { prNumber, prUrl: urlByPr.get(prNumber) ?? null, ciGreen: null, merged: null, reverted: null };
      byPr.set(prNumber, row);
    }
    return row;
  };

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
    for (const raw of rows) {
      const candidate = idToCandidate.get(String(raw.Id));
      if (!candidate) continue; // stale/unrelated Id — defensive only
      const fact: OutcomeFact = { score: Number(raw.Score), label: String(raw.Label) };
      const row = ensure(candidate.traceId, candidate.prNumber);
      if (candidate.name === OUTCOME_SCORE_NAMES.ciGreen) row.ciGreen = fact;
      else if (candidate.name === OUTCOME_SCORE_NAMES.merged) row.merged = fact;
      else if (candidate.name === OUTCOME_SCORE_NAMES.reverted) row.reverted = fact;
    }
  }

  const out = new Map<string, SessionPrOutcome[]>();
  for (const [traceId, byPr] of byTrace) {
    out.set(traceId, [...byPr.values()].sort((a, b) => a.prNumber - b.prNumber));
  }
  return out;
}

/** Single-session convenience over `fetchOutcomesForTraces` — the detail
 * view's strip. Returns [] when the session produced no scored PR. */
export async function fetchSessionOutcomeScores(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: { tenantId: string; appId: string; traceId: string },
): Promise<SessionPrOutcome[]> {
  const byTrace = await fetchOutcomesForTraces(supabase, chQuery, {
    tenantId: input.tenantId,
    appId: input.appId,
    traceIds: [input.traceId],
  });
  return byTrace.get(input.traceId) ?? [];
}
