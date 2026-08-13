/**
 * Built-in org role catalog — feeds the invite/role-change pickers for API
 * consumers. Custom roles are a separate, entitlement-gated resource
 * (`ee/features/custom-roles`); this route serves only the five built-in
 * `app_role` values, open per `ee/README.md`.
 */
import "server-only";
import { withApi } from "@/lib/api/with-api";
import { OrgNameParamsSchema } from "@/lib/analytics/singletons/zod-schemas";
import { requireOrgContext } from "@/features/members/request-context";
import { BUILT_IN_ROLES } from "@/features/members/roles";

export const GET = withApi(
  {
    method: "get",
    path: "/api/orgs/{orgName}/roles",
    tags: ["Members"],
    summary: "List built-in org roles",
    operationId: "list-roles",
    description:
      "Static catalog of the built-in org roles (owner/admin/write/read/disabled).",
    request: { params: OrgNameParamsSchema },
    responses: {
      200: { description: "`{ roles: BuiltInRole[] }`." },
      401: { description: "Not authenticated." },
    },
    authRequired: false,
  },
  async ({ input }) => {
    // A static, tenant-independent catalog — any authenticated org member
    // may read it, so this checks auth only, no `Permissions.*` gate.
    await requireOrgContext(input.params.orgName);
    return { roles: BUILT_IN_ROLES };
  },
);
