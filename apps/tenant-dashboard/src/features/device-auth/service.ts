/**
 * DeviceAuthService — the dashboard-side half of the CLI device-login
 * handshake. Reads that identify a pending request run against the
 * service-role `lib/system/device-auth` module (the table carries no RLS
 * policies at all — see supabase/schemas/24-device-auth.sql); the one
 * RLS-scoped read here (the caller's own membership id) runs on `ctx.db`
 * because the audit trail and the minted key's actor attribution must name
 * the ACTUAL approver, never an admin-resolved guess.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";
import {
  findPendingRequestByUserCode,
  approveDeviceAuthRequest,
  denyDeviceAuthRequest,
  type DeviceAuthRequestRow,
} from "@/lib/system/device-auth";
import { resolveDefaultEnvironmentIdAsSystem } from "@/lib/system/resolve-default-environment";

class DeviceAuthService {
  findPendingByUserCode(userCode: string): Promise<DeviceAuthRequestRow | null> {
    return findPendingRequestByUserCode(userCode);
  }

  /** The caller's own membership id in `ctx.tenantId` — a self-row read, so
   * RLS's own-membership visibility (no special permission needed) covers
   * it. Null if the caller somehow has no membership row in this tenant. */
  async resolveOwnMembershipId(ctx: ServiceContext): Promise<string | null> {
    const db = ctx.db as SupabaseClient;
    const { data } = await db
      .from("membership")
      .select("id")
      .eq("user_id", ctx.actor.userId)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    return data?.id ?? null;
  }

  /** Null return means "the transition did not happen" — either the
   * approver has no membership row (should not occur for an authenticated,
   * tenant-scoped caller, but is not assumed away), or the atomic UPDATE's
   * own precondition no longer held (already resolved or expired). Callers
   * must not distinguish these two null causes in the response — both mean
   * "nothing to approve." */
  async approve(
    ctx: ServiceContext,
    params: { requestId: string; appId: string },
  ): Promise<DeviceAuthRequestRow | null> {
    const approverMembershipId = await this.resolveOwnMembershipId(ctx);
    if (!approverMembershipId) return null;
    const environmentId = await resolveDefaultEnvironmentIdAsSystem(params.appId);
    return approveDeviceAuthRequest({
      id: params.requestId,
      tenantId: ctx.tenantId,
      appId: params.appId,
      environmentId,
      approverMembershipId,
    });
  }

  deny(requestId: string): Promise<DeviceAuthRequestRow | null> {
    return denyDeviceAuthRequest(requestId);
  }
}

export const deviceAuthService = new DeviceAuthService();
