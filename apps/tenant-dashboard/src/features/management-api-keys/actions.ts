"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { authorizedAction } from "@/lib/action-kit";
import { checkRequestPermission } from "@/lib/adapters";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import { mintManagementApiKeySystem } from "@/lib/system/management-api-key-service";

import { createManagementApiKeyInput, revokeManagementApiKeyInput } from "./schemas";
import { managementApiKeysService } from "./service";
import type { CreateManagementApiKeyOutcome, RevokeManagementApiKeyOutcome } from "./types";

const MANAGEMENT_API_KEYS_SETTINGS_PATH = "/orgs/[orgName]/settings/management-api-keys";

/**
 * Rejects a grant that exceeds the CALLER's own org permissions, rather than
 * trimming it — same escalation model `features/api-keys/actions.ts` uses
 * for gateway keys. An management API key is a shadow admin session: an unclamped
 * mint would let e.g. an `admin` who lacks `sso_config.update` (owner-only)
 * hand out a key that outranks them.
 */
async function clampToCaller(
  ctx: ServiceContext,
  requested: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const denied: string[] = [];
  for (const permission of requested) {
    const allowed = await checkRequestPermission(ctx.actor, permission);
    if (!allowed) denied.push(permission);
  }
  if (denied.length > 0) {
    return {
      ok: false,
      message: `Cannot grant permissions you do not hold: ${[...new Set(denied)].sort().join(", ")}`,
    };
  }
  return { ok: true };
}

export const createManagementApiKeyAction = authorizedAction({
  input: createManagementApiKeyInput,
  permission: "management_api_key.insert",
  handler: async (ctx, input): Promise<CreateManagementApiKeyOutcome> => {
    const clamp = await clampToCaller(ctx, input.permissions);
    if (!clamp.ok) {
      return { ok: false, message: clamp.message };
    }

    try {
      const { plaintext } = await mintManagementApiKeySystem({
        rowClient: ctx.db as SupabaseClient,
        tenantId: ctx.tenantId,
        name: input.name,
        permissions: input.permissions,
        expiresAt: input.expiresAt ?? null,
        createdBy: ctx.actor.userId,
      });

      revalidatePath(MANAGEMENT_API_KEYS_SETTINGS_PATH, "page");
      return { ok: true, apiKey: plaintext };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong";
      return { ok: false, message };
    }
  },
});

export const revokeManagementApiKeyAction = authorizedAction({
  input: revokeManagementApiKeyInput,
  permission: "management_api_key.delete",
  handler: async (ctx, input): Promise<RevokeManagementApiKeyOutcome> => {
    const result = await managementApiKeysService.revoke(ctx, input.id);
    if (!result.ok) {
      return { ok: false, message: result.error };
    }
    revalidatePath(MANAGEMENT_API_KEYS_SETTINGS_PATH, "page");
    return { ok: true };
  },
});
