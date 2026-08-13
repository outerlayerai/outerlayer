"use server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { authorizedAction } from "@/lib/action-kit";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import { writeAuditLog } from "@/lib/system/audit-log";

import { approveDeviceAuthInput, denyDeviceAuthInput } from "./schemas";
import { deviceAuthService } from "./service";
import type { ApproveDeviceAuthOutcome, DenyDeviceAuthOutcome } from "./types";

async function auditQuietly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // An audit hiccup must never turn a completed approval/denial into a
    // reported failure — mirrors features/api-keys/actions.ts's own idiom.
  }
}

/**
 * The permissions the CURRENT caller holds on `appId`, via
 * `get_current_user_app_permissions` run on `ctx.db` — the caller's own
 * answer, never the service role's. Fails CLOSED: an RPC error yields an
 * empty set, so the trace.write check below denies rather than passing
 * unchecked.
 */
async function resolveCallerPermissions(ctx: ServiceContext, appId: string): Promise<Set<string>> {
  const { data, error } = await (ctx.db as SupabaseClient).rpc("get_current_user_app_permissions", {
    target_app_id: appId,
  });
  if (error) return new Set();
  return new Set((Array.isArray(data) ? data : []).map(String));
}

/**
 * Approves a pending device login, minting the CLI a `trace.write`-only key
 * (see lib/system/mint-device-auth-key.ts) once it next polls. Gated
 * `api_key.insert` at the wrapper (an ordinary caller with no api-key grant
 * at all is refused there); the handler additionally requires the caller
 * hold `trace.write` themselves — the device mint must not out-privilege
 * its approver, mirroring `createApiKeyAction`'s reject-surplus clamp.
 */
export const approveDeviceAuthAction = authorizedAction({
  input: approveDeviceAuthInput,
  permission: "api_key.insert",
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<ApproveDeviceAuthOutcome> => {
    const held = await resolveCallerPermissions(ctx, input.appId);
    if (!held.has("trace.write")) {
      return {
        ok: false,
        errorCode: "permissions_exceed_caller",
        message: "You must hold trace.write on this app to approve a CLI login.",
      };
    }

    const approved = await deviceAuthService.approve(ctx, { requestId: input.requestId, appId: input.appId });
    if (!approved) {
      return {
        ok: false,
        errorCode: "already_resolved",
        message: "This code is no longer waiting for approval — it may have expired or already been used.",
      };
    }

    await auditQuietly(() =>
      writeAuditLog({
        tenantId: ctx.tenantId,
        actorId: ctx.actor.userId,
        actorLabel: null,
        actionType: "device_login_approved",
        targetType: "device_auth_request",
        targetId: approved.id,
        targetIdentifier: approved.user_code,
        details: { app_id: input.appId },
      }),
    );

    return { ok: true };
  },
});

/** Denial needs no clamp check (nothing is minted) — same `api_key.insert`
 * gate as approval since it is the other half of the same confirmation UI. */
export const denyDeviceAuthAction = authorizedAction({
  input: denyDeviceAuthInput,
  permission: "api_key.insert",
  handler: async (ctx, input): Promise<DenyDeviceAuthOutcome> => {
    const denied = await deviceAuthService.deny(input.requestId);
    if (!denied) {
      return {
        ok: false,
        errorCode: "already_resolved",
        message: "This code is no longer waiting for approval.",
      };
    }

    await auditQuietly(() =>
      writeAuditLog({
        tenantId: ctx.tenantId,
        actorId: ctx.actor.userId,
        actorLabel: null,
        actionType: "device_login_denied",
        targetType: "device_auth_request",
        targetId: denied.id,
        targetIdentifier: denied.user_code,
      }),
    );

    return { ok: true };
  },
});
