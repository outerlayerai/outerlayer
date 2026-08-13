import { http, HttpResponse } from 'msw';
import { buildSingleResponse, filterByEqParams, wantsSingle } from '@repo/test-msw';

const SUPABASE_URL = 'http://localhost:54321';

export type DeviceAuthRequestMswRow = {
  id: string;
  created_at?: string;
  expires_at: string;
  user_code: string;
  device_code_digest: string;
  status: string;
  tenant_id?: string | null;
  app_id?: string | null;
  environment_id?: string | null;
  approver_membership_id?: string | null;
  approved_at?: string | null;
  consumed_at?: string | null;
};

let rows: DeviceAuthRequestMswRow[] = [];
let nextId = 1;
/** Force a 500 on the matching PostgREST verb so `if (error) throw error` guards fire. */
let forceInsertError: { message: string } | null = null;
let forceUpdateError: { message: string } | null = null;

export function resetDeviceAuthMswState() {
  rows = [];
  nextId = 1;
  forceInsertError = null;
  forceUpdateError = null;
}

export function seedDeviceAuthMswState(seed: DeviceAuthRequestMswRow[]) {
  rows = seed.map((r) => ({ ...r }));
}

export function getDeviceAuthMswRows(): DeviceAuthRequestMswRow[] {
  return rows;
}

/** POST (insert) on `device_auth_request` returns a 500 until reset. */
export function forceDeviceAuthInsertError(message: string) {
  forceInsertError = { message };
}

/** PATCH (update) on `device_auth_request` returns a 500 until reset. */
export function forceDeviceAuthUpdateError(message: string) {
  forceUpdateError = { message };
}

/** `?column=gt.<value>` — string/date-compares greater-than, PostgREST style. */
function applyGtFilter(url: URL, list: DeviceAuthRequestMswRow[], column: 'expires_at') {
  const raw = url.searchParams.get(column);
  if (!raw?.startsWith('gt.')) return list;
  const threshold = new Date(raw.slice(3)).getTime();
  return list.filter((r) => new Date(r[column]).getTime() > threshold);
}

/** `?column=is.null` / `is.not.null`. */
function applyIsFilter(url: URL, list: DeviceAuthRequestMswRow[], column: 'consumed_at') {
  const raw = url.searchParams.get(column);
  if (raw === 'is.null') return list.filter((r) => r[column] == null);
  if (raw === 'not.is.null') return list.filter((r) => r[column] != null);
  return list;
}

const EQ_COLUMNS = ['id', 'user_code', 'device_code_digest', 'status', 'tenant_id', 'app_id'] as const;

function matchRows(url: URL): DeviceAuthRequestMswRow[] {
  let matched = filterByEqParams(url, rows, EQ_COLUMNS);
  matched = applyGtFilter(url, matched, 'expires_at');
  matched = applyIsFilter(url, matched, 'consumed_at');
  return matched;
}

export const deviceAuthHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/device_auth_request`, ({ request }) => {
    const url = new URL(request.url);
    const matched = matchRows(url);
    if (wantsSingle(request)) return buildSingleResponse(request, matched[0] ?? null);
    return HttpResponse.json(matched);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/device_auth_request`, async ({ request }) => {
    if (forceInsertError) {
      return HttpResponse.json({ message: forceInsertError.message }, { status: 500 });
    }
    const body = (await request.json()) as Partial<DeviceAuthRequestMswRow> | Partial<DeviceAuthRequestMswRow>[];
    const list = Array.isArray(body) ? body : [body];
    const inserted: DeviceAuthRequestMswRow[] = list.map((row) => ({
      id: `device-auth-${nextId++}`,
      created_at: new Date().toISOString(),
      status: 'pending',
      tenant_id: null,
      app_id: null,
      environment_id: null,
      approver_membership_id: null,
      approved_at: null,
      consumed_at: null,
      ...row,
    }) as DeviceAuthRequestMswRow);
    rows.push(...inserted);
    return HttpResponse.json(wantsSingle(request) ? inserted[0] : inserted, { status: 201 });
  }),

  // The atomic single-use transitions (approve, deny, consume) are all plain
  // PATCH-with-WHERE — this handler applies the SAME eq/gt/is filters a real
  // Postgres UPDATE ... WHERE ... RETURNING would, over the shared in-memory
  // `rows` array, so a concurrent-request test genuinely exercises "only rows
  // matching the precondition AT THE TIME THIS HANDLER RUNS get updated."
  http.patch(`${SUPABASE_URL}/rest/v1/device_auth_request`, async ({ request }) => {
    if (forceUpdateError) {
      return HttpResponse.json({ message: forceUpdateError.message }, { status: 500 });
    }
    const url = new URL(request.url);
    // `await` the body FIRST: everything after this line is synchronous, with
    // no yield point, so two "concurrent" callers (two fetches started via
    // Promise.all) cannot interleave their read-then-write here — exactly the
    // atomicity a real `UPDATE ... WHERE ... RETURNING` gets from Postgres
    // row locking. Reading the match set before awaiting (the original,
    // buggy version of this handler) let both callers see the row as
    // matching before either had written, so both "won."
    const body = (await request.json()) as Partial<DeviceAuthRequestMswRow>;
    const matched = matchRows(url);
    const matchedIds = new Set(matched.map((r) => r.id));
    rows = rows.map((r) => (matchedIds.has(r.id) ? { ...r, ...body } : r));
    const updated = rows.filter((r) => matchedIds.has(r.id));
    if (wantsSingle(request)) return buildSingleResponse(request, updated[0] ?? null);
    return HttpResponse.json(updated);
  }),
];
