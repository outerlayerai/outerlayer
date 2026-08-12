import "server-only";

import { headers } from "next/headers";
import { AnalyticsError, ForbiddenError } from "@repo/observability-service";

import { loadRequestServiceContext, checkRequestPermission } from "@/lib/adapters";
import {
  loadBearerServiceContext,
  ADMIN_API_KEY_PREFIX,
} from "@/lib/system/admin-api-key-service";
import type { ServiceContext } from "@/lib/action-kit/service-context";

/**
 * `bearerPermissions` is non-null exactly when `ctx` came from an admin API
 * key: its own grant set is the permission source for that request (never
 * `authorize()`, which reads `auth.uid()` and has nothing to evaluate for a
 * session-less bearer caller). `null` means a session resolved `ctx` and the
 * RPC-backed `checkRequestPermission` applies, unchanged.
 */
interface ResolvedOrgContext {
  ctx: ServiceContext;
  bearerPermissions: string[] | null;
}

/**
 * The single bearer-vs-session branch point for the members REST routes.
 * These routes run `withApi` with `authRequired: false` and resolve auth
 * here instead — the wrapper's built-in `authenticateRequest` requires an
 * `appId` query param and verifies app-level access, which has no meaning
 * for org-scoped member management.
 *
 * A `Bearer olk_…` scheme is the whole auth decision once presented: it
 * either resolves to a live key bound to this org (`loadBearerServiceContext`
 * checks tenant binding + creator attribution) or this throws — never a
 * silent fall-through to session auth, which would let a bad bearer token
 * retry as an anonymous session. Only the ABSENCE of that scheme reaches the
 * session path below, unchanged from before this seam existed.
 */
async function resolveOrgContext(): Promise<ResolvedOrgContext> {
  const authorizationHeader = (await headers()).get("authorization");
  const bearerToken = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length).trim()
    : null;

  if (bearerToken?.startsWith(ADMIN_API_KEY_PREFIX)) {
    const result = await loadBearerServiceContext();
    if (!result.ok) {
      if (result.status === 401) {
        throw new AnalyticsError("Not authenticated", "unauthorized", 401);
      }
      throw new ForbiddenError(result.message);
    }
    return { ctx: result.ctx, bearerPermissions: result.keyPermissions };
  }

  try {
    const ctx = await loadRequestServiceContext();
    return { ctx, bearerPermissions: null };
  } catch (error) {
    if (error instanceof Error && error.message === "No tenant for request") {
      throw new ForbiddenError("No tenant associated with user");
    }
    throw new AnalyticsError("Not authenticated", "unauthorized", 401);
  }
}

/**
 * Resolves the request's `ServiceContext` (tenant-scoped `db`, tenant id,
 * table-driven actor role) for the members REST routes — bearer or session,
 * see `resolveOrgContext`. Errors are re-thrown with the same status codes
 * `withApi`'s own auth path uses, so both auth paths look identical to a
 * client.
 */
export async function requireOrgContext(): Promise<ServiceContext> {
  const { ctx } = await resolveOrgContext();
  return ctx;
}

/**
 * `requireOrgContext` plus the same coarse permission gate the member server
 * actions enforce (`src/features/members/actions.ts`,
 * `Permissions.MEMBERSHIP_*`) — the fine-grained business rules (self-demotion,
 * last-owner protection, …) still live in `MembershipService`. For a bearer
 * caller, "the gate" is membership in the key's own permission set, not the
 * `authorize()` RPC session check.
 */
export async function requireMembershipContext(permission: string): Promise<ServiceContext> {
  const { ctx, bearerPermissions } = await resolveOrgContext();
  const allowed = bearerPermissions
    ? bearerPermissions.includes(permission)
    : await checkRequestPermission(ctx.actor, permission);
  if (!allowed) {
    throw new ForbiddenError(`Permission denied: ${permission}`);
  }
  return ctx;
}
