/**
 * Member invite — REST counterpart of `sendInviteAction`
 * (`src/features/members/actions.ts`). Same input schema and permission gate;
 * the business rules (owner-only owner invites, entitlement caps, rate
 * limiting) live in `MembershipService.sendInvite`.
 */
import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { NotFoundError, ValidationError } from "@repo/observability-service";
import { withApi } from "@/lib/api/with-api";
import { structuredError } from "@/lib/api/error-envelope";
import { OrgNameParamsSchema } from "@/lib/analytics/singletons/zod-schemas";
import { sendInviteInputSchema } from "@/features/members/schemas";
import { requireMembershipContext } from "@/features/members/request-context";
import { Permissions } from "@/utils/permissions";
import { sendMemberInvite } from "@/lib/adapters";
import type { InviteResult } from "@/lib/system/membership-service";

async function requestOrigin(): Promise<string> {
  const headersList = await headers();
  return headersList.get("origin") ?? "";
}

/**
 * `MembershipService.sendInvite` reports a plan-tier denial as
 * `{ success: false, error: "entitlement_denied", entitlement }` — the one
 * failure mode that carries structure worth surfacing as its own error code
 * rather than a bare 400. Business-rule denials (owner-only rules, rate
 * limits) carry no extra structure and fall through to `toApiError`.
 */
function entitlementDeniedResponse(result: InviteResult): Response | null {
  if (result.error !== "entitlement_denied" || !result.entitlement) return null;
  return NextResponse.json(
    structuredError("entitlement_denied", "The org's plan does not allow this invite", {
      entitlement: result.entitlement,
    }),
    { status: 403 },
  );
}

/**
 * A "not found" message (e.g. an unresolved tenant) maps to 404; every other
 * business-rule denial (owner-only rules, rate limits) is a 400
 * field-validation-shaped denial.
 */
function toApiError(message: string): Error {
  return /not found/i.test(message) ? new NotFoundError(message) : new ValidationError(message);
}

export const POST = withApi(
  {
    method: "post",
    path: "/api/orgs/{orgName}/members/invites",
    tags: ["Members"],
    summary: "Invite a member",
    operationId: "invite-member",
    description: "Sends an org invite. Requires `membership.insert`.",
    request: { params: OrgNameParamsSchema, body: sendInviteInputSchema },
    responses: {
      200: { description: "`{ membershipId }`." },
      400: { description: "Invalid input, or a business-rule denial (e.g. only owners can invite owners)." },
      401: { description: "Not authenticated." },
      403: {
        description:
          "Missing `membership.insert`, or the org's plan denies this invite (`entitlement_denied`, with `{ entitlement }` extras).",
      },
    },
    authRequired: false,
  },
  async ({ input }) => {
    const ctx = await requireMembershipContext(Permissions.MEMBERSHIP_INSERT);
    const result = await sendMemberInvite({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      name: input.body.name,
      email: input.body.email,
      role: input.body.role,
      origin: await requestOrigin(),
      appRoles: input.body.appRoles,
      customRoleId: input.body.customRoleId,
    });

    if (!result.success) {
      const entitlementResponse = entitlementDeniedResponse(result);
      if (entitlementResponse) return entitlementResponse;
      throw toApiError(result.error ?? "Invite failed");
    }
    return { membershipId: result.membershipId };
  },
);
