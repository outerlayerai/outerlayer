import { http, HttpResponse } from 'msw';
import { filterByEqParams, wantsSingle } from '@repo/test-msw';
import { BUILT_IN_ROLE_PERMISSIONS } from '@repo/db-types/permissions';

const SUPABASE_URL = 'http://localhost:54321';

type RolePermissionRow = { role: string; permission: string };

/**
 * `public.role_permissions` seeded from the real built-in-role catalog by
 * default, so a test doesn't have to hand-seed grants just to exercise a
 * standard role (owner/admin/write/read) — only a demoted/custom-role case
 * needs an explicit override.
 */
function defaultRolePermissions(): RolePermissionRow[] {
  return Object.entries(BUILT_IN_ROLE_PERMISSIONS).flatMap(([role, permissions]) =>
    permissions.map((permission) => ({ role, permission })),
  );
}

type AdminApiKeyRow = {
  id: string;
  tenant_id: string;
  name: string;
  admin_api_key_id: string;
  key_prefix?: string | null;
  permissions?: string[];
  expires_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
  created_by?: string | null;
};

/** Digest → row id, mirroring `private.admin_api_key_secret`'s UNIQUE index. */
type SecretIndex = Record<string, string>;

type AdminApiKeysMswState = {
  adminApiKeys: AdminApiKeyRow[];
  secretsByDigest: SecretIndex;
  rolePermissions: RolePermissionRow[];
};

const defaultState = (): AdminApiKeysMswState => ({
  adminApiKeys: [],
  secretsByDigest: {},
  rolePermissions: defaultRolePermissions(),
});

let state = defaultState();

export function resetAdminApiKeysMswState(): void {
  state = defaultState();
}

export function seedAdminApiKeysMswState(next: Partial<AdminApiKeysMswState>): void {
  state = {
    ...state,
    ...next,
    adminApiKeys: next.adminApiKeys ?? state.adminApiKeys,
    secretsByDigest: next.secretsByDigest ?? state.secretsByDigest,
    rolePermissions: next.rolePermissions ?? state.rolePermissions,
  };
}

export const adminApiKeysHandlers = [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/verify_admin_api_key`, async ({ request }) => {
    const body = (await request.json()) as { p_key_digest?: string };
    const rowId = state.secretsByDigest[body.p_key_digest ?? ''];
    const row = state.adminApiKeys.find((k) => k.id === rowId);
    if (!row) {
      return HttpResponse.json(null);
    }
    // Mirrors `verify_admin_api_key`'s WHERE clause: revoked/expired keys
    // resolve to no digest match at all.
    if (row.revoked_at) {
      return HttpResponse.json(null);
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return HttpResponse.json(null);
    }
    return HttpResponse.json({
      adminApiKeyId: row.id,
      tenantId: row.tenant_id,
      permissions: row.permissions ?? [],
      createdBy: row.created_by ?? null,
    });
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/touch_admin_api_key_last_used`, () => {
    return HttpResponse.json(null);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/set_admin_api_key_secret`, async ({ request }) => {
    const body = (await request.json()) as {
      p_admin_api_key_id?: string;
      p_key_digest?: string;
    };
    if (body.p_admin_api_key_id && body.p_key_digest) {
      state.secretsByDigest[body.p_key_digest] = body.p_admin_api_key_id;
    }
    return HttpResponse.json(null);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/admin_api_key`, ({ request }) => {
    const url = new URL(request.url);
    let rows = filterByEqParams(url, state.adminApiKeys, ['id', 'tenant_id', 'admin_api_key_id']);

    // `.order('created_at', { ascending: false })` — the list read's newest-first sort.
    const order = url.searchParams.get('order');
    if (order === 'created_at.desc' || order === 'created_at.asc') {
      const sign = order === 'created_at.desc' ? -1 : 1;
      rows = [...rows].sort(
        (a, b) => sign * (Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '')),
      );
    }

    return HttpResponse.json(wantsSingle(request) ? (rows[0] ?? null) : rows);
  }),

  // Revocation: `.update({ revoked_at }).eq('id', id).is('revoked_at', null)`.
  // PostgREST encodes `.is()` as `?column=is.null` / `?column=is.not.null`,
  // which `filterByEqParams` doesn't cover — applied by hand here.
  http.patch(`${SUPABASE_URL}/rest/v1/admin_api_key`, async ({ request }) => {
    const url = new URL(request.url);
    const patch = (await request.json()) as Partial<AdminApiKeyRow>;
    let matched = filterByEqParams(url, state.adminApiKeys, ['id']);

    const revokedAtIs = url.searchParams.get('revoked_at');
    if (revokedAtIs === 'is.null') {
      matched = matched.filter((row) => row.revoked_at == null);
    }

    const matchedIds = new Set(matched.map((row) => row.id));
    state.adminApiKeys = state.adminApiKeys.map((row) =>
      matchedIds.has(row.id) ? { ...row, ...patch } : row,
    );

    return HttpResponse.json(wantsSingle(request) ? (matched[0] ?? null) : matched.map((row) => ({ id: row.id })));
  }),

  http.post(`${SUPABASE_URL}/rest/v1/admin_api_key`, async ({ request }) => {
    const body = await request.json();
    const rows = Array.isArray(body) ? body : [body];
    const insertedRows = rows.map((row, index) => ({
      id: `admin-api-key-${state.adminApiKeys.length + index + 1}`,
      ...(row as Omit<AdminApiKeyRow, 'id'>),
    }));
    state.adminApiKeys.push(...insertedRows);
    return HttpResponse.json(wantsSingle(request) ? insertedRows[0] : insertedRows, {
      status: 201,
    });
  }),

  http.delete(`${SUPABASE_URL}/rest/v1/admin_api_key`, ({ request }) => {
    const url = new URL(request.url);
    const matched = filterByEqParams(url, state.adminApiKeys, ['id']);
    state.adminApiKeys = state.adminApiKeys.filter((key) => !matched.includes(key));
    return HttpResponse.json(matched);
  }),

  // `loadBearerServiceContext`'s live intersection: the creator's CURRENT
  // role's grant set, read directly (the DB-side resolver lives in the
  // `private` schema and isn't reachable over PostgREST).
  http.get(`${SUPABASE_URL}/rest/v1/role_permissions`, ({ request }) => {
    const url = new URL(request.url);
    const rows = filterByEqParams(url, state.rolePermissions, ['role', 'permission']);
    return HttpResponse.json(rows);
  }),
];
