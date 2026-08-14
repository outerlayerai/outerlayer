import type { ServerActionResponse } from "@/types/server-action";
// Imported from the dependency-free result module, NOT the action-kit barrel:
// this file is part of a Client Component's import graph, and the barrel pulls
// the wrapper's server-only dependencies (request context, Supabase server
// client) into the client bundle, which breaks the production build.
import { ActionErrorCodes } from "@/lib/action-kit/result";
import type { TermsCheckResult } from "@/lib/system/terms-agreement-types";
import type { InvitationDetails } from "@/lib/system/organization-service";

import {
  acceptInvitation,
  checkTermsAgreement,
  checkTermsForInvitation,
  declineInvitation,
  getInvitationDetails,
} from "./actions";

/**
 * Client-facing adapters over the pre-tenant auth server actions. Each raw
 * action resolves to a `preTenantAction` envelope carrying the
 * authentication outcome; these adapters flatten that envelope into the
 * plain `ServerActionResponse` shape the views render, mapping the
 * unauthenticated code to the specific literal string each action's callers
 * match on. `checkTermsAgreement` and the invite trio spell the same
 * condition differently ("Authentication required" vs "Not authenticated");
 * unifying them here would be a one-line temptation that silently changes
 * user-visible copy on the invite path, so the mapping stays per-action
 * rather than a single shared constant.
 *
 * `ActionErrorCodes.INTERNAL` carries `err.message` from whatever threw
 * inside the handler — a raw database or client-library message, never
 * authored for display. `preTenantAction`'s own contract is that no
 * exception crosses the action boundary un-redacted; forwarding that message
 * to the view here would defeat it, so INTERNAL always renders a generic
 * string instead.
 */
const GENERIC_SERVER_ERROR = "Something went wrong. Please try again.";

function unwrapErrorCode(code: string, unauthenticatedMessage: string): string | null {
  if (code === ActionErrorCodes.UNAUTHENTICATED) return unauthenticatedMessage;
  if (code === ActionErrorCodes.INTERNAL) return GENERIC_SERVER_ERROR;
  return null;
}

/**
 * Redacts a `ServerActionResponse.error` that isn't one of a handler's known,
 * deliberately-returned outcomes. Those outcomes are domain results the view
 * branches on or renders directly (e.g. `"expired"`); anything else reaching
 * this point — a raw database error, a constraint message — was never meant
 * for display and must not reach the client verbatim.
 */
function redactUnknownError<T>(
  response: ServerActionResponse<T>,
  knownErrors: ReadonlySet<string>,
): ServerActionResponse<T> {
  if (response.error !== undefined && !knownErrors.has(response.error)) {
    return { error: GENERIC_SERVER_ERROR };
  }
  return response;
}

/** Domain outcomes `acceptInvitation`'s handler returns on purpose. */
const ACCEPT_INVITATION_KNOWN_ERRORS = new Set([
  "Invitation not found",
  "You are already a member of this organization",
  "expired",
  "You have reached the maximum of 10 organizations. Leave an organization to accept this invitation.",
]);

/** Domain outcomes `getInvitationDetails`'s handler returns on purpose. */
const INVITATION_DETAILS_KNOWN_ERRORS = new Set(["Invitation not found", "already_accepted"]);

/** Domain outcomes `declineInvitation`'s handler returns on purpose. */
const DECLINE_INVITATION_KNOWN_ERRORS = new Set([
  "Invitation not found",
  "This invitation has already been accepted",
]);

/**
 * `checkTermsAgreement`'s handler has no deliberate domain outcome to
 * preserve — its only `{ error }` case wraps whatever `TermsAgreementService`
 * threw (e.g. `getLatestAgreement`'s `Failed to get latest agreement: …`), so
 * every value here is unintentional and must be redacted unconditionally.
 */
function redactError<T>(response: ServerActionResponse<T>): ServerActionResponse<T> {
  return response.error !== undefined ? { error: GENERIC_SERVER_ERROR } : response;
}

export async function checkTermsAgreementAction(): Promise<
  ServerActionResponse<TermsCheckResult>
> {
  const result = await checkTermsAgreement(undefined);
  if (!result.ok) {
    const message = unwrapErrorCode(result.error.code, "Authentication required");
    return { error: message ?? result.error.message };
  }
  return redactError(result.data);
}

export async function acceptInvitationAction(
  membershipId: string,
  agreedToTerms = false,
): Promise<ServerActionResponse<{ tenantId: string; companyName: string }>> {
  const result = await acceptInvitation({ membershipId, agreedToTerms });
  if (!result.ok) {
    const message = unwrapErrorCode(result.error.code, "Not authenticated");
    return { error: message ?? result.error.message };
  }
  return redactUnknownError(result.data, ACCEPT_INVITATION_KNOWN_ERRORS);
}

export async function declineInvitationAction(
  membershipId: string,
): Promise<ServerActionResponse<{ success: true }>> {
  const result = await declineInvitation({ membershipId });
  if (!result.ok) {
    const message = unwrapErrorCode(result.error.code, "Not authenticated");
    return { error: message ?? result.error.message };
  }
  return redactUnknownError(result.data, DECLINE_INVITATION_KNOWN_ERRORS);
}

export async function checkTermsForInvitationAction(): Promise<
  ServerActionResponse<{ needsAgreement: boolean; currentVersion: string }>
> {
  const result = await checkTermsForInvitation(undefined);
  if (!result.ok) {
    const message = unwrapErrorCode(result.error.code, "Not authenticated");
    return { error: message ?? result.error.message };
  }
  return result.data;
}

export async function getInvitationDetailsAction(
  membershipId: string,
): Promise<ServerActionResponse<InvitationDetails>> {
  const result = await getInvitationDetails({ membershipId });
  if (!result.ok) {
    const message = unwrapErrorCode(result.error.code, "Not authenticated");
    return { error: message ?? result.error.message };
  }
  return redactUnknownError(result.data, INVITATION_DETAILS_KNOWN_ERRORS);
}
