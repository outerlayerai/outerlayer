import "server-only";

/**
 * Resolves the verified context an agent-sessions React Server Component (RSC) page needs, from the
 * URL's `[appName]` segment — the server-side counterpart of the client's
 * `useAppId()`/`useAppContext()` read. Bundles the RLS-scoped `db` alongside
 * the tenant/app verification so the service never opens a client of its own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ForbiddenError, ValidationError } from "@repo/observability-service";
import { loadRequestServiceContext, logServerError } from "@/lib/adapters";
import { getAppIdByName } from "@/utils/get-app-id";
import { verifyAppAccess } from "@/lib/analytics/tenant-context";
import type { Database } from "@/types/db";

import type { AgentSessionsContext } from "./service";

/**
 * Returns `null` when `appName` doesn't resolve to an app the caller can
 * read — the RLS-scoped lookup and `verifyAppAccess`'s own tenant check both
 * fail closed, so a foreign-tenant `appName` and a typo'd one look identical.
 * Callers hand a `null` to Next's `notFound()`.
 */
export async function resolveAgentSessionsContext(appName: string): Promise<AgentSessionsContext | null> {
  const appId = await getAppIdByName(appName);
  if (!appId) return null;

  const { db, tenantId, actor } = await loadRequestServiceContext();
  // `loadRequestServiceContext` types `db` as the narrow action-kit `Db`
  // interface; it is a real Supabase client at runtime (the same one every
  // Supabase-backed feature service takes as `ctx.db`), already scoped to
  // `tenantId` — the exact client `verifyAppAccess` needs.
  const typedDb = db as unknown as SupabaseClient<Database>;

  try {
    const tenantContext = await verifyAppAccess(typedDb, actor.userId, tenantId, appId);
    return { ...tenantContext, db: typedDb };
  } catch (error) {
    // `verifyAppAccess` throws `ForbiddenError` for the ordinary denial case
    // (a foreign-tenant or nonexistent app) — deliberately mapped to the same
    // `null`/`notFound()` as a typo'd `appName`, so there is no existence
    // oracle for an app the caller cannot see. `ValidationError` means a
    // required argument was empty (shouldn't happen — appId/tenantId/userId
    // are all already resolved above) and fails closed the same way.
    // Anything else is unexpected (a DB outage, a bug) and must NOT
    // masquerade as a 404 — log it and let the error boundary render it.
    if (error instanceof ForbiddenError || error instanceof ValidationError) {
      return null;
    }
    await logServerError(error, { scope: "resolveAgentSessionsContext", appName });
    throw error;
  }
}
