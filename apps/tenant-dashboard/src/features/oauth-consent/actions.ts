"use server";

import { env } from "@/env";
import { preTenantAction } from "@/lib/action-kit";
import { loadPreTenantActorSession } from "@/lib/adapters";

import { oauthConsentService } from "./service";
import { decideOAuthConsentInput } from "./schemas";

/**
 * Submits the signed-in user's approve/deny decision for a bound OAuth
 * authorization. `cross-tenant`: this action authorizes a connector client
 * as the user, not as a specific tenant's member — access it later
 * exercises is scoped per MCP call by the gateway's own membership checks,
 * not by anything decided here.
 */
export const decideOAuthConsentAction = preTenantAction({
  input: decideOAuthConsentInput,
  reason: "cross-tenant",
  handler: async (_actor, input) => {
    const session = await loadPreTenantActorSession();
    if (!session) {
      throw new Error("Not authenticated");
    }
    return oauthConsentService.submitConsent(
      env.NEXT_PUBLIC_SUPABASE_URL,
      session.accessToken,
      input.authorizationId,
      input.decision,
    );
  },
});
