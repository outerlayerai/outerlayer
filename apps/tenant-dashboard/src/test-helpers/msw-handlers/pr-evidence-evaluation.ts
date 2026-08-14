/**
 * MSW handler for the `pr_evidence_evaluation` record table — the comment
 * refresh (`pr-session-comment/record.ts`) reads the latest evaluation for a
 * PR (change gate) and INSERTs a new row when the verdict or facts changed.
 *
 * Fidelity that matters here: the GET honours the `tenant_id` / `repository`
 * / `pr_number` filters plus `order=evaluated_at.desc` and `limit`, because
 * the change gate compares against the LATEST row — a fake that returned
 * rows in insertion order would let a regression in the order clause pass.
 */

import { http, HttpResponse } from "msw";
import { buildSingleResponse, getEqParam, wantsSingle } from "@repo/test-msw";

const SUPABASE_URL = "http://localhost:54321";

export type PrEvidenceEvaluationMswRow = {
  id?: string;
  tenant_id: string;
  repository: string;
  pr_number: number;
  verdict: string;
  facts: unknown;
  pending_link_count: number;
  evaluated_at?: string;
};

type State = { rows: PrEvidenceEvaluationMswRow[]; nextId: number };
let state: State = { rows: [], nextId: 1 };

export function resetPrEvidenceEvaluationMswState() {
  state = { rows: [], nextId: 1 };
}

export function seedPrEvidenceEvaluationMswState(rows: PrEvidenceEvaluationMswRow[]) {
  state = {
    rows: rows.map((r, i) => ({
      id: r.id ?? `pee-${i + 1}`,
      evaluated_at: r.evaluated_at ?? "2026-07-01T00:00:00.000Z",
      ...r,
    })),
    nextId: rows.length + 1,
  };
}

/** Every recorded evaluation, in insertion order. */
export function getPrEvidenceEvaluationRows(): readonly PrEvidenceEvaluationMswRow[] {
  return [...state.rows];
}

export const prEvidenceEvaluationHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/pr_evidence_evaluation`, ({ request }) => {
    const url = new URL(request.url);
    const tenantId = getEqParam(url, "tenant_id");
    const repository = getEqParam(url, "repository");
    const prNumber = getEqParam(url, "pr_number");

    let rows = state.rows.filter(
      (r) =>
        (!tenantId || r.tenant_id === tenantId) &&
        (!repository || r.repository === repository) &&
        (!prNumber || String(r.pr_number) === prNumber),
    );
    const order = url.searchParams.get("order");
    if (order?.startsWith("evaluated_at")) {
      rows = [...rows].sort((a, b) =>
        (a.evaluated_at ?? "") < (b.evaluated_at ?? "")
          ? -1
          : (a.evaluated_at ?? "") > (b.evaluated_at ?? "")
            ? 1
            : 0,
      );
      if (order.includes("desc")) rows.reverse();
    }
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));

    if (wantsSingle(request)) {
      return buildSingleResponse(request, rows[0] ?? null);
    }
    return HttpResponse.json(rows);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/pr_evidence_evaluation`, async ({ request }) => {
    const body = (await request.json()) as Partial<PrEvidenceEvaluationMswRow>;
    const inserted: PrEvidenceEvaluationMswRow = {
      id: body.id ?? `pee-${state.nextId++}`,
      tenant_id: body.tenant_id ?? "",
      repository: body.repository ?? "",
      pr_number: body.pr_number ?? 0,
      verdict: body.verdict ?? "",
      facts: body.facts ?? [],
      pending_link_count: body.pending_link_count ?? 0,
      evaluated_at: body.evaluated_at ?? new Date().toISOString(),
    };
    state.rows.push(inserted);
    return HttpResponse.json([inserted], { status: 201 });
  }),
];
