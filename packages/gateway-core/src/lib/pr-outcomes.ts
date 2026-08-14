/**
 * PR-outcome scores for agent sessions — the gateway's `PrOutcomeReader` port
 * for `AgentSessionsService`. The matching/query core (recomputing the
 * writer's deterministic per-(trace, PR, score name) `Id` and joining it
 * against ClickHouse) is shared with the dashboard's
 * `lib/system/outcome-scores/session-outcome-read.ts` via
 * `@repo/observability-service`'s `fetchOutcomesForTraces`; this module is
 * just the gateway's Postgres port plus the Web-Crypto score-id hash
 * (`webCryptoOutcomeScoreId` — Cloudflare Workers has no `node:crypto`,
 * so it can't share the dashboard writer's hash primitive directly, only the
 * matching logic built on top of it).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SessionPrOutcome } from '@repo/api-schemas';
import {
  fetchOutcomesForTraces,
  webCryptoOutcomeScoreId,
  type PrOutcomeLinksReader,
  type PrOutcomeReader,
} from '@repo/observability-service';
import type { ChQueryFn } from '../openapi/analytics-factory';

const PULL_REQUEST_SESSION_TABLE = 'pull_request_session';
const PULL_REQUEST_TABLE = 'pull_request';

/** This host's `PrOutcomeLinksReader`: the two Postgres reads the shared
 * `fetchOutcomesForTraces` core needs, run through the caller's Supabase
 * client. Untyped client: `pull_request_session`/`pull_request` aren't in
 * gateway-core's narrow Database slice; RLS enforces the tenant boundary
 * regardless of column typing. */
function linksReader(supabase: SupabaseClient<any>): PrOutcomeLinksReader {
  return {
    async confirmedLinks({ tenantId, appId, traceIds }) {
      const { data, error } = await supabase
        .from(PULL_REQUEST_SESSION_TABLE)
        .select('trace_id, pr_number')
        .eq('tenant_id', tenantId)
        .eq('app_id', appId)
        .eq('verification', 'confirmed')
        .in('trace_id', traceIds as string[]);
      if (error) throw new Error(`pull_request_session read failed: ${error.message}`);
      return (data ?? []).map((link: { trace_id: string; pr_number: number }) => ({
        traceId: String(link.trace_id),
        prNumber: Number(link.pr_number),
      }));
    },
    async prUrls({ tenantId, appId, prNumbers }) {
      if (prNumbers.length === 0) return [];
      const { data, error } = await supabase
        .from(PULL_REQUEST_TABLE)
        .select('pr_number, url')
        .eq('tenant_id', tenantId)
        .eq('app_id', appId)
        .in('pr_number', [...prNumbers]);
      if (error) throw new Error(`pull_request url read failed: ${error.message}`);
      return (data ?? []).map((pr: { pr_number: number; url: string | null }) => ({
        prNumber: Number(pr.pr_number),
        url: pr.url ?? null,
      }));
    },
  };
}

/**
 * Builds the `PrOutcomeReader` port `AgentSessionsService` calls. A read
 * failure degrades to "no outcomes" for every trace rather than failing the
 * whole session read — the Outcome column/strip just doesn't render, same as
 * the dashboard's behavior. The error is logged before degrading: a silent
 * swallow here is indistinguishable from "this session genuinely has no PR
 * outcomes", which is exactly what hid the missing gateway-role grants.
 */
export function buildPrOutcomeReader(
  supabase: SupabaseClient<any>,
  chQuery: ChQueryFn | null,
  scope: { tenantId: string; appId: string },
): PrOutcomeReader {
  return {
    async forSessions(traceIds) {
      if (!chQuery) return () => [];
      const byTrace = await fetchOutcomesForTraces(linksReader(supabase), chQuery, webCryptoOutcomeScoreId, {
        tenantId: scope.tenantId,
        appId: scope.appId,
        traceIds,
      }).catch((error: unknown) => {
        console.error('[buildPrOutcomeReader] degrading to no outcomes', error);
        return new Map<string, SessionPrOutcome[]>();
      });
      return (traceId: string) => byTrace.get(traceId) ?? [];
    },
  };
}
