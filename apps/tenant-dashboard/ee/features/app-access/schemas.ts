import { z } from "zod";

const appMemberRoleSchema = z.enum(["read", "write", "admin"]);

export const assignAppRoleInputSchema = z.object({
  membershipId: z.string().min(1),
  appId: z.string().min(1),
  role: appMemberRoleSchema,
});

export const updateAppRoleInputSchema = z.object({
  appMemberRoleId: z.string().min(1),
  role: appMemberRoleSchema,
});

export const updateAppCustomRoleInputSchema = z.object({
  appMemberRoleId: z.string().min(1),
  customRoleId: z.string().min(1),
});

export const revokeAppRoleInputSchema = z.object({
  appMemberRoleId: z.string().min(1),
});

export const setAppScopedInputSchema = z.object({
  membershipId: z.string().min(1),
  isAppScoped: z.boolean(),
});

export const getAppScopedStatusInputSchema = z.object({
  membershipId: z.string().min(1),
});

export const listAppRolesInputSchema = z.object({
  membershipId: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
});

export const listAppsForDropdownInputSchema = z.object({});
