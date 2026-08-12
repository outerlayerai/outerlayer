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

/** Role-change fields shared by the server action (which carries the target
 *  `userId` in the same object) and the `PATCH /members/{userId}` route
 *  (which takes `userId` from the URL path instead). */
const changeRoleFieldsSchema = z.object({
  role: userRoleSchema,
  customRoleId: z.string().min(1).nullable().optional(),
});

export const changeMemberRoleInputSchema = changeRoleFieldsSchema.extend({
  userId: z.string().min(1),
});

/** `PATCH /members/{userId}` body — same fields as
 *  `changeMemberRoleInputSchema`, minus `userId`, which the route reads from
 *  the URL path. */
export const changeMemberRoleBodySchema = changeRoleFieldsSchema;

export const removeMemberInputSchema = z.object({
  userId: z.string().min(1),
});
