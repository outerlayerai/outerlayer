/**
 * MSW handlers for the `audit_log` table.
 *
 * The consolidated, immutable, polymorphic-actor audit trail (see
 * `supabase/schemas/32-audit-log.sql`). Written by `AuditLogService.create`
 * (src/lib/system/audit-log/) — the single write seam used by platform-admin
 * services and the tenant RBAC mutation services — and read by
 * `AuditLogViewerService`.
 *
 * Supported PostgREST surface (exactly what those two callers use):
 *  - POST /rest/v1/audit_log  (insert, fire-and-forget)
 *  - GET  /rest/v1/audit_log  (?tenant_id=eq.&actor_id=eq.&action_type=eq.
 *         &target_type=eq.&target_id=eq.&created_at=gte./lte.&order=&Range
 *         header; single object via Accept: application/vnd.pgrst.object+json;
 *         count via Prefer: count=exact -> Content-Range)
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = 'http://localhost:54321';

export type AuditLogMswRow = {
  tenant_id: string | null;
  actor_id: string | null;
  actor_type: string;
  actor_label: string | null;
  action_type: string;
  target_type: string;
  target_id: string | null;
  target_identifier: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  ip_address?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
  /** Viewer-read fields; optional on insert-captured rows. */
  id?: string;
  created_at?: string;
};

type AuditLogMswState = {
  rows: AuditLogMswRow[];
  /** Force inserts to fail with this message (exercises the swallow-error path). */
  forceInsertError?: { message: string };
};

const defaultState = (): AuditLogMswState => ({ rows: [] });

let state = defaultState();

export function resetAuditLogMswState() {
  state = defaultState();
}

export function seedAuditLogMswState(nextState: Partial<AuditLogMswState>) {
  state = { ...state, ...nextState, rows: nextState.rows ?? state.rows };
}

/** Read-only snapshot of inserted audit rows for assertions. */
export function getInsertedAuditLogRows(): readonly AuditLogMswRow[] {
  return [...state.rows];
}

function eqParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  return value?.startsWith('eq.') ? value.slice(3) : null;
}

function matchesFilters(row: AuditLogMswRow, url: URL): boolean {
  for (const key of ['id', 'tenant_id', 'actor_id', 'action_type', 'target_type', 'target_id'] as const) {
    const wanted = eqParam(url, key);
    if (wanted !== null && row[key] !== wanted) return false;
  }
  const createdAt = url.searchParams.get('created_at');
  if (createdAt) {
    const ts = Date.parse(row.created_at ?? '');
    for (const clause of url.searchParams.getAll('created_at')) {
      if (clause.startsWith('gte.') && ts < Date.parse(clause.slice(4))) return false;
      if (clause.startsWith('lte.') && ts > Date.parse(clause.slice(4))) return false;
    }
  }
  return true;
}

export const auditLogHandlers = [
  http.post(`${SUPABASE_URL}/rest/v1/audit_log`, async ({ request }) => {
    if (state.forceInsertError) {
      return HttpResponse.json(
        { message: state.forceInsertError.message },
        { status: 500 },
      );
    }
    const body = await request.json();
    const rows = (Array.isArray(body) ? body : [body]) as AuditLogMswRow[];
    state.rows.push(...rows);
    return new HttpResponse(null, { status: 201 });
  }),

  http.get(`${SUPABASE_URL}/rest/v1/audit_log`, ({ request }) => {
    const url = new URL(request.url);
    // Viewer lists read newest-first; the CSV export reads oldest-first.
    const ascending = (url.searchParams.get('order') ?? '').includes('.asc');
    const filtered = state.rows
      .filter((row) => matchesFilters(row, url))
      .sort((a, b) => {
        const diff = Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '');
        return ascending ? diff : -diff;
      });

    const single = (request.headers.get('accept') ?? '').includes('application/vnd.pgrst.object+json');
    if (single) {
      if (filtered.length !== 1) {
        return HttpResponse.json(
          { message: `JSON object requested, multiple (or no) rows returned`, code: 'PGRST116' },
          { status: 406 },
        );
      }
      return HttpResponse.json(filtered[0]);
    }

    // `.range(from, to)` arrives as a Range header or offset/limit params,
    // depending on the postgrest-js version.
    let paged = filtered;
    let from = 0;
    let to = Math.max(filtered.length - 1, 0);
    const rangeMatch = request.headers.get('range')?.match(/^(\d+)-(\d+)$/);
    const offsetParam = url.searchParams.get('offset');
    const limitParam = url.searchParams.get('limit');
    if (rangeMatch) {
      from = Number(rangeMatch[1]);
      to = Number(rangeMatch[2]);
      paged = filtered.slice(from, to + 1);
    } else if (offsetParam !== null || limitParam !== null) {
      from = Number(offsetParam ?? 0);
      const limit = limitParam === null ? filtered.length - from : Number(limitParam);
      to = from + limit - 1;
      paged = filtered.slice(from, to + 1);
    }

    const wantsCount = (request.headers.get('prefer') ?? '').includes('count=exact');
    const headers: Record<string, string> = {};
    if (wantsCount) {
      headers['content-range'] = `${from}-${Math.min(to, from + paged.length - 1)}/${filtered.length}`;
    }
    return HttpResponse.json(paged, { headers });
  }),
];
