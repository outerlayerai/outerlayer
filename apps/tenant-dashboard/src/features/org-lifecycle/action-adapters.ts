import type { ServerActionResponse } from "@/types/server-action";
// Imported from the dependency-free result module, NOT the action-kit barrel:
// this file is part of the org switcher and temp-access banner's Client
// Component import graph, and the barrel pulls the wrapper's server-only
// dependencies (request context, Supabase server client) into the client
// bundle, which breaks the production build.
import { ActionErrorCodes, type ActionResult } from "@/lib/action-kit/result";

import { setLastActiveOrg, getMembershipCount, createOrganization, getTempAccessStatus } from "./actions";

const GENERIC_SERVER_ERROR = "Something went wrong. Please try again.";

/**
 * Client-facing adapters over the pre-tenant org-lifecycle server actions.
 * Each raw action resolves to a `preTenantAction` envelope; the handler's own
 * return already matches the `ServerActionResponse` shape callers have always
 * consumed, so on `ok` the payload passes through unchanged. Only the two
 * transport-level failure codes (validation never fires — every handler here
 * takes a scalar or void input) need mapping, onto the exact strings callers
 * already match on.
 */
function unwrap<T>(result: ActionResult<ServerActionResponse<T>>): ServerActionResponse<T> {
  if (!result.ok) {
    if (result.error.code === ActionErrorCodes.UNAUTHENTICATED) {
      return { error: "Not authenticated" };
    }
    return { error: GENERIC_SERVER_ERROR };
  }
  return result.data;
}

export async function setLastActiveOrgAction(
  tenantId: string,
): Promise<ServerActionResponse<{ tenantId: string }>> {
  return unwrap(await setLastActiveOrg({ tenantId }));
}

export async function getMembershipCountAction(): Promise<ServerActionResponse<number>> {
  return unwrap(await getMembershipCount(undefined));
}

export async function createOrganizationAction(
  organizationName: string,
  companyName: string,
): Promise<ServerActionResponse<{ tenantId: string; organizationName: string }>> {
  return unwrap(await createOrganization({ organizationName, companyName }));
}

export async function getTempAccessStatusAction(
  tenantId: string,
): Promise<
  ServerActionResponse<{
    hasAccess: boolean;
    grantId?: string;
    organizationName?: string;
    expiresAt?: string;
    timeRemainingMinutes?: number;
  } | null>
> {
  return unwrap(await getTempAccessStatus({ tenantId }));
}
