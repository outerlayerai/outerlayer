/**
 * MSW handler for the `emitted_result` table — the comment refresh
 * (`pr-session-comment/emitted-read.ts`) reads every result for a PR,
 * newest-first, and keeps the first row per name.
 *
 * Fidelity that matters here: the GET honours the `tenant_id` /
 * `repository` / `pr_number` filters plus the compound
 * `order=emitted_at.desc,id.desc` and `limit`, because latest-per-name is
 * resolved by that order — a fake returning insertion order would let a
 * regression in the order clause pick a stale result.
 */

import { http, HttpResponse } from "msw";
import { getEqParam } from "@repo/test-msw";

const SUPABASE_URL = "http://localhost:54321";

export type EmittedResultMswRow = {
  id?: string;
  tenant_id: string;
  repository: string;
  pr_number: number;
  name: string;
  result: string;
  link: string;
  provenance: string;
  emitted_at?: string;
};

type State = { rows: EmittedResultMswRow[] };
let state: State = { rows: [] };

export function resetEmittedResultMswState() {
  state = { rows: [] };
}

export function seedEmittedResultMswRows(rows: EmittedResultMswRow[]) {
  state = {
    rows: rows.map((r, i) => ({
      id: r.id ?? `emit-${i + 1}`,
      emitted_at: r.emitted_at ?? "2026-07-01T00:00:00.000Z",
      ...r,
    })),
  };
}

export const emittedResultHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/emitted_result`, ({ request }) => {
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
    if (order?.startsWith("emitted_at")) {
      rows = [...rows].sort((a, b) => {
        const byTime =
          (a.emitted_at ?? "") < (b.emitted_at ?? "")
            ? -1
            : (a.emitted_at ?? "") > (b.emitted_at ?? "")
              ? 1
              : 0;
        if (byTime !== 0) return byTime;
        return (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0;
      });
      if (order.includes("desc")) rows.reverse();
    }
    const limit = url.searchParams.get("limit");
    if (limit !== null) rows = rows.slice(0, Number(limit));

    return HttpResponse.json(rows);
  }),
];
