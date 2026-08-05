import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { orgSettingsService } from "./service";
import type { OrgSettings } from "./types";

/**
 * The React Server Component (RSC) read behind the General settings page: the request tenant's org
 * row. Scoped by `tenant.read` RLS, so a caller without the permission (or a
 * membership fallback) gets null and the page renders empty rather than
 * throwing.
 */
export async function loadOrgSettings(): Promise<OrgSettings | null> {
  const ctx = await loadRequestServiceContext();
  return orgSettingsService.getTenant(ctx);
}
