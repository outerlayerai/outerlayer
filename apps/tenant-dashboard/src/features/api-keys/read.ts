import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { apiKeysService } from "./service";
import type { LoadApiKeysResult } from "./types";

/**
 * The React Server Component (RSC) read behind the API Keys settings page. Resolves the request
 * context through `loadRequestServiceContext()`, so `public.tenant_id()`
 * takes the validated header (URL-org) arm rather than the JWT claim arm a
 * stale session claim could name a different org for — an intentional
 * strengthening over the prior `createSupabaseServerClient()` call with no
 * tenant argument.
 */
export async function loadApiKeys(
  appName: string,
  envParam: string | undefined,
): Promise<LoadApiKeysResult> {
  const ctx = await loadRequestServiceContext();

  const appId = await apiKeysService.resolveAppIdByName(ctx, appName);
  if (!appId) {
    return { apiKeys: [] };
  }

  const scoped = await apiKeysService.listForEnv(ctx, appId, envParam);
  if ("unresolved" in scoped) {
    return { apiKeys: [], unresolved: true };
  }

  return scoped;
}
