/**
 * MSW handler for the `artifact` table: the comment refresh reads a PR's
 * anchored artifacts, and the reconciler sweep resolves pending ones
 * (confirm/unmatch) with per-row PATCHes. Filters are honoured (eq/neq/in,
 * order, limit) so a test can prove the exact scoping of those queries, and
 * every PATCH is captured for exact-payload assertions.
 */

import { http, HttpResponse } from "msw";

const SUPABASE_URL = "http://localhost:54321";

export type ArtifactMswRow = {
  id: string;
  tenant_id: string;
  app_id: string;
  client_artifact_id?: string;
  sha256?: string;
  filename: string;
  media_type?: string;
  kind: string;
  caption: string;
  criterion_id: string;
  provenance: "session" | "ci" | "local";
  session_id?: string;
  trace_id?: string;
  turn_index?: number | null;
  repository: string;
  pr_number: number | null;
  git_repo?: string;
  git_branch?: string;
  commit_sha?: string;
  verification: "pending" | "confirmed" | "unmatched";
  blob_deleted?: boolean;
  emitted_at: string;
  last_reconciled_at?: string;
  updated_at?: string;
};

type State = { rows: ArtifactMswRow[] };
let state: State = { rows: [] };

export function resetArtifactMswState() {
  state = { rows: [] };
}

export function seedArtifactMswRows(rows: ArtifactMswRow[]) {
  state.rows.push(...rows.map((row) => ({ ...row })));
}

export function getArtifactMswRows(): ArtifactMswRow[] {
  return state.rows.map((row) => ({ ...row }));
}

/** PostgREST-style filter match for the operators the production queries
 * use: `eq.`, `neq.`, `is.`, and `in.(a,b)`. Unknown params (select, order,
 * limit) are handled by the caller. Any other operator THROWS: a silently
 * matched-everything filter would let a production query change (a new
 * `gt.`/`like.` clause) pass tests while asserting nothing. */
function matchesFilters(row: ArtifactMswRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "offset") continue;
    const value = raw;
    const field = row[key as keyof ArtifactMswRow];
    if (value.startsWith("eq.")) {
      if (String(field) !== value.slice(3)) return false;
    } else if (value.startsWith("neq.")) {
      if (String(field) === value.slice(4)) return false;
    } else if (value.startsWith("is.")) {
      const want = value.slice(3);
      if (want === "null" && field !== null && field !== undefined) return false;
      if (want !== "null" && (field === null || field === undefined)) return false;
    } else if (value.startsWith("in.(")) {
      const options = value.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
      if (!options.includes(String(field))) return false;
    } else {
      throw new Error(`artifact msw handler: unsupported filter "${key}=${value}"`);
    }
  }
  return true;
}

function applyOrderAndLimit(rows: ArtifactMswRow[], params: URLSearchParams): ArtifactMswRow[] {
  let out = [...rows];
  const order = params.getAll("order");
  // PostgREST applies comma-joined order keys left-to-right; sorting by the
  // reversed list with a stable sort yields the same result.
  const keys = order
    .flatMap((o) => o.split(","))
    .map((o) => {
      const [column, dir] = o.split(".");
      return { column: column as keyof ArtifactMswRow, desc: dir === "desc" };
    })
    .reverse();
  for (const { column, desc } of keys) {
    out.sort((a, b) => {
      const av = String(a[column] ?? "");
      const bv = String(b[column] ?? "");
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }
  const limit = params.get("limit");
  if (limit) out = out.slice(0, Number(limit));
  return out;
}

export const artifactHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/artifact`, ({ request }) => {
    const params = new URL(request.url).searchParams;
    const rows = applyOrderAndLimit(
      state.rows.filter((row) => matchesFilters(row, params)),
      params,
    );
    return HttpResponse.json(rows);
  }),
  http.patch(`${SUPABASE_URL}/rest/v1/artifact`, async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const payload = (await request.json()) as Record<string, unknown>;
    const now = new Date().toISOString();
    const updated: ArtifactMswRow[] = [];
    for (const row of state.rows) {
      if (!matchesFilters(row, params)) continue;
      Object.assign(row, payload, { updated_at: now });
      updated.push({ ...row });
    }
    return HttpResponse.json(updated);
  }),
];
