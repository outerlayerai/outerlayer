import "server-only";

/**
 * Thin wrapper over `@repo/org-management-service`'s framework-free admin
 * API key authority: injects the pepper and the service-role client
 * construction — the two things the package can't own itself — into its
 * mint call. The dashboard no longer accepts management-API-key bearer
 * calls itself (that surface lives on the gateway now), so this module
 * carries only what the key-minting settings UI consumes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { MANAGEMENT_API_KEY_PREFIX, mintManagementApiKey } from "@repo/org-management-service";
import { MANAGEMENT_API_KEY_PEPPER } from "@/config-global.server";
import { getAdminDataClient } from "./admin-client";

export { MANAGEMENT_API_KEY_PREFIX };

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
