/**
 * Org member list — REST counterpart of the members settings page. Returns
 * active memberships and pending invites for the resolved request tenant.
 *
 * Canonical tenant-scoped URL: living under `/api/orgs/[orgName]/…` lets the
 * middleware derive the tenant from the URL org and thread it as the request
 * tenant, per the dashboard's tenancy contract.
 */
import "server-only";
import { withApi } from "@/lib/api/with-api";
import { OrgNameParamsSchema } from "@/lib/analytics/singletons/zod-schemas";
import { loadMembersForApi } from "@/features/members/read";

export const GET = withApi(
  {
    method: "get",
    path: "/api/orgs/{orgName}/members",
    tags: ["Members"],
    summary: "List org members and pending invites",
    operationId: "list-members",
    description:
      "Returns active memberships and pending invites for the resolved request tenant. Requires `membership.read`.",
    request: { params: OrgNameParamsSchema },
    responses: {
      200: { description: "`{ members: TenantMember[] }`." },
      401: { description: "Not authenticated." },
      403: { description: "Missing `membership.read`." },
    },
    // Org-scoped, not app-scoped: `withApi`'s built-in auth requires an
    // `appId` query param, which has no meaning here. Auth is resolved
    // manually via `requireMembershipContext` instead.
    authRequired: false,
  },
  async ({ input }) => {
    const members = await loadMembersForApi(input.params.orgName);
    return { members };
  },
);
