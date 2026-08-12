import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { adminApiKeysService } from "./service";
import type { AdminApiKeyRow } from "./types";

/** RSC read behind the org settings admin-API-keys panel. */
export async function loadAdminApiKeys(): Promise<AdminApiKeyRow[]> {
  const ctx = await loadRequestServiceContext();
  return adminApiKeysService.list(ctx);
}
