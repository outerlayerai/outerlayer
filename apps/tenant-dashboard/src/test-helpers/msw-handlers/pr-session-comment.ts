/**
 * MSW handler for the `pr_session_comment` identity table — the orchestrator
 * (`pr-session-comment/refresh.ts`) reads it to find the stored comment id
 * and last-posted body hash, then upserts it on `(tenant_id, repository,
 * pr_number)` after every successful GitHub post/edit.
 */

import { http, HttpResponse } from "msw";
import { buildSingleResponse, getEqParam, wantsSingle } from "@repo/test-msw";

const SUPABASE_URL = "http://localhost:54321";

export type PrSessionCommentMswRow = {
  tenant_id: string;
  repository: string;
  pr_number: number;
  github_comment_id: number | null;
  last_body_hash: string;
  last_posted_at: string | null;
};

type State = { rows: PrSessionCommentMswRow[] };
let state: State = { rows: [] };

export function resetPrSessionCommentMswState() {
  state = { rows: [] };
}

export function seedPrSessionCommentMswState(rows: PrSessionCommentMswRow[]) {
  state = { rows };
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

  // Upsert: POST with Prefer: resolution=merge-duplicates,
  // on_conflict=tenant_id,repository,pr_number.
  http.post(`${SUPABASE_URL}/rest/v1/pr_session_comment`, async ({ request }) => {
    const body = (await request.json()) as Partial<PrSessionCommentMswRow>;
    const key = (r: Partial<PrSessionCommentMswRow>) => `${r.tenant_id}:${r.repository}:${r.pr_number}`;
    const idx = state.rows.findIndex((r) => key(r) === key(body));
    const merged: PrSessionCommentMswRow = {
      tenant_id: body.tenant_id ?? "",
      repository: body.repository ?? "",
      pr_number: body.pr_number ?? 0,
      github_comment_id: body.github_comment_id ?? null,
      last_body_hash: body.last_body_hash ?? "",
      last_posted_at: body.last_posted_at ?? null,
    };
    if (idx >= 0) {
      state.rows[idx] = { ...state.rows[idx]!, ...merged };
    } else {
      state.rows.push(merged);
    }
    return HttpResponse.json([merged], { status: 201 });
  }),
];
