"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { preTenantAction } from "@/lib/action-kit";
import { createTermsAgreementService } from "@/lib/system";
import { recordTermsAgreementForUser } from "@/lib/system/terms-agreement";
import {
  acceptInvitationForUser,
  checkNeedsTermsAgreement,
  getInvitationDetailsForUser,
} from "@/lib/system/org-actions-admin";
import { TERMS_VERSION } from "@/config/terms";
import type { ServerActionResponse } from "@/types/server-action";
import type { TermsCheckResult } from "@/lib/system/terms-agreement-types";
import type { InvitationDetails } from "@/lib/system/organization-service";
import { acceptInvitationInput, getInvitationDetailsInput } from "./schemas";

/**
 * Every action here runs pre-tenant: the caller is authenticated but there is
 * no tenant to resolve or permission to check (the caller's own consent
 * record, or a membership that isn't active yet). `preTenantAction` enforces
 * the authentication so no handler repeats it by hand, and withholds
 * `db`/`tenantId` — a tenant-scoped need belongs in `authorizedAction`, not
 * here. Handlers return the `ServerActionResponse` shape;
 * `action-adapters.ts` unwraps the `preTenantAction` envelope around it
 * for client callers.
 */

/**
 * Checks if the current user has agreed to terms.
 *
 * Non-blocking policy: a user with ANY existing agreement — any version — is
 * never blocked; only a user with no agreement at all needs one, so
 * `needsCurrentVersion` is true only when the user has no agreement at all.
 * This implements "continued use = acceptance": the audit trail
 * (`terms_agreement` table) maintains compliance by recording explicit
 * acceptance at registration, tracking which version each user originally
 * agreed to, and keeping immutable records for legal defensibility.
 */
export const checkTermsAgreement = preTenantAction({
  input: z.void(),
  reason: "user-scoped",
  handler: async (actor): Promise<ServerActionResponse<TermsCheckResult>> => {
    const service = createTermsAgreementService();
    try {
      const result = await service.checkTermsStatus(actor.userId, TERMS_VERSION);
      return { data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to check agreement";
      return { error: message };
    }
  },
});

/**
 * Accept invitation server action. Updates membership status to 'active',
 * validates the invitation is not expired before accepting, checks the org
 * limit before acceptance (reject if the user is already at 10 orgs), and
 * records terms agreement when accepting the invitation (if agreedToTerms).
 * After acceptance, the new org appears in the user's dropdown on next
 * login/refresh.
 */
export const acceptInvitation = preTenantAction({
  input: acceptInvitationInput,
  reason: "pending-membership",
  handler: async (
    actor,
    { membershipId, agreedToTerms },
  ): Promise<ServerActionResponse<{ tenantId: string; companyName: string }>> => {
    // If the user agreed to terms, record the agreement first. Continuing on
    // failure is deliberate — terms can still be recorded later via the
    // blocking flow, and a logging hiccup here must not block acceptance.
    if (agreedToTerms) {
      const termsResult = await recordTermsAgreementForUser(actor.userId);
      if (termsResult.error) {
        console.error("[AcceptInvitation] Failed to record terms agreement:", termsResult.error);
      }
    }

    const result = await acceptInvitationForUser(
      { userId: actor.userId, email: actor.email },
      membershipId,
    );

    if (!result.success) {
      return { error: result.error };
    }

    revalidatePath("/orgs");
    return {
      data: {
        tenantId: result.tenantId!,
        companyName: result.companyName!,
      },
    };
  },
});

/**
 * Check if the current user needs to agree to terms for invitation
 * acceptance. Used by the accept-invite page to decide whether to show the
 * terms checkbox.
 */
export const checkTermsForInvitation = preTenantAction({
  input: z.void(),
  reason: "pending-membership",
  handler: async (
    actor,
  ): Promise<ServerActionResponse<{ needsAgreement: boolean; currentVersion: string }>> => {
    try {
      const needsAgreement = await checkNeedsTermsAgreement(actor.userId);
      return { data: { needsAgreement, currentVersion: TERMS_VERSION } };
    } catch (error) {
      console.error("[checkTermsForInvitation] Error:", error);
      // Fail closed toward showing the checkbox.
      return { data: { needsAgreement: true, currentVersion: TERMS_VERSION } };
    }
  },
});

/**
 * Get pending invitation details for the accept-invite page.
 */
export const getInvitationDetails = preTenantAction({
  input: getInvitationDetailsInput,
  reason: "pending-membership",
  handler: async (
    actor,
    { membershipId },
  ): Promise<ServerActionResponse<InvitationDetails>> => {
    const result = await getInvitationDetailsForUser({ userId: actor.userId }, membershipId);

    if (!result.success) {
      return { error: result.error };
    }

    return { data: result.data! };
  },
});
