"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { User } from "@supabase/supabase-js";

import { preTenantAction } from "@/lib/action-kit";
import { switchActiveOrg, countActiveMemberships, createNewOrganization } from "@/lib/adapters";
import { getActiveTempAccessGrant } from "@/lib/system/temp-access-grant";
import type { ServerActionResponse } from "@/types/server-action";
import { setLastActiveOrgInput, createOrganizationInput, getTempAccessStatusInput } from "./schemas";

/**
 * Every action here runs pre-tenant: switching, creating, or counting a
 * user's organizations, and checking a platform admin's temporary grant to a
 * tenant they are explicitly not a member of, all act across tenants rather
 * than within one already-resolved tenant. `preTenantAction` enforces the
 * authentication so no handler repeats it by hand, and withholds
 * `db`/`tenantId` — a tenant-scoped need belongs in `authorizedAction`, not
 * here. Handlers return the `ServerActionResponse` shape;
 * `action-adapters.ts` unwraps the `preTenantAction` envelope around it
 * for client callers.
 */

/**
 * Records the org as the user's last-active preference, verifying active
 * membership first. This is a preference write, not a session mutation —
 * switching orgs is a navigation, so the caller is expected to route to the
 * new org's URL rather than wait on a session refresh.
 */
export const setLastActiveOrg = preTenantAction({
  input: setLastActiveOrgInput,
  reason: "cross-tenant",
  handler: async (actor, { tenantId }): Promise<ServerActionResponse<{ tenantId: string }>> => {
    const result = await switchActiveOrg({ user: actor.raw as User, tenantId });

    if (!result.success) {
      return { error: result.error };
    }

    revalidatePath("/orgs");
    return { data: { tenantId: result.tenantId! } };
  },
});

/**
 * Get the count of active memberships for a user
 * Used to check against the 10-org limit
 */
export const getMembershipCount = preTenantAction({
  input: z.void(),
  reason: "user-scoped",
  handler: async (actor): Promise<ServerActionResponse<number>> => {
    const result = await countActiveMemberships(actor.raw as User);

    if (!result.success) {
      return { error: result.error };
    }

    return { data: result.count! };
  },
});

/**
 * createOrganization server action
 * Checks the org limit (count of active memberships < 10) before creation,
 * creates the tenant record with created_by = current user, creates the
 * membership record with status='active' and role='owner' for the new
 * owner, and auto-switches to the new org after creation.
 *
 * Also creates:
 * - Stripe customer for billing
 * - Billing record linking tenant to Stripe customer
 */
export const createOrganization = preTenantAction({
  input: createOrganizationInput,
  reason: "no-tenant-yet",
  handler: async (
    actor,
    { organizationName, companyName },
  ): Promise<ServerActionResponse<{ tenantId: string; organizationName: string }>> => {
    const result = await createNewOrganization({
      user: actor.raw as User,
      organizationName,
      companyName,
    });

    if (!result.success) {
      return { error: result.error };
    }

    revalidatePath("/orgs");
    return {
      data: {
        tenantId: result.tenantId!,
        organizationName: result.organizationName!,
      },
    };
  },
});

/**
 * Check if the current user has an active temporary access grant for a tenant.
 * Used to show a banner when platform admins are viewing a customer's org.
 *
 * `preTenantAction` only authenticates — authorization for the caller-supplied
 * `tenantId` lives entirely in `getActiveTempAccessGrant`'s own
 * `created_by = userId AND tenant_id = tenantId` predicate (see its doc
 * comment): the query can only ever surface a grant that belongs to this
 * exact caller, so a non-admin probing arbitrary tenant ids always gets
 * `null` — there is nothing here for `authorizedAction`'s membership-checked
 * resolver to add.
 */
export const getTempAccessStatus = preTenantAction({
  input: getTempAccessStatusInput,
  reason: "cross-tenant",
  handler: async (
    actor,
    { tenantId },
  ): Promise<
    ServerActionResponse<{
      hasAccess: boolean;
      grantId?: string;
      organizationName?: string;
      expiresAt?: string;
      timeRemainingMinutes?: number;
    } | null>
  > => {
    const grant = await getActiveTempAccessGrant({ tenantId, userId: actor.userId });

    if (!grant) {
      return { data: null };
    }

    const expiresAt = new Date(grant.expiresAt);
    const timeRemainingMinutes = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000));

    return {
      data: {
        hasAccess: true,
        grantId: grant.id,
        organizationName: grant.companyName || grant.organizationName,
        expiresAt: grant.expiresAt,
        timeRemainingMinutes,
      },
    };
  },
});
