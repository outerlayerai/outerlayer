/**
 * MSW handler for the `pr_session_comment` identity table — the orchestrator
 * (`pr-session-comment/refresh.ts`) reads it to find the stored comment id
 * and last-posted body hash, CLAIMS it before posting a first comment, and
 * upserts it on `(tenant_id, repository, pr_number)` after every successful
 * GitHub post/edit.
 *
 * Fidelity that matters here, because the create-claim's correctness rests
 * on it and a lenient fake would report a passing test for a racy
 * implementation:
 *   - `Prefer: resolution=ignore-duplicates` must NOT write, and must return
 *     an empty array. That empty array is precisely how the orchestrator
 *     learns it lost the claim; a fake that merged and returned the row
 *     would hand every concurrent caller the right to post.
 *   - `resolution=merge-duplicates` merges only the keys actually sent, the
 *     way `ON CONFLICT DO UPDATE SET <listed columns>` does. Blanking
 *     unsent columns would silently clear a stored `github_comment_id`.
 *   - PATCH honours its `eq`/`is` filters, so the claim takeover's
 *     compare-and-set (`claimed_at` unchanged — or still NULL — and
 *     `github_comment_id IS NULL`) can actually fail to match.
 *   - `updated_at` is stamped on UPDATE, mirroring the BEFORE UPDATE trigger
 *     in `99-triggers.sql`.
 */

import { http, HttpResponse } from "msw";
import { buildSingleResponse, getEqParam, wantsSingle } from "@repo/test-msw";

const SUPABASE_URL = "http://localhost:54321";

export type PrSessionCommentMswRow = {
  id?: string;
  tenant_id: string;
  repository: string;
  pr_number: number;
  github_comment_id: number | null;
  last_body_hash: string;
  last_posted_at: string | null;
  updated_at?: string;
  /** Claim liveness — see `76-pr-session-comment.sql`. Absent in a seed means
   * "no create in flight", which is what a row written by the cron backlog
   * marker looks like. */
  claimed_at?: string | null;
  needs_refresh?: boolean;
};

type State = { rows: PrSessionCommentMswRow[]; nextId: number };
let state: State = { rows: [], nextId: 1 };

/** Remaining count of merge-duplicates upserts (the post-write identity
 * persist, never the ignore-duplicates create claim) to answer with a
 * PostgREST error instead of writing — see {@link seedPrSessionCommentUpsertErrors}. */
let remainingUpsertErrors = 0;

/** One-shot error for the next bulk backlog read (`needs_refresh=eq.true`)
 * — see {@link seedPrSessionCommentReadError}. Does not affect the
 * point-lookup GET (`tenant_id`/`repository`/`pr_number`), which every other
 * caller uses. */
let pendingBacklogReadError: { message: string } | null = null;

export function resetPrSessionCommentMswState() {
  state = { rows: [], nextId: 1 };
  remainingUpsertErrors = 0;
  pendingBacklogReadError = null;
}

/**
 * Makes the next bulk backlog read (`readCommentRefreshBacklog`'s
 * `needs_refresh=eq.true` query) fail with a PostgREST error, so a test can
 * drive its best-effort degrade-to-`[]` path without a live database.
 * One-shot: cleared after it fires once.
 */
export function seedPrSessionCommentReadError(error: { message: string } | null) {
  pendingBacklogReadError = error;
}

/**
 * Makes the next `count` post-write identity persists (`resolution=merge-duplicates`)
 * fail with a PostgREST error, so a test can drive `persistCommentId`'s retry
 * behavior without a live database. Does not affect the create claim
 * (`resolution=ignore-duplicates`), which is a different write with its own
 * arbitration semantics.
 */
export function seedPrSessionCommentUpsertErrors(count: number) {
  remainingUpsertErrors = count;
}

export function seedPrSessionCommentMswState(rows: PrSessionCommentMswRow[]) {
  state = {
    rows: rows.map((r, i) => ({
      id: r.id ?? `prc-${i + 1}`,
      updated_at: r.updated_at ?? "2026-07-01T00:00:00.000Z",
      // PostgREST returns NULL, never `undefined`, for a selected column with
      // no value — a seed that leaves these out must look to the code under
      // test exactly like a real row does.
      claimed_at: r.claimed_at ?? null,
      needs_refresh: r.needs_refresh ?? false,
      ...r,
    })),
    nextId: rows.length + 1,
  };
}

/** Every upserted row, post-write, in current (post-merge) order. */
export function getPrSessionCommentRows(): readonly PrSessionCommentMswRow[] {
  return [...state.rows];
}

function findRow(tenantId: string | null, repository: string | null, prNumber: string | null) {
  return state.rows.find(
    (r) =>
      (!tenantId || r.tenant_id === tenantId) &&
      (!repository || r.repository === repository) &&
      (!prNumber || String(r.pr_number) === prNumber),
  );
}

/** `?column=is.null` — the only `is` filter this table's writers use. */
function matchesIsNull(url: URL, row: PrSessionCommentMswRow, column: keyof PrSessionCommentMswRow) {
  const raw = url.searchParams.get(column);
  if (raw !== "is.null") return true;
  return row[column] === null || row[column] === undefined;
}

export const prSessionCommentHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/pr_session_comment`, ({ request }) => {
    const url = new URL(request.url);
    const needsRefresh = getEqParam(url, "needs_refresh");

    // The backlog read (`readCommentRefreshBacklog`) is a bulk scan across
    // every tenant — no tenant_id/repository/pr_number filter at all — so it
    // is handled separately from the point lookup every other caller sends.
    if (needsRefresh !== null) {
      if (pendingBacklogReadError) {
        const error = pendingBacklogReadError;
        pendingBacklogReadError = null;
        return HttpResponse.json({ message: error.message }, { status: 500 });
      }
      let rows = state.rows.filter((r) => String(r.needs_refresh) === needsRefresh);
      const order = url.searchParams.get("order");
      if (order?.startsWith("updated_at")) {
        rows = [...rows].sort((a, b) =>
          (a.updated_at ?? "") < (b.updated_at ?? "") ? -1 : (a.updated_at ?? "") > (b.updated_at ?? "") ? 1 : 0,
        );
        if (order.includes("desc")) rows.reverse();
      }
      const limit = url.searchParams.get("limit");
      if (limit !== null) rows = rows.slice(0, Number(limit));
      return HttpResponse.json(rows);
    }

    const tenantId = getEqParam(url, "tenant_id");
    const repository = getEqParam(url, "repository");
    const prNumber = getEqParam(url, "pr_number");
    const row = findRow(tenantId, repository, prNumber) ?? null;

    if (wantsSingle(request)) {
      return buildSingleResponse(request, row);
    }
    return HttpResponse.json(row ? [row] : []);
  }),

  // Upsert: POST with Prefer: resolution=merge-duplicates (the post-write
  // persist) or resolution=ignore-duplicates (the create claim),
  // on_conflict=tenant_id,repository,pr_number.
  http.post(`${SUPABASE_URL}/rest/v1/pr_session_comment`, async ({ request }) => {
    const rawBody = (await request.json()) as
      | Partial<PrSessionCommentMswRow>
      | Partial<PrSessionCommentMswRow>[];
    // `markCommentRefreshNeeded` sends an array (a batch of flagged targets);
    // every other writer sends one object. Normalizing to an array lets both
    // go through the same per-row upsert logic below.
    const bodies = Array.isArray(rawBody) ? rawBody : [rawBody];
    const prefer = request.headers.get("prefer") ?? "";
    const ignoreDuplicates = prefer.includes("ignore-duplicates");

    const key = (r: Partial<PrSessionCommentMswRow>) =>
      `${r.tenant_id}:${r.repository}:${r.pr_number}`;
    const results: PrSessionCommentMswRow[] = [];

    for (const body of bodies) {
      const idx = state.rows.findIndex((r) => key(r) === key(body));

      if (idx >= 0) {
        if (ignoreDuplicates) {
          // Conflict, and the caller asked for the insert to be skipped: no
          // write for this row. This is the losing side of the claim.
          continue;
        }
        if (remainingUpsertErrors > 0) {
          remainingUpsertErrors -= 1;
          return HttpResponse.json({ message: "boom" }, { status: 500 });
        }
        // ON CONFLICT DO UPDATE SET <only the columns sent>.
        const merged: PrSessionCommentMswRow = {
          ...state.rows[idx]!,
          ...body,
          updated_at: new Date().toISOString(),
        };
        state.rows[idx] = merged;
        results.push(merged);
        continue;
      }

      const inserted: PrSessionCommentMswRow = {
        id: body.id ?? `prc-${state.nextId++}`,
        tenant_id: body.tenant_id ?? "",
        repository: body.repository ?? "",
        pr_number: body.pr_number ?? 0,
        github_comment_id: body.github_comment_id ?? null,
        last_body_hash: body.last_body_hash ?? "",
        last_posted_at: body.last_posted_at ?? null,
        claimed_at: body.claimed_at ?? null,
        needs_refresh: body.needs_refresh ?? false,
        updated_at: body.updated_at ?? new Date().toISOString(),
      };
      state.rows.push(inserted);
      results.push(inserted);
    }

    return HttpResponse.json(results, { status: 201 });
  }),

  // PATCH: the claim takeover's compare-and-set and the verified-at re-stamp.
  http.patch(`${SUPABASE_URL}/rest/v1/pr_session_comment`, async ({ request }) => {
    const url = new URL(request.url);
    const body = (await request.json()) as Partial<PrSessionCommentMswRow>;
    // `clearCommentRefreshBacklog` sends `id=in.(a,b,c)`; the claim
    // takeover and re-post paths send a single `id=eq.<id>`.
    const idRaw = url.searchParams.get("id");
    const idIn =
      idRaw?.startsWith("in.(") && idRaw.endsWith(")")
        ? idRaw.slice(4, -1).split(",").map((v) => v.trim().replace(/^"|"$/g, ""))
        : null;
    const id = idIn ? null : getEqParam(url, "id");
    const tenantId = getEqParam(url, "tenant_id");
    const repository = getEqParam(url, "repository");
    const prNumber = getEqParam(url, "pr_number");
    // `github_comment_id` arrives either as `eq.<id>` (the re-post claim) or
    // as `is.null` (the takeover), so it can't go through `getEqParam`,
    // which passes a non-`eq.` value through unchanged.
    const commentIdRaw = url.searchParams.get("github_comment_id");
    const commentId = commentIdRaw?.startsWith("eq.") ? commentIdRaw.slice(3) : null;
    const updatedAt = getEqParam(url, "updated_at");
    // `claimed_at` arrives as `eq.<ts>` (taking over a live-but-expired
    // claim) or as `is.null` (taking over a row that was never claimed — the
    // cron backlog marker), so it needs the same two-shape handling
    // `github_comment_id` gets.
    const claimedAtRaw = url.searchParams.get("claimed_at");
    const claimedAt = claimedAtRaw?.startsWith("eq.")
      ? decodeURIComponent(claimedAtRaw.slice(3))
      : null;

    const updated: PrSessionCommentMswRow[] = [];
    state.rows = state.rows.map((row) => {
      const matches =
        (idIn ? idIn.includes(row.id ?? "") : !id || row.id === id) &&
        (!tenantId || row.tenant_id === tenantId) &&
        (!repository || row.repository === repository) &&
        (!prNumber || String(row.pr_number) === prNumber) &&
        (commentId === null || String(row.github_comment_id) === commentId) &&
        (updatedAt === null || row.updated_at === updatedAt) &&
        (claimedAt === null || (row.claimed_at ?? null) === claimedAt) &&
        matchesIsNull(url, row, "github_comment_id") &&
        matchesIsNull(url, row, "claimed_at");
      if (!matches) return row;
      const next = { ...row, ...body, updated_at: new Date().toISOString() };
      updated.push(next);
      return next;
    });

    return HttpResponse.json(updated);
  }),
];
