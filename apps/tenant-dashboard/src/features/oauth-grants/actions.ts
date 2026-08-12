"use server";

import { revalidatePath } from "next/cache";

import { preTenantAction } from "@/lib/action-kit";

import { oauthGrantsService } from "./service";
import { revokeOAuthGrantInput } from "./schemas";

/**
 * Revokes a connector grant by deleting its `auth.sessions` row (the
 * verified kill switch — refresh dies on the next attempt). `user-scoped`:
 * a grant belongs to the signed-in user, not any one tenant. The user id
 * comes from the resolved actor, never from `input` — the RPC behind this
 * scopes the delete to whichever id it's given, so passing anything but
 * the caller's own session-verified id would let a request revoke another
 * user's grant.
 */
export const revokeOAuthGrantAction = preTenantAction({
  input: revokeOAuthGrantInput,
  reason: "user-scoped",
  handler: async (actor, input) => {
    const revoked = await oauthGrantsService.revoke(actor.userId, input.sessionId);
    revalidatePath("/", "layout");
    return { revoked };
  },
});
