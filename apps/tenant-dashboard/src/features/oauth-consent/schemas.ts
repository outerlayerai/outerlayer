import { z } from "zod";

export const decideOAuthConsentInput = z.object({
  authorizationId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});
