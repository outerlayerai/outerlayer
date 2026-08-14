import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionPrOutcome } from "@repo/api-schemas";
import {
  fetchOutcomesForTraces as sharedFetchOutcomesForTraces,
  type PrOutcomeLinksReader,
} from "@repo/observability-service";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";
import { outcomeScoreId } from "./score-rows";

export type { SessionPrOutcome };

const PULL_REQUEST_SESSION_TABLE = "pull_request_session";
const PULL_REQUEST_TABLE = "pull_request";

/** Confirmed links to scan in one batch — a page of sessions, not the world. */
const MAX_LINKS = 5000;

/** This host's `PrOutcomeLinksReader`: the two Postgres reads the shared
 * `fetchOutcomesForTraces` core needs, run through the caller's RLS-scoped
 * client. */
function linksReader(supabase: SupabaseClient): PrOutcomeLinksReader {
  return {
    async confirmedLinks({ tenantId, appId, traceIds }) {
      // Duplicate/empty trace ids need no special-casing: the `.in(...)` set
      // and the deterministic-Id keying downstream both collapse them, and
      // an empty page yields an empty `.in()` that matches nothing.
      const { data, error } = await supabase
        .from(PULL_REQUEST_SESSION_TABLE)
        .select("trace_id, pr_number")
        .eq("tenant_id", tenantId)
        .eq("app_id", appId)
        .eq("verification", "confirmed")
        .in("trace_id", traceIds as string[])
        .limit(MAX_LINKS);
      if (error) throw new Error(`pull_request_session read failed: ${error.message}`);
      return (data ?? []).map((link: { trace_id: string; pr_number: number }) => ({
        traceId: String(link.trace_id),
        prNumber: Number(link.pr_number),
      }));
    },
    async prUrls({ tenantId, appId, prNumbers }) {
      if (prNumbers.length === 0) return [];
      // Provider URLs for the linked PRs (pr_number is unique per app) — so
      // the UI can link a PR number straight to GitHub. A missing url stays
      // null.
      const { data, error } = await supabase
        .from(PULL_REQUEST_TABLE)
        .select("pr_number, url")
        .eq("tenant_id", tenantId)
        .eq("app_id", appId)
        .in("pr_number", [...prNumbers]);
      if (error) throw new Error(`pull_request url read failed: ${error.message}`);
      return (data ?? []).map((pr: { pr_number: number; url: string | null }) => ({
        prNumber: Number(pr.pr_number),
        url: pr.url || null,
      }));
    },
  };
}

/**
 * `traceId -> outcomes-by-PR` for every given trace that produced a scored
 * PR. Traces with no confirmed PR link, or whose linked PRs aren't scored
 * yet, are absent from the map (callers default to []).
 *
 * Tenant-scoped: the caller passes an RLS-scoped Supabase client and a
 * tenant-scoped ClickHouse `ChQueryFn`; both enforce the tenant boundary, so
 * this is a user-facing read, not the platform-admin coverage sweep. Two
 * entry points share this core: this one for a whole page of sessions in one
 * round-trip (the Sessions list column), and `fetchSessionOutcomeScores`
 * below for a single session (the detail view's strip) — the list can't
 * afford the single read run 50×.
 */
export async function fetchOutcomesForTraces(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: { tenantId: string; appId: string; traceIds: readonly string[] },
): Promise<Map<string, SessionPrOutcome[]>> {
  return sharedFetchOutcomesForTraces(linksReader(supabase), chQuery, outcomeScoreId, input);
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
