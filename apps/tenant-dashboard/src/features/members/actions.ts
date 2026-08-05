"use server";
import "server-only";

/**
 * Member-lifecycle mutations — invite, resend, role change, remove. Org-scoped
 * `authorizedAction`s (no `appId`): the gate is the tenant-wide `membership.*`
 * permission. `profile.*` is unusable here because every built-in role holds it
 * for self-service profile edits, so gating on it would authorize nothing. The
 * real member-lifecycle
 * protection — last-owner guard, owner-only promotion, cross-tenant rejection —
 * lives in `MembershipService` and the transaction RPCs' triggers, not this
 * gate; the permission check is the coarse door, not the whole story.
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";
import {
  sendMemberInvite,
  resendMemberInvite,
  changeMemberRole as changeMemberRoleAdapter,
  removeMember as removeMemberAdapter,
} from "@/lib/adapters";
import { Permissions } from "@/utils/permissions";
import {
  sendInviteInputSchema,
  resendInviteInputSchema,
  changeMemberRoleInputSchema,
  removeMemberInputSchema,
} from "./schemas";

async function requestOrigin(): Promise<string> {
  const headersList = await headers();
  return headersList.get("origin") ?? "";
}

export const sendInviteAction = authorizedAction({
  input: sendInviteInputSchema,
  permission: Permissions.MEMBERSHIP_INSERT,
  handler: async (ctx, input) => {
    const result = await sendMemberInvite({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      name: input.name,
      email: input.email,
      role: input.role,
      origin: await requestOrigin(),
      appRoles: input.appRoles,
      customRoleId: input.customRoleId,
    });
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const resendInviteAction = authorizedAction({
  input: resendInviteInputSchema,
  permission: Permissions.MEMBERSHIP_INSERT,
  handler: async (ctx, input) => {
    const result = await resendMemberInvite({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      email: input.email,
      origin: await requestOrigin(),
    });
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const changeMemberRoleAction = authorizedAction({
  input: changeMemberRoleInputSchema,
  permission: Permissions.MEMBERSHIP_UPDATE,
  handler: async (ctx, input) => {
    const result = await changeMemberRoleAdapter({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      targetUserId: input.userId,
      newRole: input.role,
      customRoleId: input.customRoleId,
    });
    if (result.success) revalidatePath("/settings");
    return result;
  },
});

export const removeMemberAction = authorizedAction({
  input: removeMemberInputSchema,
  permission: Permissions.MEMBERSHIP_DELETE,
  handler: async (ctx, input) => {
    const result = await removeMemberAdapter({
      tenantId: ctx.tenantId,
      actorUserId: ctx.actor.userId,
      targetUserId: input.userId,
    });
    if (result.success) revalidatePath("/settings");
    return result;
  },
});
