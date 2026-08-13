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
  MANAGEMENT_API_KEY_PREFIX,
  mintManagementApiKey,
  verifyManagementApiKeyBearer as pkgVerifyManagementApiKeyBearer,
  resolveManagementApiKeyContext as pkgResolveManagementApiKeyContext,
  resolveBearerServiceContext,
  type ManagementApiKeyRequestAuth,
  type BearerServiceContextResult,
} from "@repo/org-management-service";
import { MANAGEMENT_API_KEY_PEPPER } from "@/config-global.server";
import { getAdminDataClient } from "./admin-client";

export { MANAGEMENT_API_KEY_PREFIX };
// eslint-disable-next-line import/no-unused-modules -- consumed by bearer-auth call sites outside this module (withApi's authenticateRequest today; org-scoped route auth seams next)
export type { ManagementApiKeyRequestAuth };
// eslint-disable-next-line import/no-unused-modules -- part of loadBearerServiceContext's public return type, for callers/tests that want to branch on it explicitly
export type { BearerServiceContextResult };

interface MintManagementApiKeyParams {
  /** RLS-scoped client (ctx.db); the row INSERT runs under its policy. */
  rowClient: SupabaseClient;
  tenantId: string;
  name: string;
  permissions: string[];
  expiresAt: string | null;
  createdBy: string;
}

interface MintManagementApiKeyResult {
  /** Plaintext key — return to the caller once, then drop. */
  plaintext: string;
  row: Record<string, unknown> & { id: string; management_api_key_id: string };
}

/**
 * Mint an management API key: write the `public.management_api_key` row, then its
 * private digest. On a digest-write failure the row is deleted rather than
 * left as a visible-but-unverifiable key.
 */
export async function mintManagementApiKeySystem(
  params: MintManagementApiKeyParams,
): Promise<MintManagementApiKeyResult> {
  return mintManagementApiKey({
    ...params,
    pepper: MANAGEMENT_API_KEY_PEPPER,
    adminClient: getAdminDataClient(),
  });
}

/**
 * Resolves an `Authorization` header to the management API key it names, or
 * `null` on anything short of a live, unrevoked, unexpired key.
 */
export async function verifyManagementApiKeyBearer(
  authorizationHeader: string | null,
  adminClient: SupabaseClient = getAdminDataClient(),
) {
  return pkgVerifyManagementApiKeyBearer(authorizationHeader, adminClient, MANAGEMENT_API_KEY_PEPPER);
}

/**
 * Resolves a request's `Authorization` header to an management-API-key
 * `ServiceContext`, or a typed reason it didn't.
 */
export async function resolveManagementApiKeyContext(
  request: Request,
  requiredPermission?: string,
  adminClient: SupabaseClient = getAdminDataClient(),
): Promise<ManagementApiKeyRequestAuth> {
  return pkgResolveManagementApiKeyContext(
    request.headers.get("authorization"),
    adminClient,
    MANAGEMENT_API_KEY_PEPPER,
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
    pepper: MANAGEMENT_API_KEY_PEPPER,
  });
}
