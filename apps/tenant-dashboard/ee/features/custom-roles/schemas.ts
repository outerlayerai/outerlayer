import { z } from "zod";

const permissionsSchema = z.array(z.string().min(1)).min(1);

export const createCustomRoleInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  permissions: permissionsSchema,
});

export const updateCustomRoleInputSchema = z.object({
  roleId: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  permissions: permissionsSchema.optional(),
});

export const deleteCustomRoleInputSchema = z.object({
  roleId: z.string().min(1),
  fallbackRole: z.string().min(1).optional(),
});

export const getCustomRoleInputSchema = z.object({
  roleId: z.string().min(1),
});

export const listCustomRolesInputSchema = z.object({});
