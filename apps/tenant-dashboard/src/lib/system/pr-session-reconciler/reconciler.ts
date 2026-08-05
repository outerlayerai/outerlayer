import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Two-sided PR ↔ session reconciliation.
 *
 * Sessions (ClickHouse `agent_session_summary`) and pull requests (Postgres
 * `pull_request`, webhook-fed) arrive in ARBITRARY order: webhooks land
 * immediately, local sessions sync minutes-to-days later. One-directional
 * wiring therefore always leaks links. The reconciler materializes the M:N
 * mapping into `pull_request_session` from BOTH triggers:
 *
 *  - `reconcilePullRequest` — a PR event arrived: find every session that
 *    explicitly linked this number (`pr_link`) or ran on its head branch
 *    inside the PR's activity window (`branch`).
 *  - `reconcileRecentSessions` — the sweep: recently-ingested sessions are
 *    matched against known PRs; session-claimed links with no provider
 *    record yet stay `pending`, and pending links older than the grace
 *    window become `unmatched` (ghost links: rewritten history, wrong repo,
 *    or webhooks not connected).
 *
 * `verification` is the cross-source accuracy check: a link is `confirmed`
 * only when the transcript-side claim meets a provider-fed `pull_request`
 * row. Method precedence: an explicit `pr_link` never downgrades to
 * `branch`.
 */

const PULL_REQUEST_SESSION_TABLE = "pull_request_session";

/** Branch-tier guard: a session links a PR by branch only when its activity
 * window overlaps [opened_at − lookback, decided_at ?? now]. Branch names
 * get recycled; an unbounded match resurrects dead links. */
export const BRANCH_LINK_LOOKBACK_DAYS = 14;

/** A `pending` link with no provider record after this long is `unmatched`. */
const PENDING_GRACE_DAYS = 14;

/** Bounded scans — reconciliation is incremental, never a full-table walk. */
const MAX_SESSIONS_PER_PR = 1_000;
const MAX_SWEEP_SESSIONS = 20_000;

/** The union of the `PrNumbers` array (every `pr-link`) and the legacy scalar
 * `PrNumber` — rows written before the array column existed carry only the
 * scalar, and the union keeps them reconciling without a backfill. */
const SESSION_PRS_EXPR =
  "arrayDistinct(arrayConcat(if(PrNumber > 0, [PrNumber], emptyArrayUInt32()), PrNumbers))";

/** Minimal ClickHouse seam: one parameterized query returning JSON rows.
 * Injected so tests exercise the reconciler without a ClickHouse server. */
export type ChQueryFn = (
  sql: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

interface LinkUpsert {
  tenant_id: string;
  app_id: string;
  pr_number: number;
  trace_id: string;
  session_id: string;
  method: "pr_link" | "branch";
  verification: "pending" | "confirmed" | "unmatched";
  git_branch: string;
  last_reconciled_at: string;
}

export interface ReconcileCounts {
  candidates: number;
  linked: number;
  confirmed: number;
  pending: number;
  unmatched: number;
}

const zeroCounts = (): ReconcileCounts => ({
  candidates: 0,
  linked: 0,
  confirmed: 0,
  pending: 0,
  unmatched: 0,
});

/** ClickHouse DateTime64(3) literal ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
function chDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** Upsert links, never letting an explicit `pr_link` downgrade to `branch`
 * and never regressing `confirmed` to `pending`. Existing rows win ties. */
async function upsertLinks(
  supabase: SupabaseClient,
  appId: string,
  rows: LinkUpsert[],
): Promise<void> {
  if (rows.length === 0) return;
  const keys = rows.map((r) => `${r.pr_number}:${r.trace_id}`);
  const { data: existing } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select("pr_number, trace_id, method, verification")
    .eq("app_id", appId)
    .in("pr_number", [...new Set(rows.map((r) => r.pr_number))]);
  const current = new Map(
    (existing ?? []).map((e) => [`${e.pr_number}:${e.trace_id}`, e as { method: string; verification: string }]),
  );
  const merged = rows.map((row, i) => {
    const prior = current.get(keys[i]!);
    if (!prior) return row;
    return {
      ...row,
      method: prior.method === "pr_link" ? "pr_link" : row.method,
      verification:
        prior.verification === "confirmed" && row.verification === "pending"
          ? "confirmed"
          : row.verification,
    } as LinkUpsert;
  });
  const { error } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .upsert(merged, { onConflict: "app_id,pr_number,trace_id" });
  if (error) throw new Error(`pull_request_session upsert failed: ${error.message}`);
}

interface ReconcilePullRequestInput {
  tenantId: string;
  appId: string;
  prNumber: number;
  headBranch: string;
  /** Host-qualified repo join key (`github.com/owner/repo`) — the
   * `agent_session_summary.GitRepo` scope. */
  repo: string;
  openedAt?: string | null;
  /** merged_at ?? closed_at; open PRs pass null and the window ends now. */
  decidedAt?: string | null;
  now?: Date;
}

/**
 * PR-side reconciliation: a `pull_request` row exists (this runs from its
 * webhook), so every link found here is immediately `confirmed`.
 */
export async function reconcilePullRequest(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: ReconcilePullRequestInput,
): Promise<ReconcileCounts> {
  const counts = zeroCounts();
  const now = input.now ?? new Date();
  const windowEnd = input.decidedAt ? new Date(input.decidedAt) : now;
  const openedAt = input.openedAt ? new Date(input.openedAt) : now;
  const windowStart = new Date(openedAt.getTime() - BRANCH_LINK_LOOKBACK_DAYS * 86_400_000);

  const sessions = await chQuery(
    `WITH ${SESSION_PRS_EXPR} AS sessionPrs
SELECT
  TraceId,
  SessionId,
  GitBranch,
  has(sessionPrs, {pr:UInt32}) AS explicit
FROM agent_session_summary FINAL
WHERE TenantId = {tenantId:String}
  AND AppId = {appId:String}
  AND GitRepo = {repo:String}
  AND (
    has(sessionPrs, {pr:UInt32})
    OR (
      {branch:String} != ''
      AND GitBranch = {branch:String}
      AND StartedAt <= {windowEnd:DateTime64(3)}
      AND EndedAt >= {windowStart:DateTime64(3)}
    )
  )
LIMIT ${MAX_SESSIONS_PER_PR}`,
    {
      tenantId: input.tenantId,
      appId: input.appId,
      repo: input.repo,
      pr: input.prNumber,
      branch: input.headBranch,
      windowStart: chDateTime(windowStart),
      windowEnd: chDateTime(windowEnd),
    },
  );

  counts.candidates = sessions.length;
  const nowIso = now.toISOString();
  const rows: LinkUpsert[] = sessions.map((s) => ({
    tenant_id: input.tenantId,
    app_id: input.appId,
    pr_number: input.prNumber,
    trace_id: String(s.TraceId),
    session_id: String(s.SessionId ?? ""),
    method: Number(s.explicit) === 1 ? "pr_link" : "branch",
    verification: "confirmed",
    git_branch: String(s.GitBranch ?? ""),
    last_reconciled_at: nowIso,
  }));
  await upsertLinks(supabase, input.appId, rows);
  counts.linked = rows.length;
  counts.confirmed = rows.length;
  return counts;
}

interface SweepSessionRow {
  TenantId: string;
  AppId: string;
  TraceId: string;
  SessionId: string;
  GitBranch: string;
  StartedAt: string;
  EndedAt: string;
  sessionPrs: number[];
}

interface SweepInput {
  /** How far back (by ClickHouse ingest time) the session scan reaches. */
  sinceHours?: number;
  now?: Date;
}

/**
 * Session-side sweep: recently-INGESTED sessions (arrival time, not session
 * time — a laptop can sync a week-old session today) are matched against
 * known PRs, then pending links past the grace window are aged out.
 */
export async function reconcileRecentSessions(
  supabase: SupabaseClient,
  chQuery: ChQueryFn,
  input: SweepInput = {},
): Promise<ReconcileCounts> {
  const counts = zeroCounts();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const sinceHours = input.sinceHours ?? 24;

  const rows = (await chQuery(
    `WITH ${SESSION_PRS_EXPR} AS sessionPrs
SELECT
  TenantId,
  AppId,
  TraceId,
  SessionId,
  GitBranch,
  StartedAt,
  EndedAt,
  sessionPrs
FROM agent_session_summary FINAL
WHERE InsertedAt >= now() - INTERVAL {sinceHours:UInt32} HOUR
  AND (notEmpty(sessionPrs) OR GitBranch != '')
LIMIT ${MAX_SWEEP_SESSIONS}`,
    { sinceHours },
  )) as unknown as SweepSessionRow[];
  counts.candidates = rows.length;

  const byApp = new Map<string, SweepSessionRow[]>();
  for (const row of rows) {
    const list = byApp.get(row.AppId) ?? [];
    list.push(row);
    byApp.set(row.AppId, list);
  }

  for (const [appId, sessions] of byApp) {
    const claimedNumbers = [...new Set(sessions.flatMap((s) => s.sessionPrs.map(Number)))];
    const branches = [...new Set(sessions.map((s) => s.GitBranch).filter((b) => b !== ""))];
    type PrRow = {
      pr_number: number;
      head_branch: string;
      opened_at: string | null;
      closed_at: string | null;
      merged_at: string | null;
    };
    const prRows: PrRow[] = [];
    const seenPr = new Set<number>();
    const collect = (rows: PrRow[] | null) => {
      for (const row of rows ?? []) {
        if (seenPr.has(Number(row.pr_number))) continue;
        seenPr.add(Number(row.pr_number));
        prRows.push(row);
      }
    };
    if (claimedNumbers.length > 0) {
      const { data } = await supabase
        .from("pull_request")
        .select("pr_number, head_branch, opened_at, closed_at, merged_at")
        .eq("app_id", appId)
        .in("pr_number", claimedNumbers);
      collect(data);
    }
    if (branches.length > 0) {
      const { data } = await supabase
        .from("pull_request")
        .select("pr_number, head_branch, opened_at, closed_at, merged_at")
        .eq("app_id", appId)
        .in("head_branch", branches);
      collect(data);
    }
    const prByNumber = new Map(prRows.map((p) => [Number(p.pr_number), p]));
    const prsByBranch = new Map<string, typeof prRows>();
    for (const p of prRows) {
      const list = prsByBranch.get(p.head_branch) ?? [];
      list.push(p);
      prsByBranch.set(p.head_branch, list);
    }

    const upserts: LinkUpsert[] = [];
    for (const s of sessions) {
      // Explicit claims: confirmed when the provider row exists, else pending.
      for (const pn of s.sessionPrs.map(Number)) {
        const known = prByNumber.has(pn);
        upserts.push({
          tenant_id: s.TenantId,
          app_id: appId,
          pr_number: pn,
          trace_id: s.TraceId,
          session_id: s.SessionId,
          method: "pr_link",
          verification: known ? "confirmed" : "pending",
          git_branch: s.GitBranch,
          last_reconciled_at: nowIso,
        });
        if (known) counts.confirmed += 1;
        else counts.pending += 1;
      }
      // Branch tier: only PRs whose activity window overlaps the session's.
      const claimed = new Set(s.sessionPrs.map(Number));
      for (const p of prsByBranch.get(s.GitBranch) ?? []) {
        const pn = Number(p.pr_number);
        if (claimed.has(pn)) continue;
        const decidedAt = p.merged_at ?? p.closed_at;
        const windowEnd = decidedAt ? new Date(decidedAt) : now;
        const windowStart = new Date(
          (p.opened_at ? new Date(p.opened_at) : now).getTime() -
            BRANCH_LINK_LOOKBACK_DAYS * 86_400_000,
        );
        const started = new Date(`${s.StartedAt.replace(" ", "T")}Z`);
        const ended = new Date(`${s.EndedAt.replace(" ", "T")}Z`);
        if (started <= windowEnd && ended >= windowStart) {
          upserts.push({
            tenant_id: s.TenantId,
            app_id: appId,
            pr_number: pn,
            trace_id: s.TraceId,
            session_id: s.SessionId,
            method: "branch",
            verification: "confirmed",
            git_branch: s.GitBranch,
            last_reconciled_at: nowIso,
          });
          counts.confirmed += 1;
        }
      }
    }
    await upsertLinks(supabase, appId, upserts);
    counts.linked += upserts.length;
  }

  counts.unmatched = await agePendingLinks(supabase, now);
  return counts;
}

/**
 * pending → unmatched once the grace window passes without a provider
 * record; pending → confirmed when the record eventually arrives (late
 * webhook backfill, repo connected after the fact).
 */
async function agePendingLinks(supabase: SupabaseClient, now: Date): Promise<number> {
  const { data: pending } = await supabase
    .from(PULL_REQUEST_SESSION_TABLE)
    .select("id, app_id, pr_number, first_linked_at")
    .eq("verification", "pending")
    .limit(5_000);
  if (!pending?.length) return 0;

  const byApp = new Map<string, typeof pending>();
  for (const link of pending) {
    const list = byApp.get(link.app_id) ?? [];
    list.push(link);
    byApp.set(link.app_id, list);
  }
  let unmatched = 0;
  const graceMs = PENDING_GRACE_DAYS * 86_400_000;
  for (const [appId, links] of byApp) {
    const { data: prs } = await supabase
      .from("pull_request")
      .select("pr_number")
      .eq("app_id", appId)
      .in("pr_number", [...new Set(links.map((l) => l.pr_number))]);
    const known = new Set((prs ?? []).map((p) => Number(p.pr_number)));
    const toConfirm = links.filter((l) => known.has(Number(l.pr_number))).map((l) => l.id);
    const toUnmatch = links
      .filter(
        (l) =>
          !known.has(Number(l.pr_number)) &&
          now.getTime() - new Date(l.first_linked_at).getTime() > graceMs,
      )
      .map((l) => l.id);
    if (toConfirm.length > 0) {
      await supabase
        .from(PULL_REQUEST_SESSION_TABLE)
        .update({ verification: "confirmed", last_reconciled_at: now.toISOString() })
        .in("id", toConfirm);
    }
    if (toUnmatch.length > 0) {
      await supabase
        .from(PULL_REQUEST_SESSION_TABLE)
        .update({ verification: "unmatched", last_reconciled_at: now.toISOString() })
        .in("id", toUnmatch);
      unmatched += toUnmatch.length;
    }
  }
  return unmatched;
}
