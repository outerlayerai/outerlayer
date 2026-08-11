import "server-only";

import { loadPreTenantDb } from "@/lib/adapters";

import { oauthGrantsService } from "./service";
import type { OAuthGrant } from "./types";

type LoadOAuthGrantsResult = { grants: OAuthGrant[] } | { unresolved: true };

/** The read behind the Grants settings tab. Fails closed (`unresolved`)
 * rather than an empty list when there's no session to scope to — an
 * empty list would read as "no connectors", which is a different claim
 * than "couldn't check". */
export async function loadOAuthGrants(): Promise<LoadOAuthGrantsResult> {
  const db = await loadPreTenantDb();
  if (!db) {
    return { unresolved: true };
  }
  const grants = await oauthGrantsService.list(db);
  return { grants };
}
