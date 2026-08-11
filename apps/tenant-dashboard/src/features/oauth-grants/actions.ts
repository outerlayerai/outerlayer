"use server";

import { revalidatePath } from "next/cache";

import { preTenantAction } from "@/lib/action-kit";
import { loadPreTenantDb } from "@/lib/adapters";

import { oauthGrantsService } from "./service";
import { revokeOAuthGrantInput } from "./schemas";

/**
 * Revokes a connector grant by deleting its `auth.sessions` row (the
 * verified kill switch — refresh dies on the next attempt). `user-scoped`:
 * a grant belongs to the signed-in user, not any one tenant.
 */
export const revokeOAuthGrantAction = preTenantAction({
  input: revokeOAuthGrantInput,
  reason: "user-scoped",
  handler: async (_actor, input) => {
    const db = await loadPreTenantDb();
    if (!db) {
      throw new Error("Not authenticated");
    }
    const revoked = await oauthGrantsService.revoke(db, input.sessionId);
    revalidatePath("/", "layout");
    return { revoked };
  },
});
