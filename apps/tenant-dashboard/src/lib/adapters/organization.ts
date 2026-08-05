import "server-only";

import type { User } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/supabaseServerClient";
import { OrganizationService, type CreateOrgResult, type SwitchOrgResult } from "@/lib/system";
import { getOrganizationAdminClient } from "@/lib/system/org-actions-admin";
import { BILLING_ENABLED } from "@/config-global.server";
import { createBillingService, resolveBillingConfig } from "./billing";

/**
 * The org-lifecycle crossing to the root Supabase server client:
 * `OrganizationService` (already homed in `lib/system`) takes a session-bound
 * client as a constructor dependency rather than building its own, so
 * whichever layer supplies that dependency is the one that has to reach
 * `@/supabaseServerClient` directly. Built fresh per call, matching how
 * `lib/adapters/membership.ts` constructs `MembershipService`.
 */
async function createOrganizationService(): Promise<OrganizationService> {
  const supabaseAdmin = getOrganizationAdminClient();
  const supabaseServer = await createSupabaseServerClient();
  const { enabled: billingEnabled } = resolveBillingConfig({ BILLING_ENABLED });
  return new OrganizationService({
    supabaseAdmin,
    supabaseServer,
    stripeService: createBillingService(),
    billingEnabled,
  });
}

export async function switchActiveOrg(params: {
  user: User;
  tenantId: string;
}): Promise<SwitchOrgResult> {
  const service = await createOrganizationService();
  return service.setLastActiveOrg(params);
}

export async function countActiveMemberships(
  user: User,
): Promise<{ success: boolean; error?: string; count?: number }> {
  const service = await createOrganizationService();
  return service.getMembershipCount(user);
}

export async function createNewOrganization(params: {
  user: User;
  organizationName: string;
  companyName: string;
}): Promise<CreateOrgResult> {
  const service = await createOrganizationService();
  return service.createOrganization(params);
}
