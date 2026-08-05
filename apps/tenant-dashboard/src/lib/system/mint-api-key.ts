import "server-only";

/**
 * The api-key mint wrapper: writes the `public.api_key` row on the caller's
 * RLS-scoped client, then the private digest via `set_api_key_secret`, which
 * is `REVOKE`d from `PUBLIC, anon, authenticated` and granted to
 * `service_role` only — non-negotiable, so the admin client for that RPC is
 * owned here rather than handed to feature code. Kept as one call: splitting
 * the row insert from the digest write would leave a key row without a
 * digest — unusable but still consuming the entitlement count.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { mintApiKey, type MintApiKeyResult } from "@repo/api-key-service";
import { API_KEY_PEPPER } from "@/config-global.server";
import { getAdminDataClient } from "./admin-client";

interface MintApiKeySystemParams {
  /** RLS-scoped client (ctx.db); the row INSERT runs under its policy. */
  rowClient: SupabaseClient;
  tenantId: string;
  appId: string;
  name: string;
  environmentId: string | null;
  allowedEnvKinds: string[] | null;
  permissions: string[];
}

export async function mintApiKeySystem(
  params: MintApiKeySystemParams,
): Promise<MintApiKeyResult> {
  return mintApiKey({
    rowClient: params.rowClient,
    adminClient: getAdminDataClient(),
    pepper: API_KEY_PEPPER,
    tenantId: params.tenantId,
    appId: params.appId,
    name: params.name,
    environmentId: params.environmentId,
    allowedEnvKinds: params.allowedEnvKinds,
    permissions: params.permissions,
  });
}
