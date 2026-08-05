/**
 * Zod schemas for the "singleton" analytics routes — one GET per derived
 * report. The only survivor is `has-traces` (the onboarding "first data
 * landed" check); the agents product's own routes carry their schemas next
 * to their handlers.
 */

import { z } from 'zod';

const appIdField = z.string().min(1, 'appId is required');

/** GET /api/orgs/{orgName}/has-traces */
export const HasTracesQuerySchema = z.object({
  appId: appIdField,
});

/**
 * URL org path param. The middleware resolves it to the request tenant; the
 * handler does not read it (the tenant arrives via the header), but declaring
 * it keeps the OpenAPI path param and withApi route validation honest.
 */
export const OrgNameParamsSchema = z.object({
  orgName: z.string().min(1),
});
