import "server-only";

/**
 * Admin API key mint + bearer-verify seam, mirroring `mint-api-key.ts`'s
 * split: the row write happens on the caller's RLS-scoped client
 * (`ctx.db`), the private digest write/read happens on the service-role
 * client, owned here since only `src/lib/system/` may construct it.
 *
 * Verification never compares digests in application code — `verifyBearer`
 * looks the digest up through `admin_api_key_secret`'s UNIQUE index (same
 * construction as `@repo/api-key-service`'s `mintApiKey`/gateway
 * `verify_api_key`), so there is no `===` on secret material to time.
 */

import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import { generateApiKey, hashApiKey } from "@repo/api-key-service";
import { ADMIN_API_KEY_PEPPER } from "@/config-global.server";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import { getAdminDataClient } from "./admin-client";

/** Plaintext prefix for admin API keys — distinguishes them from gateway `sk_outerlayer_` keys at a glance. */
export const ADMIN_API_KEY_PREFIX = "olk_";

interface MintAdminApiKeyParams {
  /** RLS-scoped client (ctx.db); the row INSERT runs under its policy. */
  rowClient: SupabaseClient;
  tenantId: string;
  name: string;
  permissions: string[];
  expiresAt: string | null;
  createdBy: string;
}

interface MintAdminApiKeyResult {
  /** Plaintext key — return to the caller once, then drop. */
  plaintext: string;
  row: Record<string, unknown> & { id: string; admin_api_key_id: string };
}

/**
 * Mint an admin API key: write the `public.admin_api_key` row, then its
 * private digest. On a digest-write failure the row is deleted rather than
 * left as a visible-but-unverifiable key (mirrors `mintApiKey`'s ordering).
 */
export async function mintAdminApiKeySystem(
  params: MintAdminApiKeyParams,
): Promise<MintAdminApiKeyResult> {
  // ADMIN_API_KEY_PEPPER is optional (self-host boot must not require a
  // secret for a feature the operator may never use) — so minting fails with
  // a configuration error the caller can surface directly, rather than a
  // pepper-throws-inside-hashApiKey stack trace.
  if (!ADMIN_API_KEY_PEPPER) {
    throw new Error(
      "Admin API keys are not configured on this deployment (ADMIN_API_KEY_PEPPER is unset)",
    );
  }

  const { rowClient, tenantId, name, permissions, expiresAt, createdBy } = params;

  const { plaintext, keyPrefix, apiKeyId } = generateApiKey({ prefix: ADMIN_API_KEY_PREFIX });
  const keyDigest = await hashApiKey(plaintext, ADMIN_API_KEY_PEPPER);

  const { data: row, error: insertError } = await rowClient
    .from("admin_api_key")
    .insert({
      name,
      tenant_id: tenantId,
      admin_api_key_id: apiKeyId,
      key_prefix: keyPrefix,
      permissions,
      expires_at: expiresAt,
      created_by: createdBy,
    })
    .select()
    .single();
  if (insertError) {
    throw insertError;
  }

  const adminClient = getAdminDataClient();
  const { error: rpcError } = await adminClient.rpc("set_admin_api_key_secret", {
    p_admin_api_key_id: row.id,
    p_key_digest: keyDigest,
    p_pepper_version: 1,
  });
  if (rpcError) {
    await adminClient.from("admin_api_key").delete().eq("id", row.id);
    throw rpcError;
  }

  return { plaintext, row: row as MintAdminApiKeyResult["row"] };
}

interface AdminApiKeyAuth {
  adminApiKeyId: string;
  tenantId: string;
  permissions: string[];
  /** The user who minted the key, or `null` for a legacy row written before this column existed. */
  createdBy: string | null;
}

/**
 * Resolves an `Authorization` header to the admin API key it names, or
 * `null` on anything short of a live, unrevoked, unexpired key: missing
 * header, wrong scheme, wrong prefix, or no matching digest.
 * `verify_admin_api_key`'s WHERE clause (not this function) is what enforces
 * revoked/expired — the same fail-closed shape `verify_api_key` uses.
 */
export async function verifyAdminApiKeyBearer(
  authorizationHeader: string | null,
  adminClient: SupabaseClient = getAdminDataClient(),
): Promise<AdminApiKeyAuth | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token.startsWith(ADMIN_API_KEY_PREFIX)) {
    return null;
  }

  // ADMIN_API_KEY_PEPPER is optional. Unset means the feature is disabled on
  // this deployment: every bearer token is rejected, checked BEFORE any DB
  // round-trip — there is nothing to look up when nothing could ever have
  // been minted with a real digest.
  if (!ADMIN_API_KEY_PEPPER) {
    return null;
  }

  let digest: string;
  try {
    digest = await hashApiKey(token, ADMIN_API_KEY_PEPPER);
  } catch {
    // Defense in depth — hashApiKey's own empty-pepper guard, should the
    // check above ever be bypassed. Fail closed rather than hash unpeppered.
    return null;
  }

  const { data, error } = await adminClient.rpc("verify_admin_api_key", {
    p_key_digest: digest,
  });
  if (error || !data) {
    return null;
  }

  const result = data as {
    adminApiKeyId: string;
    tenantId: string;
    permissions: string[];
    createdBy: string | null;
  };

  // Best-effort bookkeeping: a failed touch must not turn a valid key into a
  // rejected request.
  try {
    await adminClient.rpc("touch_admin_api_key_last_used", {
      p_admin_api_key_id: result.adminApiKeyId,
    });
  } catch {
    // Deliberately empty.
  }

  return {
    adminApiKeyId: result.adminApiKeyId,
    tenantId: result.tenantId,
    permissions: result.permissions ?? [],
    createdBy: result.createdBy ?? null,
  };
}

/**
 * The request-level resolution result every bearer-aware auth seam
 * (`withApi`'s `authenticateRequest`, and `requireOrgContext`-style helpers
 * for org-scoped routes) branches on:
 *
 *   - `absent`     — no `Bearer olk_…` scheme on the request at all. The
 *                    caller should try session auth next.
 *   - `invalid`    — a `Bearer olk_…` scheme was presented but the key
 *                    failed to verify (malformed/unknown/expired/revoked).
 *                    The caller MUST fail closed here, never fall through to
 *                    session auth — a bad bearer token retrying as an
 *                    anonymous session would be a silent downgrade.
 *   - `forbidden`  — a live key verified, but `requiredPermission` (when
 *                    passed) isn't in its grant set.
 *   - `ok`         — a live key verified (and holds `requiredPermission`, if
 *                    given). `context` is a `ServiceContext` built the same
 *                    shape a session resolves to, except `db` is the
 *                    service-role client (a bearer request carries no
 *                    session JWT, so there is no RLS-scoped client to hand
 *                    back) — callers that lean on RLS alone for tenant
 *                    isolation, rather than an explicit `tenant_id` filter,
 *                    are not yet safe to wire to this path.
 */
// eslint-disable-next-line import/no-unused-modules -- consumed by bearer-auth call sites outside this module (withApi's authenticateRequest today; org-scoped route auth seams next)
export type AdminApiKeyRequestAuth =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "forbidden"; permissions: string[] }
  | { status: "ok"; context: ServiceContext; permissions: string[] };

/**
 * Resolves a request's `Authorization` header to an admin-API-key
 * `ServiceContext`, or a typed reason it didn't. `requiredPermission` is
 * checked against the key's own grant set — never RLS/`authorize()`, which
 * read `auth.uid()` and have nothing to evaluate for a session-less bearer
 * caller.
 */
export async function resolveAdminApiKeyContext(
  request: Request,
  requiredPermission?: string,
  adminClient: SupabaseClient = getAdminDataClient(),
): Promise<AdminApiKeyRequestAuth> {
  const authorizationHeader = request.headers.get("authorization");
  const bearerToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length).trim()
    : null;
  if (!bearerToken?.startsWith(ADMIN_API_KEY_PREFIX)) {
    return { status: "absent" };
  }

  const auth = await verifyAdminApiKeyBearer(authorizationHeader, adminClient);
  if (!auth) {
    return { status: "invalid" };
  }

  if (requiredPermission && !auth.permissions.includes(requiredPermission)) {
    return { status: "forbidden", permissions: auth.permissions };
  }

  const context: ServiceContext = {
    db: adminClient,
    tenantId: auth.tenantId,
    actor: { userId: `admin_api_key:${auth.adminApiKeyId}`, role: "" },
  };

  return { status: "ok", context, permissions: auth.permissions };
}

/**
 * The result `loadBearerServiceContext` branches on. `401` and `403` are
 * kept apart (rather than one generic failure) because the two call sites —
 * `requireOrgContext`/`requireMembershipContext` — throw different error
 * classes for each: unauthenticated vs. authenticated-but-not-permitted.
 */
// eslint-disable-next-line import/no-unused-modules -- part of loadBearerServiceContext's public return type, for callers/tests that want to branch on it explicitly
export type BearerServiceContextResult =
  | { ok: true; ctx: ServiceContext; keyPermissions: string[] }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: 403; message: string };

/**
 * Builds a bearer-authed `ServiceContext` for org-scoped routes that resolve
 * auth manually (the `requireOrgContext` family), rather than through
 * `withApi`'s app-scoped `authenticateRequest`. Reads the `Authorization`
 * header itself via `next/headers` — these routes call in with no `Request`
 * object in hand, the same reason `getRequestTenantId()` reads headers
 * directly instead of taking one.
 *
 * Three checks, all fail-closed:
 *
 *   1. The key verifies (not malformed/unknown/expired/revoked) — 401.
 *   2. **Tenant binding**: the key's own `tenant_id` must equal the
 *      URL-resolved request tenant (`getRequestTenantId()`). A key minted
 *      for org A presented against org B's URL is a cross-tenant attempt,
 *      not a fallback to the key's own tenant — 403. No resolved request
 *      tenant at all (the URL doesn't name a live org) is the same failure.
 *   3. **Actor attribution**: the key's creator must hold an ACTIVE
 *      membership in that tenant RIGHT NOW — re-resolved every call, never
 *      cached from mint time. An admin API key acts as its creator: this is
 *      what keeps `MembershipService`'s role-based rules (owner-only owner
 *      invites, last-owner protection) and audit-log attribution meaningful
 *      for a bearer caller, and what makes a key's practical authority
 *      disappear the moment its creator leaves or is disabled, with no
 *      separate revocation step. A key with no recorded creator (there is
 *      none today, but the column is nullable) fails the same way.
 *
 * `ctx.db` is the service-role admin client — a bearer request carries no
 * session JWT, so there is no RLS-scoped client to hand back. Every query
 * reachable from the member/role routes this seam serves already runs
 * through an explicitly `tenant_id`-filtered admin path independent of
 * `ctx.db` (`listTenantMembers`, `MembershipService`'s own admin client), so
 * handing back the admin client here does not newly expose anything RLS
 * alone was protecting.
 */
export async function loadBearerServiceContext(
  adminClient: SupabaseClient = getAdminDataClient(),
): Promise<BearerServiceContextResult> {
  const requestHeaders = await headers();
  const authorizationHeader = requestHeaders.get("authorization");

  const auth = await verifyAdminApiKeyBearer(authorizationHeader, adminClient);
  if (!auth) {
    return { ok: false, status: 401, message: "Not authenticated" };
  }

  const requestTenantId = await getRequestTenantId();
  if (!requestTenantId || requestTenantId !== auth.tenantId) {
    return { ok: false, status: 403, message: "This key does not belong to this organization" };
  }

  if (!auth.createdBy) {
    return { ok: false, status: 403, message: "This key has no recorded creator" };
  }

  const { data: creatorMembership } = await adminClient
    .from("membership")
    .select("role, custom_role_id")
    .eq("user_id", auth.createdBy)
    .eq("tenant_id", auth.tenantId)
    .eq("status", "active")
    .maybeSingle();

  if (!creatorMembership) {
    return { ok: false, status: 403, message: "This key's creator is no longer an active member" };
  }

  // The org's private.get_org_permission_set resolver has one precedence
  // rule: a stored custom_role_id wins over the built-in role, in full
  // (never merged with it). That resolver runs in the `private` schema
  // (off the PostgREST surface, service_role-only) so it isn't reachable
  // over .rpc() here — mirroring it for the built-in-role branch is a
  // single explicit-filtered query, but the custom-role branch pulls in
  // the EE custom-role tables and their own tenant-safety story. Rather
  // than half-replicate that here, a custom-role creator fails closed:
  // the key holds no effective permissions until this is built properly.
  if (creatorMembership.custom_role_id) {
    return {
      ok: false,
      status: 403,
      message: "This key's creator holds a custom role, which bearer auth does not support yet",
    };
  }

  // Mint-time clamp only bounds what a key COULD ever carry; the creator's
  // CURRENT role bounds what it may use RIGHT NOW. A creator demoted after
  // minting (still active, lower role) must not keep exercising grants their
  // new role no longer holds — so the key's own permission set is
  // intersected with the creator's live role_permissions, not returned as-is.
  const { data: rolePermissionRows } = await adminClient
    .from("role_permissions")
    .select("permission")
    .eq("role", creatorMembership.role);
  const rolePermissions = new Set((rolePermissionRows ?? []).map((row) => row.permission as string));
  const effectivePermissions = auth.permissions.filter((permission) => rolePermissions.has(permission));

  const ctx: ServiceContext = {
    db: adminClient,
    tenantId: auth.tenantId,
    actor: { userId: auth.createdBy, role: creatorMembership.role as string },
  };

  return { ok: true, ctx, keyPermissions: effectivePermissions };
}
