/**
 * MSW handlers for the `membership` / `tenant` tables and the membership
 * transaction RPCs.
 *
 * MembershipService mutations run through SECURITY DEFINER transaction
 * functions (invite_existing_user_transaction, invite_new_user_transaction,
 * change_member_role_transaction, remove_member_transaction) so the mutation
 * and its audit row are atomic (03-functions-transactions.sql). These handlers
 * capture the RPC payloads for assertions and serve the read-side queries the
 * service performs around them.
 */

import { http, HttpResponse } from 'msw';

const SUPABASE_URL = 'http://localhost:54321';

export type MembershipMswRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  role: string;
  status: string;
  custom_role_id?: string | null;
  /** Whether the member is restricted to explicit per-app roles. */
  is_app_scoped?: boolean;
};

/** A per-app role assignment row (`app_member_role`). */
export type AppMemberRoleMswRow = {
  id: string;
  membership_id: string;
  app_id: string;
  tenant_id: string;
  role: string | null;
  custom_role_id?: string | null;
  created_at?: string;
  updated_at?: string | null;
};

/** A minimal `custom_role` row — enough for the tenant-verify check the
 *  invite flow's custom-role attach step runs before assigning a role. */
type CustomRoleMswRow = {
  id: string;
  tenant_id: string;
};

type TenantMswRow = {
  tenant_id: string;
  company_name?: string;
  organization_name?: string;
  /** Capture-tier ceiling ('metrics' | 'redacted' | 'full'); read by the
   *  session-persist tier clamp and the Topics steering-tab gate. Kept as a
   *  loose string so tests can seed out-of-range values. */
  agent_capture_tier?: string;
};

type RpcCall = { fn: string; params: Record<string, unknown> };

type MembershipMswState = {
  memberships: MembershipMswRow[];
  tenants: TenantMswRow[];
  appMemberRoles: AppMemberRoleMswRow[];
  customRoles: CustomRoleMswRow[];
  /** Value returned per RPC function name (e.g. a membership id). */
  rpcResults: Record<string, unknown>;
  /** Force a named RPC to fail with this message. */
  forceRpcError?: { fn: string; message: string };
  /** Force the `app_member_role` read to fail with this message. */
  forceAppMemberRoleError?: string;
  /** Force the `membership` PATCH (custom-role attach) to fail with this message. */
  forceMembershipUpdateError?: string;
  /** Force the `tenant` PATCH (org-settings rename) to match zero rows —
   *  simulates an RLS-denied write, which PostgREST answers the same way as
   *  an update to a nonexistent row. */
  forceTenantUpdateNoMatch?: boolean;
};

const defaultState = (): MembershipMswState => ({
  memberships: [],
  tenants: [],
  appMemberRoles: [],
  customRoles: [],
  rpcResults: {},
});

let state = defaultState();
let rpcCalls: RpcCall[] = [];

export function resetMembershipMswState() {
  state = defaultState();
  rpcCalls = [];
}

export function seedMembershipMswState(nextState: Partial<MembershipMswState>) {
  state = {
    ...state,
    ...nextState,
    memberships: nextState.memberships ?? state.memberships,
    tenants: nextState.tenants ?? state.tenants,
    appMemberRoles: nextState.appMemberRoles ?? state.appMemberRoles,
    customRoles: nextState.customRoles ?? state.customRoles,
    rpcResults: nextState.rpcResults ?? state.rpcResults,
  };
}

/** Every membership transaction RPC call, in order, for assertions. */
export function getMembershipRpcCalls(): readonly RpcCall[] {
  return [...rpcCalls];
}

function eqParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  return value?.startsWith('eq.') ? value.slice(3) : null;
}

function inParam(url: URL, key: string): string[] | null {
  const value = url.searchParams.get(key);
  if (!value?.startsWith('in.')) return null;
  return value
    .slice(3)
    .replace(/^\(/, '')
    .replace(/\)$/, '')
    .split(',')
    .map((v) => v.replace(/^"/, '').replace(/"$/, ''));
}

function wantsSingle(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/vnd.pgrst.object+json');
}

const MEMBERSHIP_RPCS = [
  'invite_existing_user_transaction',
  'invite_new_user_transaction',
  'change_member_role_transaction',
  'remove_member_transaction',
];

/** Whether `select` embeds the `tenant` resource — `tenant(...)` / `tenant!inner(...)`. */
function wantsTenantEmbed(url: URL): boolean {
  return /(^|,)tenant(!|\()/.test(url.searchParams.get('select') ?? '');
}

/**
 * Parse an `organization_name` filter (bare column or `tenant.`-embedded)
 * into a matcher. Supports `eq.<slug>` (exact) and `ilike.<pattern>`
 * (case-insensitive literal — the org resolvers escape LIKE metacharacters,
 * so unescape and compare lowercased).
 */
function orgNameMatcher(
  url: URL,
  param = 'tenant.organization_name',
): ((orgName: string | undefined) => boolean) | null {
  const raw = url.searchParams.get(param);
  if (!raw) return null;
  if (raw.startsWith('eq.')) {
    const want = raw.slice(3);
    return (orgName) => orgName === want;
  }
  if (raw.startsWith('ilike.')) {
    const want = raw.slice(6).replace(/\\([\\%_])/g, '$1').toLowerCase();
    return (orgName) => (orgName ?? '').toLowerCase() === want;
  }
  return null;
}

export const membershipHandlers = [
  http.get(`${SUPABASE_URL}/rest/v1/membership`, ({ request }) => {
    const url = new URL(request.url);
    // Embedded-tenant filter (`tenant.organization_name=eq|ilike.<slug>`): resolve
    // the membership's tenant against seeded tenants and match its org slug,
    // exactly as an `!inner` embed narrows the parent rows in PostgREST.
    const matchesOrgName = orgNameMatcher(url);
    const tenantOf = (tenantId: string) =>
      state.tenants.find((t) => t.tenant_id === tenantId);

    const rows = state.memberships.filter((row) => {
      const idIn = inParam(url, 'id');
      if (idIn !== null && !idIn.includes(row.id)) return false;
      const idEq = eqParam(url, 'id');
      if (idEq !== null && row.id !== idEq) return false;
      const userId = eqParam(url, 'user_id');
      if (userId !== null && row.user_id !== userId) return false;
      const tenantId = eqParam(url, 'tenant_id');
      if (tenantId !== null && row.tenant_id !== tenantId) return false;
      const role = eqParam(url, 'role');
      if (role !== null && row.role !== role) return false;
      const statusIn = inParam(url, 'status');
      if (statusIn !== null && !statusIn.includes(row.status)) return false;
      const statusEq = eqParam(url, 'status');
      if (statusEq !== null && row.status !== statusEq) return false;
      const roleNeq = url.searchParams.get('role');
      if (roleNeq?.startsWith('neq.') && row.role === roleNeq.slice(4)) return false;
      if (matchesOrgName && !matchesOrgName(tenantOf(row.tenant_id)?.organization_name)) {
        return false;
      }
      return true;
    });

    const shape = (row: MembershipMswRow) =>
      wantsTenantEmbed(url)
        ? { ...row, tenant: { organization_name: tenantOf(row.tenant_id)?.organization_name ?? null } }
        : row;

    // `.select('*', { count: 'exact', head: true })` — count-only queries
    if ((request.headers.get('prefer') ?? '').includes('count=exact')) {
      return new HttpResponse(null, {
        status: 200,
        headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
      });
    }

    if (wantsSingle(request)) {
      const [row] = rows;
      if (rows.length !== 1 || !row) {
        return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
      }
      return HttpResponse.json(shape(row));
    }
    return HttpResponse.json(rows.map(shape));
  }),

  // The invite flow's custom-role attach step: verify the role belongs to the
  // tenant (`custom_role`), then patch `membership.custom_role_id`.
  http.get(`${SUPABASE_URL}/rest/v1/custom_role`, ({ request }) => {
    const url = new URL(request.url);
    const id = eqParam(url, 'id');
    const tenantId = eqParam(url, 'tenant_id');
    const rows = state.customRoles.filter(
      (r) => (id === null || r.id === id) && (tenantId === null || r.tenant_id === tenantId),
    );
    if (wantsSingle(request)) {
      if (rows.length !== 1) {
        return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
      }
      return HttpResponse.json(rows[0]);
    }
    return HttpResponse.json(rows);
  }),

  http.patch(`${SUPABASE_URL}/rest/v1/membership`, async ({ request }) => {
    if (state.forceMembershipUpdateError) {
      return HttpResponse.json({ message: state.forceMembershipUpdateError }, { status: 500 });
    }
    const url = new URL(request.url);
    const id = eqParam(url, 'id');
    const tenantId = eqParam(url, 'tenant_id');
    // The invite-confirm activation step (auth/confirm/route.ts) filters by
    // user_id + status instead of id, so both must be honoured here — a
    // status=pending filter that's ignored would "activate" an
    // already-active membership and mask the pending-only invariant.
    const userId = eqParam(url, 'user_id');
    const status = eqParam(url, 'status');
    const body = (await request.json()) as Partial<MembershipMswRow>;
    const rows = state.memberships.filter(
      (m) =>
        (id === null || m.id === id) &&
        (tenantId === null || m.tenant_id === tenantId) &&
        (userId === null || m.user_id === userId) &&
        (status === null || m.status === status),
    );
    if (wantsSingle(request)) {
      if (rows.length !== 1) {
        return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
      }
      Object.assign(rows[0]!, body);
      return HttpResponse.json(rows[0]);
    }
    // A non-`.single()` PATCH matching zero rows is a normal empty-array
    // success in PostgREST, not an error — a caller that treats "no pending
    // membership" as a failure would incorrectly log/short-circuit here.
    rows.forEach((row) => Object.assign(row, body));
    return HttpResponse.json(rows);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/app_member_role`, ({ request }) => {
    if (state.forceAppMemberRoleError) {
      return HttpResponse.json({ message: state.forceAppMemberRoleError }, { status: 500 });
    }
    const url = new URL(request.url);
    const membershipId = eqParam(url, 'membership_id');
    const tenantId = eqParam(url, 'tenant_id');
    const appId = eqParam(url, 'app_id');
    const rows = state.appMemberRoles.filter((r) => {
      if (membershipId !== null && r.membership_id !== membershipId) return false;
      if (tenantId !== null && r.tenant_id !== tenantId) return false;
      if (appId !== null && r.app_id !== appId) return false;
      return true;
    });

    // Honour a single-column `order=<col>.<asc|desc>` the way PostgREST does, so
    // a caller relying on the ordering (e.g. the app-role seed reads newest-first)
    // is actually exercised. Default order is the seeded order.
    const order = url.searchParams.get('order');
    const [col, dir] = (order ?? '').split('.');
    if (col) {
      const factor = dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const av = String((a as Record<string, unknown>)[col] ?? '');
        const bv = String((b as Record<string, unknown>)[col] ?? '');
        return av < bv ? -factor : av > bv ? factor : 0;
      });
    }

    return HttpResponse.json(rows);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/tenant`, ({ request }) => {
    const url = new URL(request.url);
    const tenantId = eqParam(url, 'tenant_id');
    const matchesOrgName = orgNameMatcher(url, 'organization_name');
    const rows = state.tenants.filter(
      (t) =>
        (tenantId ? t.tenant_id === tenantId : true) &&
        (matchesOrgName ? matchesOrgName(t.organization_name) : true),
    );
    if (wantsSingle(request)) {
      if (rows.length !== 1) {
        return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
      }
      return HttpResponse.json(rows[0]);
    }
    return HttpResponse.json(rows);
  }),

  /**
   * `tenant` PATCH — org-settings rename (OrgSettingsService.updateCompanyName).
   * `forceTenantUpdateNoMatch` simulates an RLS-denied write: PostgREST
   * matches zero rows and `.single()` errors PGRST116, same as any other
   * update to a row the caller's policy can't see.
   */
  http.patch(`${SUPABASE_URL}/rest/v1/tenant`, async ({ request }) => {
    const url = new URL(request.url);
    const tenantId = eqParam(url, 'tenant_id');
    const patch = (await request.json()) as Partial<TenantMswRow>;
    const matches = !state.forceTenantUpdateNoMatch && tenantId !== null;
    if (!matches) {
      return HttpResponse.json({ message: 'no rows', code: 'PGRST116' }, { status: 406 });
    }
    state.tenants = state.tenants.map((t) =>
      t.tenant_id === tenantId ? { ...t, ...patch } : t,
    );
    const updated = state.tenants.find((t) => t.tenant_id === tenantId) ?? null;
    if (wantsSingle(request)) {
      return HttpResponse.json(updated);
    }
    return HttpResponse.json(updated ? [updated] : []);
  }),

  ...MEMBERSHIP_RPCS.map((fn) =>
    http.post(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, async ({ request }) => {
      const params = (await request.json()) as Record<string, unknown>;
      rpcCalls.push({ fn, params });
      if (state.forceRpcError?.fn === fn) {
        return HttpResponse.json({ message: state.forceRpcError.message }, { status: 500 });
      }
      return HttpResponse.json(state.rpcResults[fn] ?? null);
    }),
  ),
];
