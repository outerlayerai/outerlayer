/**
 * PR-outcome score matching — the reader shared by the dashboard's Sessions
 * views and the gateway's session reads, both consumed as the
 * `AgentSessionsService` `PrOutcomeReader` port (see `agent-sessions.ts`).
 *
 * The `scores` table has no PR-number column, so a session that produced
 * several PRs (stacked PRs, long-running seats) needs its outcome facts
 * disambiguated per PR. The writer (the dashboard's PR webhook) emits every
 * fact under a deterministic `Id = hash(appId, traceId, prNumber, name)`;
 * this reader recomputes the same id space and matches by `Id`, rather than
 * inferring which PR a `ResourceId = traceId` row belongs to (it belongs to
 * all of them).
 *
 * Two ports keep this package Worker-clean and Postgres-agnostic:
 *  - `PrOutcomeLinksReader` — the `pull_request_session`/`pull_request` reads.
 *    This package has no `@supabase/supabase-js` dependency, so each host
 *    supplies its own RLS-scoped client behind the port.
 *  - `computeId` — the score-id hash. The dashboard's writer hashes with
 *    `node:crypto`'s `createHash`; a reader that recomputed with a different
 *    primitive would silently stop matching those rows, so each host passes
 *    back whatever produces byte-identical ids to its own writer.
 *    `webCryptoOutcomeScoreId` below is that function for hosts with no
 *    `node:crypto` (Cloudflare Workers).
 */
import type { SessionPrOutcome } from '@repo/api-schemas';

/** Minimal parameterized-query seam, satisfied by both hosts' ClickHouse clients. */
export type ChQueryFn = (sql: string, params: Record<string, unknown>) => Promise<Record<string, unknown>[]>;

const OUTCOME_SOURCE = 'outcome';
/** ClickHouse `IN (...)` chunk size. */
const QUERY_CHUNK = 500;

export const OUTCOME_SCORE_NAMES = {
  ciGreen: 'worker.ci_green',
  merged: 'worker.merged',
  reverted: 'worker.reverted',
} as const;

/** Recomputes the writer's deterministic score id for one (trace, PR, score
 * name) candidate. Sync or async: the reader always awaits the result, so a
 * host backed by a synchronous hash (e.g. `node:crypto`) needs no wrapping. */
export type ComputeOutcomeScoreId = (
  appId: string,
  traceId: string,
  prNumber: number,
  name: string,
) => string | Promise<string>;

export interface PrOutcomeLink {
  traceId: string;
  prNumber: number;
}

/** The Postgres reads `fetchOutcomesForTraces` needs, implemented per host
 * against its own Supabase client. */
export interface PrOutcomeLinksReader {
  confirmedLinks(input: {
    tenantId: string;
    appId: string;
    traceIds: readonly string[];
  }): Promise<PrOutcomeLink[]>;
  prUrls(input: {
    tenantId: string;
    appId: string;
    prNumbers: readonly number[];
  }): Promise<{ prNumber: number; url: string | null }[]>;
}

/**
 * `traceId -> outcomes-by-PR` for every given trace that produced a scored
 * PR. Traces with no confirmed PR link, or whose linked PRs aren't scored
 * yet, are absent from the map (callers default to []).
 */
export async function fetchOutcomesForTraces(
  links: PrOutcomeLinksReader,
  chQuery: ChQueryFn,
  computeId: ComputeOutcomeScoreId,
  input: { tenantId: string; appId: string; traceIds: readonly string[] },
): Promise<Map<string, SessionPrOutcome[]>> {
  const out = new Map<string, SessionPrOutcome[]>();
  if (input.traceIds.length === 0) return out;

  const confirmed = await links.confirmedLinks({
    tenantId: input.tenantId,
    appId: input.appId,
    traceIds: input.traceIds,
  });

  // Recompute the writer's deterministic Id per (trace, PR, score name) so
  // each score row maps back to exactly one (session, PR) — the row itself
  // carries neither the PR number nor which session grain it belongs to.
  const scoreNames = Object.values(OUTCOME_SCORE_NAMES);
  // Keyed by the deterministic score Id, so a (trace, PR) linked more than
  // once collapses to the same entries — no separate dedup needed.
  const idToCandidate = new Map<string, { traceId: string; prNumber: number; name: string }>();
  const prNumbers = new Set<number>();
  for (const link of confirmed) {
    prNumbers.add(link.prNumber);
    for (const name of scoreNames) {
      const id = await computeId(input.appId, link.traceId, link.prNumber, name);
      idToCandidate.set(id, { traceId: link.traceId, prNumber: link.prNumber, name });
    }
  }
  const allIds = [...idToCandidate.keys()];
  if (allIds.length === 0) return out;

  // Provider URLs for the linked PRs (pr_number is unique per app) — so the
  // UI can link a PR number straight to GitHub. A missing url stays null.
  const urlByPr = new Map<number, string>();
  if (prNumbers.size > 0) {
    const prs = await links.prUrls({ tenantId: input.tenantId, appId: input.appId, prNumbers: [...prNumbers] });
    for (const pr of prs) {
      if (pr.url) urlByPr.set(pr.prNumber, pr.url);
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
WHERE TenantId = {tenantId:String}
  AND Source = {source:String}
  AND IsDeleted = 0
  AND Id IN {ids:Array(String)}`,
      { tenantId: input.tenantId, source: OUTCOME_SOURCE, ids: chunk },
    );
    for (const raw of rows) {
      const candidate = idToCandidate.get(String(raw.Id));
      if (!candidate) continue; // stale/unrelated Id — defensive only
      const fact = { score: Number(raw.Score), label: String(raw.Label) };
      const row = ensure(candidate.traceId, candidate.prNumber);
      if (candidate.name === OUTCOME_SCORE_NAMES.ciGreen) row.ciGreen = fact;
      else if (candidate.name === OUTCOME_SCORE_NAMES.merged) row.merged = fact;
      else if (candidate.name === OUTCOME_SCORE_NAMES.reverted) row.reverted = fact;
    }
  }

  for (const [traceId, byPr] of byTrace) {
    out.set(traceId, [...byPr.values()].sort((a, b) => a.prNumber - b.prNumber));
  }
  return out;
}

/**
 * Web-Crypto (`crypto.subtle.digest`) score-id computation for hosts with no
 * `node:crypto`. Must stay byte-for-byte identical to the dashboard writer's
 * `node:crypto`-based hash — both compute the same deterministic UUID-shaped
 * id from the same `${appId}\n${traceId}\n${prNumber}\n${name}` input, over
 * different SHA-256 primitives, so a reader using this stays matched to rows
 * the dashboard's writer emits.
 */
export async function webCryptoOutcomeScoreId(
  appId: string,
  traceId: string,
  prNumber: number,
  name: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(`${appId}\n${traceId}\n${prNumber}\n${name}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}
