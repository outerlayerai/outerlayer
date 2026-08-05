import { z } from "zod";

export const emptyInputSchema = z.object({});

export const saveSSOConfigInputSchema = z.object({
  metadataUrl: z.url(),
  allowedDomains: z.array(z.string()),
});

export const toggleSSOActiveInputSchema = z.object({
  active: z.boolean(),
});

export const toggleSSOEnforcementInputSchema = z.object({
  enforced: z.boolean(),
});
