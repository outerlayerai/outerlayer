"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { authorizedAction } from "@/lib/action-kit";
import { checkRequestPermission } from "@/lib/adapters";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import { mintAdminApiKeySystem } from "@/lib/system/admin-api-key-service";

import { createAdminApiKeyInput, revokeAdminApiKeyInput } from "./schemas";
import { adminApiKeysService } from "./service";
import type { CreateAdminApiKeyOutcome, RevokeAdminApiKeyOutcome } from "./types";

const ADMIN_API_KEYS_SETTINGS_PATH = "/orgs/[orgName]/settings/admin-api-keys";

/**
 * Rejects a grant that exceeds the CALLER's own org permissions, rather than
 * trimming it — same escalation model `features/api-keys/actions.ts` uses
 * for gateway keys. An admin API key is a shadow admin session: an unclamped
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

export const createAdminApiKeyAction = authorizedAction({
  input: createAdminApiKeyInput,
  permission: "admin_api_key.insert",
  handler: async (ctx, input): Promise<CreateAdminApiKeyOutcome> => {
    const clamp = await clampToCaller(ctx, input.permissions);
    if (!clamp.ok) {
      return { ok: false, message: clamp.message };
    }

    try {
      const { plaintext } = await mintAdminApiKeySystem({
        rowClient: ctx.db as SupabaseClient,
        tenantId: ctx.tenantId,
        name: input.name,
        permissions: input.permissions,
        expiresAt: input.expiresAt ?? null,
        createdBy: ctx.actor.userId,
      });

      revalidatePath(ADMIN_API_KEYS_SETTINGS_PATH, "page");
      return { ok: true, apiKey: plaintext };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong";
      return { ok: false, message };
    }
  },
});

export const revokeAdminApiKeyAction = authorizedAction({
  input: revokeAdminApiKeyInput,
  permission: "admin_api_key.delete",
  handler: async (ctx, input): Promise<RevokeAdminApiKeyOutcome> => {
    const result = await adminApiKeysService.revoke(ctx, input.id);
    if (!result.ok) {
      return { ok: false, message: result.error };
    }
    revalidatePath(ADMIN_API_KEYS_SETTINGS_PATH, "page");
    return { ok: true };
  },
});
