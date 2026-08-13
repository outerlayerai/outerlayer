/**
 * Resend a pending invite — REST counterpart of `resendInviteAction`
 * (`src/features/members/actions.ts`). Addressed by membership id (the
 * natural REST identifier for a pending invite); `MembershipService`'s
 * `resendInviteLink` keys off email, so the route resolves the invite's email
 * first and 404s if the id doesn't name a pending invite in this tenant.
 */
import "server-only";
import { headers } from "next/headers";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@repo/observability-service";
import { withApi } from "@/lib/api/with-api";
import { OrgNameParamsSchema } from "@/lib/analytics/singletons/zod-schemas";
import { requireMembershipContext } from "@/features/members/request-context";
import { findPendingInviteByMembershipId } from "@/features/members/read";
import { Permissions } from "@/utils/permissions";
import { resendMemberInvite } from "@/lib/adapters";

const Params = OrgNameParamsSchema.extend({ inviteId: z.string().min(1) });

async function requestOrigin(): Promise<string> {
  const headersList = await headers();
  return headersList.get("origin") ?? "";
}

export const POST = withApi(
  {
    method: "post",
    path: "/api/orgs/{orgName}/members/invites/{inviteId}/resend",
    tags: ["Members"],
    summary: "Resend a pending invite",
    operationId: "resend-member-invite",
    description: "Resends the invite email for a pending membership. Requires `membership.insert`.",
    request: { params: Params },
    remapNotFound: "invite_not_found",
    responses: {
      200: { description: "`{ success: true }`." },
      401: { description: "Not authenticated." },
      403: { description: "Missing `membership.insert`." },
      404: { description: "No pending invite with that id in this org." },
    },
    authRequired: false,
  },
  async ({ input }) => {
    const ctx = await requireMembershipContext(Permissions.MEMBERSHIP_INSERT, input.params.orgName);
    const invite = await findPendingInviteByMembershipId(ctx.tenantId, input.params.inviteId);
    if (!invite) {
      throw new NotFoundError("Pending invite not found");
    }

    const result = await resendMemberInvite({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      email: invite.email,
      origin: await requestOrigin(),
    });

    if (!result.success) {
      throw new ValidationError(result.error ?? "Resend failed");
    }
    return { success: true };
  },
);
