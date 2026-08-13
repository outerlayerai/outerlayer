import "server-only";

import type { TenantMember } from "@/lib/system";
import { Permissions } from "@/utils/permissions";

import { requireMembershipContext } from "./request-context";
import { listMembers } from "./service";

/**
 * The members-list API read: session + `membership.read`-gated, tenant from
 * the resolved request context. Distinct from the RSC settings page, which
 * calls `listMembers` directly under the page's own access control.
 */
export async function loadMembersForApi(orgName: string): Promise<TenantMember[]> {
  const ctx = await requireMembershipContext(Permissions.MEMBERSHIP_READ, orgName);
  return listMembers(ctx.tenantId);
}

/**
 * Resolves a pending invite's email from its membership id. The resend route
 * addresses invites by membership id (the natural REST identifier for a
 * pending invite), but `MembershipService.resendInviteLink` keys off email —
 * this bridges the two without changing the service's public contract.
 */
export async function findPendingInviteByMembershipId(
  tenantId: string,
  membershipId: string,
): Promise<TenantMember | undefined> {
  const members = await listMembers(tenantId);
  return members.find(
    (member) => member.membershipId === membershipId && member.membershipStatus === "pending",
  );
}
