/**
 * Member role change / removal — REST counterparts of
 * `changeMemberRoleAction` and `removeMemberAction`
 * (`src/features/members/actions.ts`). Same permission gates; the business
 * rules (self-demotion, last-owner protection, owner-only promotion) live in
 * `MembershipService`.
 */
import "server-only";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@repo/observability-service";
import { withApi } from "@/lib/api/with-api";
import { OrgNameParamsSchema } from "@/lib/analytics/singletons/zod-schemas";
import { changeMemberRoleBodySchema } from "@/features/members/schemas";
import { requireMembershipContext } from "@/features/members/request-context";
import { Permissions } from "@/utils/permissions";
import { changeMemberRole, removeMember } from "@/lib/adapters";

const Params = OrgNameParamsSchema.extend({ userId: z.string().min(1) });

/**
 * `MembershipService` reports business-rule denials (last-owner protection,
 * owner-only rules) and "not found" lookups as `{ success: false, error }`
 * rather than throwing — this maps that string onto the route's thrown-error
 * error envelope, 404 for "not found" messages and 400 otherwise.
 */
function toApiError(message: string): Error {
  return /not found/i.test(message) ? new NotFoundError(message) : new ValidationError(message);
}

export const PATCH = withApi(
  {
    method: "patch",
    path: "/api/orgs/{orgName}/members/{userId}",
    tags: ["Members"],
    summary: "Change a member's role",
    operationId: "change-member-role",
    description: "Changes a member's built-in or custom role. Requires `membership.update`.",
    request: { params: Params, body: changeMemberRoleBodySchema },
    remapNotFound: "member_not_found",
    responses: {
      200: { description: "`{ success: true }`." },
      400: { description: "Business-rule denial (e.g. last-owner protection)." },
      401: { description: "Not authenticated." },
      403: { description: "Missing `membership.update`." },
      404: { description: "No member with that id in this org." },
    },
    authRequired: false,
  },
  async ({ input }) => {
    const ctx = await requireMembershipContext(Permissions.MEMBERSHIP_UPDATE, input.params.orgName);
    const result = await changeMemberRole({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      targetUserId: input.params.userId,
      newRole: input.body.role,
      customRoleId: input.body.customRoleId,
    });

    if (!result.success) {
      throw toApiError(result.error ?? "Role change failed");
    }
    return { success: true };
  },
);

export const DELETE = withApi(
  {
    method: "delete",
    path: "/api/orgs/{orgName}/members/{userId}",
    tags: ["Members"],
    summary: "Remove a member from the org",
    operationId: "remove-member",
    description: "Removes a member from the org. Requires `membership.delete`.",
    request: { params: Params },
    remapNotFound: "member_not_found",
    responses: {
      200: { description: "`{ success: true }`." },
      400: { description: "Business-rule denial (e.g. last-owner protection)." },
      401: { description: "Not authenticated." },
      403: { description: "Missing `membership.delete`." },
      404: { description: "No member with that id in this org." },
    },
    authRequired: false,
  },
  async ({ input }) => {
    const ctx = await requireMembershipContext(Permissions.MEMBERSHIP_DELETE, input.params.orgName);
    const result = await removeMember({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      targetUserId: input.params.userId,
    });

    if (!result.success) {
      throw toApiError(result.error ?? "Remove failed");
    }
    return { success: true };
  },
);
