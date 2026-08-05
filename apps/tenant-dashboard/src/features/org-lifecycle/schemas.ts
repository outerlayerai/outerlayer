import { z } from "zod";

/**
 * Server-action input schemas for `features/org-lifecycle/actions.ts`. Kept
 * permissive (no `min`/format constraints beyond `string`/`void`) — these
 * actions never validated their arguments before `preTenantAction` required
 * a schema, and adding constraints here would silently start rejecting
 * inputs the pre-migration functions accepted.
 */
export const setLastActiveOrgInput = z.object({
  tenantId: z.string(),
});

export const createOrganizationInput = z.object({
  organizationName: z.string(),
  companyName: z.string(),
});

export const getTempAccessStatusInput = z.object({
  tenantId: z.string(),
});
