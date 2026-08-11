/**
 * PR-outcome scores for agent sessions — the gateway's `PrOutcomeReader` port
 * for `AgentSessionsService`.
 *
 * Mirrors the dashboard's `lib/system/outcome-scores/session-outcome-read.ts`:
 * the `scores` table has no PR-number column, so a session that produced
 * several PRs (stacked PRs, long-running seats) needs its outcome facts
 * disambiguated per PR. The writer (`lib/system/outcome-scores/score-rows.ts`)
 * emits each fact under a deterministic `Id = hash(appId, traceId, prNumber,
 * name)`; this reader recomputes the same id space and matches by `Id`,
 * rather than trying to infer which PR a `ResourceId = traceId` row belongs
 * to (it belongs to all of them).
 *
 * The hash itself is reimplemented with Web Crypto (`crypto.subtle.digest`)
 * rather than imported from the dashboard's `node:crypto` version — Cloudflare
 * Workers has no `node:crypto`, and gateway-core stays Workers-clean. Both
 * implementations must stay byte-for-byte identical or this reader silently
 * stops matching the writer's rows.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SessionPrOutcome } from '@repo/api-schemas';
import type { PrOutcomeReader } from '@repo/observability-service';
import type { ChQueryFn } from '../openapi/analytics-factory';

const OUTCOME_SOURCE = 'outcome';
const PULL_REQUEST_SESSION_TABLE = 'pull_request_session';
const PULL_REQUEST_TABLE = 'pull_request';
/** ClickHouse `IN (...)` chunk size — mirrors the dashboard reader. */
const QUERY_CHUNK = 500;

const OUTCOME_SCORE_NAMES = {
  ciGreen: 'worker.ci_green',
  merged: 'worker.merged',
  reverted: 'worker.reverted',
} as const;

async function outcomeScoreId(appId: string, traceId: string, prNumber: number, name: string): Promise<string> {
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

async function fetchOutcomesForTraces(
  // Untyped: `pull_request_session`/`pull_request` aren't in gateway-core's narrow Database slice; RLS enforces the tenant boundary regardless of column typing.
  supabase: SupabaseClient<any>,
  chQuery: ChQueryFn,
  input: { tenantId: string; appId: string; traceIds: readonly string[] },
): Promise<Map<string, SessionPrOutcome[]>> {
  const out = new Map<string, SessionPrOutcome[]>();
  if (input.traceIds.length === 0) return out;

  const { data: links, error } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select('trace_id, pr_number')
    .eq('tenant_id', input.tenantId)
    .eq('app_id', input.appId)
    .eq('verification', 'confirmed')
    .in('trace_id', input.traceIds as string[]);
  if (error) throw new Error(`pull_request_session read failed: ${error.message}`);

  const scoreNames = Object.values(OUTCOME_SCORE_NAMES);
  const idToCandidate = new Map<string, { traceId: string; prNumber: number; name: string }>();
  const prNumbers = new Set<number>();
  for (const link of (links ?? []) as { trace_id: string; pr_number: number }[]) {
    const traceId = String(link.trace_id);
    const prNumber = Number(link.pr_number);
    prNumbers.add(prNumber);
    for (const name of scoreNames) {
      const id = await outcomeScoreId(input.appId, traceId, prNumber, name);
      idToCandidate.set(id, { traceId, prNumber, name });
    }
  }
  const allIds = [...idToCandidate.keys()];
  if (allIds.length === 0) return out;

  const urlByPr = new Map<number, string>();
  if (prNumbers.size > 0) {
    const { data: prs, error: prErr } = await supabase
      .from(PULL_REQUEST_TABLE)
      .select('pr_number, url')
      .eq('tenant_id', input.tenantId)
      .eq('app_id', input.appId)
      .in('pr_number', [...prNumbers]);
    if (prErr) throw new Error(`pull_request url read failed: ${prErr.message}`);
    for (const pr of (prs ?? []) as { pr_number: number; url: string | null }[]) {
      if (pr.url) urlByPr.set(Number(pr.pr_number), pr.url);
    }
  }

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
      if (!candidate) continue;
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
 * Builds the `PrOutcomeReader` port `AgentSessionsService` calls. A read
 * failure degrades to "no outcomes" for every trace rather than failing the
 * whole session read — the Outcome column/strip just doesn't render, same as
 * the dashboard's behavior.
 */
export function buildPrOutcomeReader(
  supabase: SupabaseClient<any>,
  chQuery: ChQueryFn | null,
  scope: { tenantId: string; appId: string },
): PrOutcomeReader {
  return {
    async forSessions(traceIds) {
      if (!chQuery) return () => [];
      const byTrace = await fetchOutcomesForTraces(supabase, chQuery, {
        tenantId: scope.tenantId,
        appId: scope.appId,
        traceIds,
      }).catch(() => new Map<string, SessionPrOutcome[]>());
      return (traceId: string) => byTrace.get(traceId) ?? [];
    },
  };
}
