import { z } from "zod";

export const revokeOAuthGrantInput = z.object({
  sessionId: z.string().min(1),
});
