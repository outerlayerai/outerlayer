import "server-only";

/**
 * Thin wrapper over `@repo/org-management-service`'s framework-free admin
 * API key authority: reads the `Authorization` header via `next/headers`
 * and resolves the URL org segment, then delegates every verification,
 * mint, and permission-resolution decision to the package. The pepper and
 * the service-role client construction — the two things the package can't
 * own itself — are injected here.
 */

import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ADMIN_API_KEY_PREFIX,
  mintAdminApiKey,
  verifyAdminApiKeyBearer as pkgVerifyAdminApiKeyBearer,
  resolveAdminApiKeyContext as pkgResolveAdminApiKeyContext,
  resolveBearerServiceContext,
  type AdminApiKeyRequestAuth,
  type BearerServiceContextResult,
} from "@repo/org-management-service";
import { ADMIN_API_KEY_PEPPER } from "@/config-global.server";
import { getAdminDataClient } from "./admin-client";

export { ADMIN_API_KEY_PREFIX };
// eslint-disable-next-line import/no-unused-modules -- consumed by bearer-auth call sites outside this module (withApi's authenticateRequest today; org-scoped route auth seams next)
export type { AdminApiKeyRequestAuth };
// eslint-disable-next-line import/no-unused-modules -- part of loadBearerServiceContext's public return type, for callers/tests that want to branch on it explicitly
export type { BearerServiceContextResult };

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
 * left as a visible-but-unverifiable key.
 */
export async function mintAdminApiKeySystem(
  params: MintAdminApiKeyParams,
): Promise<MintAdminApiKeyResult> {
  return mintAdminApiKey({
    ...params,
    pepper: ADMIN_API_KEY_PEPPER,
    adminClient: getAdminDataClient(),
  });
}

/**
 * Resolves an `Authorization` header to the admin API key it names, or
 * `null` on anything short of a live, unrevoked, unexpired key.
 */
export async function verifyAdminApiKeyBearer(
  authorizationHeader: string | null,
  adminClient: SupabaseClient = getAdminDataClient(),
) {
  return pkgVerifyAdminApiKeyBearer(authorizationHeader, adminClient, ADMIN_API_KEY_PEPPER);
}

/**
 * Resolves a request's `Authorization` header to an admin-API-key
 * `ServiceContext`, or a typed reason it didn't.
 */
export async function resolveAdminApiKeyContext(
  request: Request,
  requiredPermission?: string,
  adminClient: SupabaseClient = getAdminDataClient(),
): Promise<AdminApiKeyRequestAuth> {
  return pkgResolveAdminApiKeyContext(
    request.headers.get("authorization"),
    adminClient,
    ADMIN_API_KEY_PEPPER,
    requiredPermission,
  );
}

/**
 * Builds a bearer-authed `ServiceContext` for org-scoped routes that resolve
 * auth manually (the `requireOrgContext` family), rather than through
 * `withApi`'s app-scoped `authenticateRequest`. Reads the `Authorization`
 * header itself via `next/headers` — these routes call in with no `Request`
 * object in hand.
 */
export async function loadBearerServiceContext(
  orgName: string,
  adminClient: SupabaseClient = getAdminDataClient(),
): Promise<BearerServiceContextResult> {
  const requestHeaders = await headers();
  return resolveBearerServiceContext({
    authorizationHeader: requestHeaders.get("authorization"),
    orgName,
    adminClient,
    pepper: ADMIN_API_KEY_PEPPER,
  });
}
