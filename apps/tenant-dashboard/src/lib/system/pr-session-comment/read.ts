import "server-only";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { tenantChQuery } from "@/lib/system/pr-session-reconciler/ch-query";
import type { ChQueryFn } from "@/lib/system/pr-session-reconciler/reconciler";

/**
 * Read layer behind the PR session comment: every CONFIRMED session linked
 * to a `(tenant, repository, pr_number)`, with the display fields the
 * renderer needs. No I/O beyond the three reads below — this module owns
 * tenancy, the renderer stays pure.
 *
 * The RLS-bypassing admin client is constructed HERE, in the service layer,
 * for the same reason `pr-lifecycle-read.ts` documents: `pull_request_session`
 * and `git_connection` writes/reads must not depend on the caller's RLS
 * grants (the comment refresh runs from a webhook/queue context with no user
 * session). In exchange, `tenantId` MUST come from a verified source — a
 * signed webhook payload's `tenant_id`, or a `TenantContext` resolved from
 * the caller's session — NEVER a request body field taken at face value.
 * This function re-applies that scope to every row and nothing else.
 */

/** Bounded scans — a comment refresh, never a full-table walk. */
const MAX_GIT_CONNECTIONS = 1_000;
const MAX_LINKS = 5_000;
/** ClickHouse `IN (...)` chunk size, matching the reconciler's siblings
 * (`predictor-scores.ts`, `score-coverage/coverage.ts`). */
const QUERY_CHUNK = 500;

/**
 * Stable, greppable prefix carried by {@link LinksUnreadableError}'s message
 * and by the `{status: "failed", reason}` the orchestrator flattens it into.
 * A sustained run of THIS failure is an incident — it means confirmed links
 * exist that we cannot read, i.e. the one condition under which posting the
 * empty state would rewrite a customer's PR comment — unlike the other
 * `failed` reasons, which are ordinary transient noise. Alert on it by name.
 */
export const LINKS_UNREADABLE_REASON = "pr_session_comment.links_unreadable";

/**
 * Confirmed links exist for this PR but the session rows behind them cannot
 * be read (ClickHouse unconfigured or unavailable).
 *
 * A distinguishable type rather than a bare `Error` so the orchestrator's
 * catch-all can single it out: every other failure resolves to a generic
 * `failed`, but this one must be separately alertable. See the THROWS
 * paragraph on {@link readLinkedSessions} for why it must never degrade to
 * `[]`.
 */
export class LinksUnreadableError extends Error {
  readonly reasonCode = LINKS_UNREADABLE_REASON;
  readonly confirmedLinkCount: number;

  constructor(confirmedLinkCount: number) {
    super(
      `${LINKS_UNREADABLE_REASON}: ClickHouse unavailable; ${confirmedLinkCount} confirmed links unreadable`,
    );
    this.name = "LinksUnreadableError";
    this.confirmedLinkCount = confirmedLinkCount;
  }
}

export interface LinkedSessionRow {
  traceId: string;
  sessionId: string;
  /** ClickHouse `AppId` for this row's session — the deep-link scope. A
   * session's own recorded app, not necessarily the app whose
   * `git_connection` produced the link (two apps in one tenant can share a
   * repo; see the module-level fan-out). */
  appId: string;
  /** Resolved from `app.name`; falls back to the raw id if the app row is
   * gone (should not happen — `pull_request_session` cascades). */
  appName: string;
  /** The app's default environment name, for the deep-link `env` segment.
   * Empty string if the app has no default environment row. */
  envName: string;
  /** `pr_link` = explicit transcript claim; `branch` = inferred from the
   * session's branch and the PR's activity window. The renderer marks
   * `branch` rows as inferred (never presented as certain). */
  method: "pr_link" | "branch";
  title: string;
  startedAt: string;
  endedAt: string;
  costUsd: number;
  models: string[];
  apiErrorCount: number;
  errorCount: number;
}

/**
 * ClickHouse rows are hand-typed because ClickHouse has no generated schema
 * types (unlike Postgres, whose row shapes come from `@repo/db-types` through
 * the `Database`-typed admin client) and its client hands back untyped JSON.
 * Every field below is coerced at the boundary rather than trusted.
 */
interface ChSessionRow {
  TraceId: string;
  Title: string;
  StartedAt: string;
  EndedAt: string;
  CostUsd: number;
  Models: string[];
  ApiErrorCount: number;
  ErrorCount: number;
  AppId: string;
}

type AdminClient = ReturnType<typeof getAdminDataClient>;

/** `app.id -> app.name`. One batched read; callers fall back to the raw id
 * for any app the query didn't return. */
async function resolveAppNames(
  admin: AdminClient,
  appIds: string[],
): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();
  const { data } = await admin.from("app").select("id, name").in("id", appIds);
  return new Map((data ?? []).map((row) => [row.id, row.name]));
}

/** `app.id -> default environment name` (`environment.is_default = true`),
 * for the deep link's `env` URL segment. Apps with no default environment row
 * are absent from the map; callers substitute an empty string. */
async function resolveDefaultEnvNames(
  admin: AdminClient,
  appIds: string[],
): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();
  const { data } = await admin
    .from("environment")
    .select("app_id, name")
    .in("app_id", appIds)
    .eq("is_default", true);
  return new Map((data ?? []).map((row) => [row.app_id, row.name]));
}

/**
 * Every CONFIRMED session linked to `(tenantId, repository, prNumber)`,
 * OLDEST-first by `StartedAt` (see the sort at the bottom — the comment
 * reads as a narrative, unlike the newest-first dashboard list).
 *
 * Returns `null` when the feature is off for this repo — zero
 * `git_connection` rows have `pr_comments_enabled = true` — which the caller
 * reads as "no-op, do not post or edit a comment." Decided: turning the
 * toggle OFF stops future writes and LEAVES already-posted comments in
 * place. We do not go back and rewrite every comment we've ever made in
 * someone's repository on a settings change; the toggle's description copy
 * states this explicitly ("Turning this off only stops future comments"),
 * so a stale table is disclosed rather than surprising. Returns `[]` when the
 * feature is on but no session has a CONFIRMED link yet — the caller renders
 * the "No agent sessions linked yet" state, which is the true empty state
 * and needs no ClickHouse round-trip at all.
 *
 * THROWS a {@link LinksUnreadableError} when confirmed links exist but no
 * ClickHouse client resolves (unconfigured deployment, or an explicit `null`
 * override): those links are real and unreadable, not empty, and the caller
 * (`refreshPrSessionComment`) must turn this into a `{status: "failed"}`
 * rather than rendering the empty state over a comment that already lists
 * real sessions — the whole point of throwing here is to stop that overwrite
 * before it reaches GitHub. It is its own error type, not a bare `Error`, so
 * that a run of this specific failure is alertable (see
 * {@link LINKS_UNREADABLE_REASON}).
 *
 * `chQuery` is normally obtained from the `tenantChQuery` seam
 * (`pr-session-reconciler/ch-query.ts`) when the caller omits it entirely;
 * a caller that already resolved its own client (or resolved it to `null`
 * because ClickHouse is unconfigured) passes it explicitly so this module
 * never re-resolves it a second time. Tests inject a fake function instead
 * so they never need a live ClickHouse server. Two apps in one tenant can
 * point at the same repo (no unique index on
 * `git_connection (tenant_id, repository)`), so this fans out over every
 * enabled app rather than trusting one-app-per-repo.
 */
export async function readLinkedSessions(
  params: { tenantId: string; repository: string; prNumber: number },
  deps: { chQuery?: ChQueryFn | null } = {},
): Promise<LinkedSessionRow[] | null> {
  const { tenantId, repository, prNumber } = params;
  const admin = getAdminDataClient();

  const { data: connections, error: connectionsError } = await admin
    .from("git_connection")
    .select("app_id")
    .eq("tenant_id", tenantId)
    .eq("repository", repository)
    // This feature posts through the GitHub App and nothing else. New GitLab
    // connections can't be created, but the schema still permits legacy
    // `provider='gitlab'` rows, and the rest of the codebase treats them as
    // state to defend against rather than assume away.
    .eq("provider", "github")
    .eq("pr_comments_enabled", true)
    .limit(MAX_GIT_CONNECTIONS);
  if (connectionsError) {
    throw new Error(`git_connection read failed: ${connectionsError.message}`);
  }
  const appIds = [...new Set((connections ?? []).map((c) => c.app_id))];
  if (appIds.length === 0) return null;

  // `tenant_id` is redundant with `app_id IN (…)` — those ids came from a
  // tenant-scoped `git_connection` read one query above, and
  // `uc_git_connection UNIQUE (app_id, tenant_id)` means an app belongs to
  // exactly one tenant. It is sent anyway so this query is self-evidently
  // tenant-scoped in isolation, without the reader having to reconstruct that
  // argument from the query above it.
  const { data: links, error: linksError } = await admin
    .from("pull_request_session")
    .select("app_id, trace_id, session_id, method")
    .eq("tenant_id", tenantId)
    .in("app_id", appIds)
    .eq("pr_number", prNumber)
    .eq("verification", "confirmed")
    .limit(MAX_LINKS);
  if (linksError) {
    throw new Error(`pull_request_session read failed: ${linksError.message}`);
  }
  const confirmed = links ?? [];
  if (confirmed.length === 0) return [];

  // Fold, never `new Map(pairs)`: `confirmed` is fanned out over every
  // enabled app for this repo, so ONE trace can carry a row per app — a
  // `pr_link` row for one and a `branch` row for another. Building the map
  // from pairs would keep whichever came last in PostgREST's row order
  // (arbitrary), and a session that explicitly claimed the PR would render
  // `_(inferred)_`: a direct AC-057-05 miss. Same precedence rule the
  // reconciler applies — `pr_link` never downgrades to `branch`.
  const methodByTrace = new Map<string, "pr_link" | "branch">();
  const sessionIdByTrace = new Map<string, string>();
  for (const l of confirmed) {
    const method = l.method as "pr_link" | "branch";
    const winning = methodByTrace.get(l.trace_id) !== "pr_link";
    if (winning) methodByTrace.set(l.trace_id, method);
    // The session id follows the winning link row, for the same reason:
    // nothing renders it today, but two rows for one trace must not
    // disagree about which of them is authoritative.
    if (winning || !sessionIdByTrace.has(l.trace_id)) {
      sessionIdByTrace.set(l.trace_id, l.session_id);
    }
  }
  const traceIds = [...new Set(confirmed.map((l) => l.trace_id))];

  // `'chQuery' in deps` (not `??`) distinguishes "the caller passed its own
  // resolved client, even if that resolved to null" from "the caller passed
  // nothing, resolve our own" — a caller like `refreshPrSessionComment` that
  // already called `tenantChQuery` must not have this module call it AGAIN
  // and silently diverge if the two calls ever behaved differently.
  const chQuery = "chQuery" in deps ? deps.chQuery : tenantChQuery({ tenantId });
  if (!chQuery) {
    // Confirmed links are real; rendering the empty state over them would
    // overwrite a populated comment with "No agent sessions linked yet."
    // Zero confirmed links is the genuine empty state and needs no
    // ClickHouse round-trip at all — that case returns [] above, before this
    // point is ever reached.
    throw new LinksUnreadableError(confirmed.length);
  }

  const chRows: ChSessionRow[] = [];
  for (let i = 0; i < traceIds.length; i += QUERY_CHUNK) {
    const chunk = traceIds.slice(i, i + QUERY_CHUNK);
    const rows = await chQuery(
      `SELECT TraceId, Title, StartedAt, EndedAt, CostUsd, Models, ApiErrorCount, ErrorCount, AppId
FROM agent_session_summary FINAL
WHERE TenantId = {tenantId:String}
  AND TraceId IN {traceIds:Array(String)}`,
      { tenantId, traceIds: chunk },
    );
    for (const row of rows) {
      chRows.push({
        TraceId: String(row.TraceId),
        Title: String(row.Title ?? ""),
        StartedAt: String(row.StartedAt),
        EndedAt: String(row.EndedAt),
        CostUsd: Number(row.CostUsd ?? 0),
        Models: Array.isArray(row.Models) ? row.Models.map(String) : [],
        ApiErrorCount: Number(row.ApiErrorCount ?? 0),
        ErrorCount: Number(row.ErrorCount ?? 0),
        AppId: String(row.AppId),
      });
    }
  }

  const appIdsInSessions = [...new Set(chRows.map((r) => r.AppId))];
  const [appNameById, envNameByAppId] = await Promise.all([
    resolveAppNames(admin, appIdsInSessions),
    resolveDefaultEnvNames(admin, appIdsInSessions),
  ]);

  const rows: LinkedSessionRow[] = chRows
    // A row with no confirmed-link method entry would mean the ClickHouse
    // scan surfaced a TraceId we never asked for — defensive, should not
    // happen given the query is scoped to `traceIds`.
    .filter((r) => methodByTrace.has(r.TraceId))
    .map((r) => ({
      traceId: r.TraceId,
      sessionId: sessionIdByTrace.get(r.TraceId) ?? "",
      appId: r.AppId,
      appName: appNameById.get(r.AppId) ?? r.AppId,
      envName: envNameByAppId.get(r.AppId) ?? "",
      method: methodByTrace.get(r.TraceId)!,
      title: r.Title,
      startedAt: r.StartedAt,
      endedAt: r.EndedAt,
      costUsd: r.CostUsd,
      models: r.Models,
      apiErrorCount: r.ApiErrorCount,
      errorCount: r.ErrorCount,
    }));

  // OLDEST-FIRST, deliberately not the sessions list's newest-first
  // convention: a PR comment is read as the story of how the branch got
  // built ("Fix flaky auth test → Retry loop → Cleanup"), and that story
  // only reads in order. The dashboard list stays newest-first; these two
  // surfaces answer different questions.
  rows.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return rows;
}
