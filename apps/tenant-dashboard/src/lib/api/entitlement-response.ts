/**
 * OpenAPI response shape for a route that can 403 for two distinct reasons:
 * the caller lacks the declared permission, or (for a paid-tier-gated
 * mutation) the org's plan doesn't include the feature. Both use the
 * canonical `forbidden` error code — `reason`/`entitlement` only appear on
 * the entitlement-denied case, so they're optional here. Mirrors
 * `EntitlementDeniedInfo` (`config/entitlements.ts`), the shape every EE
 * service's `checkEntitlement()` gate returns.
 */

import 'server-only';
import { z } from 'zod';

const EntitlementDeniedSchema = z.object({
  featureKey: z.string(),
  featureDisplayName: z.string(),
  requiredTier: z.string(),
  requiredTierDisplayName: z.string(),
  isSelfServe: z.boolean(),
  pricing: z.string().nullable(),
  upgradeUrl: z.string(),
  currentLimit: z.number().nullable(),
  requiredTierLimit: z.number().nullable(),
});

export const EntitlementForbiddenResponseSchema = z.object({
  error: z.object({
    code: z.literal('forbidden'),
    message: z.string(),
    reason: z.literal('entitlement_denied').optional(),
    entitlement: EntitlementDeniedSchema.optional(),
  }),
});
