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
 *     compare-and-set (`updated_at` unchanged, `github_comment_id IS NULL`)
 *     can actually fail to match.
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
};

type State = { rows: PrSessionCommentMswRow[]; nextId: number };
let state: State = { rows: [], nextId: 1 };

export function resetPrSessionCommentMswState() {
  state = { rows: [], nextId: 1 };
}

export function seedPrSessionCommentMswState(rows: PrSessionCommentMswRow[]) {
  state = {
    rows: rows.map((r, i) => ({
      id: r.id ?? `prc-${i + 1}`,
      updated_at: r.updated_at ?? "2026-07-01T00:00:00.000Z",
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
    const body = (await request.json()) as Partial<PrSessionCommentMswRow>;
    const prefer = request.headers.get("prefer") ?? "";
    const ignoreDuplicates = prefer.includes("ignore-duplicates");

    const key = (r: Partial<PrSessionCommentMswRow>) =>
      `${r.tenant_id}:${r.repository}:${r.pr_number}`;
    const idx = state.rows.findIndex((r) => key(r) === key(body));

    if (idx >= 0) {
      if (ignoreDuplicates) {
        // Conflict, and the caller asked for the insert to be skipped: no
        // write, and nothing returned. This is the losing side of the claim.
        return HttpResponse.json([], { status: 201 });
      }
      // ON CONFLICT DO UPDATE SET <only the columns sent>.
      const merged: PrSessionCommentMswRow = {
        ...state.rows[idx]!,
        ...body,
        updated_at: new Date().toISOString(),
      };
      state.rows[idx] = merged;
      return HttpResponse.json([merged], { status: 201 });
    }

    const inserted: PrSessionCommentMswRow = {
      id: body.id ?? `prc-${state.nextId++}`,
      tenant_id: body.tenant_id ?? "",
      repository: body.repository ?? "",
      pr_number: body.pr_number ?? 0,
      github_comment_id: body.github_comment_id ?? null,
      last_body_hash: body.last_body_hash ?? "",
      last_posted_at: body.last_posted_at ?? null,
      updated_at: body.updated_at ?? new Date().toISOString(),
    };
    state.rows.push(inserted);
    return HttpResponse.json([inserted], { status: 201 });
  }),

  // PATCH: the claim takeover's compare-and-set and the verified-at re-stamp.
  http.patch(`${SUPABASE_URL}/rest/v1/pr_session_comment`, async ({ request }) => {
    const url = new URL(request.url);
    const body = (await request.json()) as Partial<PrSessionCommentMswRow>;
    const id = getEqParam(url, "id");
    const tenantId = getEqParam(url, "tenant_id");
    const repository = getEqParam(url, "repository");
    const prNumber = getEqParam(url, "pr_number");
    // `github_comment_id` arrives either as `eq.<id>` (the re-post claim) or
    // as `is.null` (the takeover), so it can't go through `getEqParam`,
    // which passes a non-`eq.` value through unchanged.
    const commentIdRaw = url.searchParams.get("github_comment_id");
    const commentId = commentIdRaw?.startsWith("eq.") ? commentIdRaw.slice(3) : null;
    const updatedAt = getEqParam(url, "updated_at");

    const updated: PrSessionCommentMswRow[] = [];
    state.rows = state.rows.map((row) => {
      const matches =
        (!id || row.id === id) &&
        (!tenantId || row.tenant_id === tenantId) &&
        (!repository || row.repository === repository) &&
        (!prNumber || String(row.pr_number) === prNumber) &&
        (commentId === null || String(row.github_comment_id) === commentId) &&
        (updatedAt === null || row.updated_at === updatedAt) &&
        matchesIsNull(url, row, "github_comment_id");
      if (!matches) return row;
      const next = { ...row, ...body, updated_at: new Date().toISOString() };
      updated.push(next);
      return next;
    });

    return HttpResponse.json(updated);
  }),
];
