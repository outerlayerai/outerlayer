import { z } from "zod";

export const createAdminApiKeyInput = z.object({
  name: z.string().min(1),
  permissions: z.array(z.string()).min(1),
  /** ISO timestamp; omitted = never expires. */
  expiresAt: z.string().datetime().optional(),
});

export const revokeAdminApiKeyInput = z.object({
  id: z.string(),
});
