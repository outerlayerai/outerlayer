import "server-only";
import { createClient, SupabaseClient, type User } from "@supabase/supabase-js";
import { SUPABASE_API } from "@/config-global";
import { SUPABASE_SECRET_KEY, BILLING_ENABLED } from "@/config-global.server";
import { createBillingService, resolveBillingConfig } from "@/lib/adapters";
import type { Database } from "@/types/db";
import { TermsAgreementService } from "./terms-agreement";
import {
  OrganizationService,
  type AcceptInviteResult,
  type DeclineInviteResult,
  type InvitationDetails,
} from "./organization-service";

function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(`${SUPABASE_API.url}`, `${SUPABASE_SECRET_KEY}`, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Whether a user needs to agree to terms before the invitation flow lets
 * them proceed, under the service-role client (a pending invitee has no
 * tenant membership yet, so no RLS-scoped client is available to read their
 * own `terms_agreement` history with).
 *
 * Non-blocking policy: a user with ANY existing agreement — any version —
 * is never blocked; only a user with no agreement at all needs one. A thin
 * wrapper over `TermsAgreementService.hasAnyAgreement`, which owns the query
 * and throws on a read failure rather than returning a boolean — the caller
 * (`checkTermsForInvitation`) is what turns that throw into "needs agreement".
 */
export async function checkNeedsTermsAgreement(userId: string): Promise<boolean> {
  const service = new TermsAgreementService({ supabaseAdmin: adminClient() });
  const hasAgreement = await service.hasAnyAgreement(userId);
  return !hasAgreement;
}

/**
 * The service-role client backing `OrganizationService` — org create/switch/
 * accept-invite each run several distinct memberships/tenant/billing
 * operations and already own their authorization checks internally (active-
 * membership checks, invitee-identity checks, the org-limit count), so a
 * single general-purpose client is the sanctioned shape here rather than a
 * named per-query function. Confined to `lib/system/` like every other
 * service-role construction; `OrganizationService` itself stays a plain,
 * dependency-injected class (unit-testable with a mock client).
 */
export function getOrganizationAdminClient(): SupabaseClient<Database> {
  return adminClient();
}

/**
 * `OrganizationService` bound to the service-role client only — no
 * `supabaseServer`. The invite-acceptance and invitation-detail reads never
 * scope to a session client (a pending invitee has no active membership to
 * authorize one under), so there is nothing to inject there.
 */
function organizationServiceForInvite(): OrganizationService {
  return new OrganizationService({
    supabaseAdmin: adminClient(),
    supabaseServer: null,
    stripeService: createBillingService(),
    billingEnabled: resolveBillingConfig({ BILLING_ENABLED }).enabled,
  });
}

/**
 * Accepts a pending invitation on behalf of an explicitly verified subject.
 * Takes `userId`/`email` rather than a full `User`, so a pre-tenant caller
 * (which never resolves one — see `PreTenantActor`) has nothing wider to
 * pass than what it actually has.
 */
export async function acceptInvitationForUser(
  subject: { userId: string; email: string | null },
  membershipId: string,
): Promise<AcceptInviteResult> {
  const service = organizationServiceForInvite();
  const user = { id: subject.userId, email: subject.email } as User;
  return service.acceptInvitation({ user, membershipId });
}

/**
 * Declines a pending invitation on behalf of an explicitly verified subject.
 * Same rationale as `acceptInvitationForUser`.
 */
export async function declineInvitationForUser(
  subject: { userId: string; email: string | null },
  membershipId: string,
): Promise<DeclineInviteResult> {
  const service = organizationServiceForInvite();
  const user = { id: subject.userId, email: subject.email } as User;
  return service.declineInvitation({ user, membershipId });
}

/**
 * Reads pending-invitation details on behalf of an explicitly verified
 * subject. Same rationale as `acceptInvitationForUser`.
 */
export async function getInvitationDetailsForUser(
  subject: { userId: string },
  membershipId: string,
): Promise<{ success: boolean; error?: string; data?: InvitationDetails }> {
  const service = organizationServiceForInvite();
  const user = { id: subject.userId } as User;
  return service.getInvitationDetails({ user, membershipId });
}
