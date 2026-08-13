import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { managementApiKeysService } from "./service";
import type { ManagementApiKeyRow } from "./types";

/** RSC read behind the org settings management-API-keys panel. */
export async function loadManagementApiKeys(): Promise<ManagementApiKeyRow[]> {
  const ctx = await loadRequestServiceContext();
  return managementApiKeysService.list(ctx);
}
