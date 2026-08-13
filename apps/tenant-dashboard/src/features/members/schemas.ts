import { z } from "zod";

/** `UserRoleEnum` mirrored as a zod literal union — `disabled` is a valid
 *  target role for `changeMemberRole` (it does not delete the membership). */
const userRoleSchema = z.enum(["owner", "admin", "write", "read", "disabled"]);

const appMemberRoleSchema = z.enum(["read", "write", "admin"]);

export const sendInviteInputSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().min(1).email(),
  role: userRoleSchema,
  appRoles: z
    .array(z.object({ appId: z.string().min(1), role: appMemberRoleSchema }))
    .optional(),
  customRoleId: z.string().min(1).optional(),
});

export const resendInviteInputSchema = z.object({
  email: z.string().min(1).email(),
});

export const changeMemberRoleInputSchema = z.object({
  role: userRoleSchema,
  customRoleId: z.string().min(1).nullable().optional(),
  userId: z.string().min(1),
});

export const removeMemberInputSchema = z.object({
  userId: z.string().min(1),
});
