/**
 * Admin API key mint + bearer-verify authority — framework-free, no `next/*`
 * import anywhere in this module. A host's request-bound wiring (reading the
 * `Authorization` header off `next/headers`, resolving the URL org segment)
 * stays in the host and is passed in as plain values.
 *
 * Verification never compares digests in application code — `verifyAdminApiKeyBearer`
 * looks the digest up through the admin key's secret table UNIQUE index (via
 * the host's `verify_admin_api_key` RPC), so there is no `===` on secret
 * material to time.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateApiKey, hashApiKey } from '@repo/api-key-service';

/** Plaintext prefix for admin API keys — distinguishes them from gateway `sk_outerlayer_` keys at a glance. */
export const ADMIN_API_KEY_PREFIX = 'olk_';

interface MintAdminApiKeyParams {
  /** RLS-scoped client (ctx.db); the row INSERT runs under its policy. */
  rowClient: SupabaseClient;
  /** Service-role client; only it may write the private digest via RPC. */
  adminClient: SupabaseClient;
  /** HMAC pepper. `undefined` means admin API keys are unconfigured on this deployment. */
  pepper: string | undefined;
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
 * left as a visible-but-unverifiable key.
 */
export async function mintAdminApiKey(params: MintAdminApiKeyParams): Promise<MintAdminApiKeyResult> {
  const { rowClient, adminClient, pepper, tenantId, name, permissions, expiresAt, createdBy } = params;

  // pepper is optional (self-host boot must not require a secret for a
  // feature the operator may never use) — so minting fails with a
  // configuration error the caller can surface directly, rather than a
  // pepper-throws-inside-hashApiKey stack trace.
  if (!pepper) {
    throw new Error(
      'Admin API keys are not configured on this deployment (ADMIN_API_KEY_PEPPER is unset)',
    );
  }

  const { plaintext, keyPrefix, apiKeyId } = generateApiKey({ prefix: ADMIN_API_KEY_PREFIX });
  const keyDigest = await hashApiKey(plaintext, pepper);

  const { data: row, error: insertError } = await rowClient
    .from('admin_api_key')
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

  const { error: rpcError } = await adminClient.rpc('set_admin_api_key_secret', {
    p_admin_api_key_id: row.id,
    p_key_digest: keyDigest,
    p_pepper_version: 1,
  });
  if (rpcError) {
    await adminClient.from('admin_api_key').delete().eq('id', row.id);
    throw rpcError;
  }

  return { plaintext, row: row as MintAdminApiKeyResult['row'] };
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
 * revoked/expired.
 */
export async function verifyAdminApiKeyBearer(
  authorizationHeader: string | null,
  adminClient: SupabaseClient,
  pepper: string | undefined,
): Promise<AdminApiKeyAuth | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token.startsWith(ADMIN_API_KEY_PREFIX)) {
    return null;
  }

  // pepper is optional. Unset means the feature is disabled on this
  // deployment: every bearer token is rejected, checked BEFORE any DB
  // round-trip — there is nothing to look up when nothing could ever have
  // been minted with a real digest.
  if (!pepper) {
    return null;
  }

  let digest: string;
  try {
    digest = await hashApiKey(token, pepper);
  } catch {
    // Defense in depth — hashApiKey's own empty-pepper guard, should the
    // check above ever be bypassed. Fail closed rather than hash unpeppered.
    return null;
  }

  const { data, error } = await adminClient.rpc('verify_admin_api_key', {
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
    await adminClient.rpc('touch_admin_api_key_last_used', {
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

/** The narrow shape a host's `ServiceContext` must satisfy — see `apps/tenant-dashboard`'s own for the full type. */
export interface AdminApiKeyServiceContext {
  db: SupabaseClient;
  tenantId: string;
  actor: { userId: string; role: string };
}

/**
 * The request-level resolution result every bearer-aware auth seam branches
 * on:
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
 *                    given). `context.db` is the service-role client (a
 *                    bearer request carries no session JWT, so there is no
 *                    RLS-scoped client to hand back).
 */
export type AdminApiKeyRequestAuth =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'forbidden'; permissions: string[] }
  | { status: 'ok'; context: AdminApiKeyServiceContext; permissions: string[] };

/**
 * Resolves a request's `Authorization` header to an admin-API-key
 * `AdminApiKeyServiceContext`, or a typed reason it didn't. `requiredPermission`
 * is checked against the key's own grant set only — never RLS/`authorize()`,
 * which have nothing to evaluate for a session-less bearer caller.
 */
export async function resolveAdminApiKeyContext(
  authorizationHeader: string | null,
  adminClient: SupabaseClient,
  pepper: string | undefined,
  requiredPermission?: string,
): Promise<AdminApiKeyRequestAuth> {
  const bearerToken = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length).trim()
    : null;
  if (!bearerToken?.startsWith(ADMIN_API_KEY_PREFIX)) {
    return { status: 'absent' };
  }

  const auth = await verifyAdminApiKeyBearer(authorizationHeader, adminClient, pepper);
  if (!auth) {
    return { status: 'invalid' };
  }

  if (requiredPermission && !auth.permissions.includes(requiredPermission)) {
    return { status: 'forbidden', permissions: auth.permissions };
  }

  const context: AdminApiKeyServiceContext = {
    db: adminClient,
    tenantId: auth.tenantId,
    actor: { userId: `admin_api_key:${auth.adminApiKeyId}`, role: '' },
  };

  return { status: 'ok', context, permissions: auth.permissions };
}

/**
 * The result `resolveBearerServiceContext` branches on. `401` and `403` are
 * kept apart (rather than one generic failure) so a host's call sites can
 * throw different error classes for each: unauthenticated vs.
 * authenticated-but-not-permitted.
 */
export type BearerServiceContextResult =
  | { ok: true; ctx: AdminApiKeyServiceContext; keyPermissions: string[] }
  | { ok: false; status: 401; message: string }
  | { ok: false; status: 403; message: string };

/**
 * Escapes LIKE metacharacters so an `ilike` match on an org slug is literal
 * (case-only insensitivity), never a wildcard pattern.
 */
function escapeOrgNameForIlike(orgName: string): string {
  return orgName.replace(/[\\%_]/g, '\\$&');
}

/**
 * Resolves a URL org slug to its tenant id directly against the `tenant`
 * table, with no membership filter — a bearer caller has no session user to
 * scope the lookup to. Same case-insensitive, metacharacter-escaped `ilike`
 * match a session path would use, so `/api/orgs/Acme` and `/api/orgs/acme`
 * resolve identically for both auth paths. An org slug naming no tenant
 * resolves to `null`.
 */
async function resolveBearerTenantId(adminClient: SupabaseClient, orgName: string): Promise<string | null> {
  const literal = escapeOrgNameForIlike(orgName);
  const { data } = await adminClient
    .from('tenant')
    .select('tenant_id')
    .ilike('organization_name', literal)
    .limit(1)
    .maybeSingle();

  return (data?.tenant_id as string | undefined) ?? null;
}

interface ResolveBearerServiceContextParams {
  authorizationHeader: string | null;
  orgName: string;
  adminClient: SupabaseClient;
  pepper: string | undefined;
}

/**
 * Builds a bearer-authed `AdminApiKeyServiceContext` for org-scoped routes
 * that resolve auth manually, given an already-read `Authorization` header
 * and org slug — the host owns reading both off the live request.
 *
 * Three checks, all fail-closed:
 *
 *   1. The key verifies (not malformed/unknown/expired/revoked) — 401.
 *   2. **Tenant binding**: the key's own `tenant_id` must equal the tenant
 *      `orgName` resolves to. A key minted for org A presented against org
 *      B's URL is a cross-tenant attempt, not a fallback to the key's own
 *      tenant — 403. An `orgName` that names no tenant at all is the same
 *      failure.
 *   3. **Actor attribution**: the key's creator must hold an ACTIVE
 *      membership in that tenant RIGHT NOW — re-resolved every call, never
 *      cached from mint time. An admin API key acts as its creator: this is
 *      what keeps `MembershipService`'s role-based rules (owner-only owner
 *      invites, last-owner protection) and audit-log attribution meaningful
 *      for a bearer caller, and what makes a key's practical authority
 *      disappear the moment its creator leaves or is disabled, with no
 *      separate revocation step. A key with no recorded creator fails the
 *      same way.
 *
 * `ctx.db` is the service-role admin client — a bearer request carries no
 * session JWT, so there is no RLS-scoped client to hand back.
 */
export async function resolveBearerServiceContext(
  params: ResolveBearerServiceContextParams,
): Promise<BearerServiceContextResult> {
  const { authorizationHeader, orgName, adminClient, pepper } = params;

  const auth = await verifyAdminApiKeyBearer(authorizationHeader, adminClient, pepper);
  if (!auth) {
    return { ok: false, status: 401, message: 'Not authenticated' };
  }

  const resolvedTenantId = await resolveBearerTenantId(adminClient, orgName);
  if (!resolvedTenantId || resolvedTenantId !== auth.tenantId) {
    return { ok: false, status: 403, message: 'This key does not belong to this organization' };
  }

  if (!auth.createdBy) {
    return { ok: false, status: 403, message: 'This key has no recorded creator' };
  }

  const { data: creatorMembership } = await adminClient
    .from('membership')
    .select('role, custom_role_id')
    .eq('user_id', auth.createdBy)
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'active')
    .maybeSingle();

  if (!creatorMembership) {
    return { ok: false, status: 403, message: "This key's creator is no longer an active member" };
  }

  // A custom-role creator's effective permission set requires resolving the
  // EE custom-role tables, which this package deliberately doesn't reach
  // into — see the host's own custom-role resolver for that story. Rather
  // than half-replicate it here, a custom-role creator fails closed: the key
  // holds no effective permissions until the host builds that path.
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
    .from('role_permissions')
    .select('permission')
    .eq('role', creatorMembership.role);
  const rolePermissions = new Set((rolePermissionRows ?? []).map((row) => row.permission as string));
  const effectivePermissions = auth.permissions.filter((permission) => rolePermissions.has(permission));

  const ctx: AdminApiKeyServiceContext = {
    db: adminClient,
    tenantId: auth.tenantId,
    actor: { userId: auth.createdBy, role: creatorMembership.role as string },
  };

  return { ok: true, ctx, keyPermissions: effectivePermissions };
}
