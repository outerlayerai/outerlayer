"use client";

import { useParams } from "next/navigation";
import { useMemberships } from "@/lib/adapters/use-memberships";

/**
 * The tenant id of the org in the current URL (`/orgs/[orgName]/…`), resolved
 * through the signed-in user's own active memberships — the same URL-authored
 * source the server middleware uses. Undefined when the path carries no org or
 * the user is not an active member of it; callers then send no `X-Tenant-Id`
 * and the gateway falls back to the session claim.
 *
 * This is the browser counterpart to the server-side `getRequestTenantId()`:
 * it lets a browser gateway call name the org the user is actually viewing,
 * rather than trusting the session-global claim.
 */
export function useUrlTenantId(): string | undefined {
  const params = useParams<{ orgName?: string | string[] }>();
  const raw = params?.orgName;
  const orgName = Array.isArray(raw) ? raw[0] : raw;
  const { getMembershipByOrgName } = useMemberships();
  if (!orgName) return undefined;
  return getMembershipByOrgName(orgName)?.tenant_id ?? undefined;
}
