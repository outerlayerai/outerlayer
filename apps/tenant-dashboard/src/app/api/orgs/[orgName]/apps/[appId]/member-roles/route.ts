/**
 * Per-app member-role list/assign.
 *
 * GET  /api/orgs/{orgName}/apps/{appId}/member-roles?membershipId=...
 * POST /api/orgs/{orgName}/apps/{appId}/member-roles
 *
 * Thin shim: all auth, permission gating, and the `app_level_roles`
 * entitlement check run inside `@ee/features/app-access` — see `./http.ts`
 * there — so a self-hosted (AGPL) build carries no paid-feature
 * implementation here. `withApi`'s built-in session auth is app-scoped (it
 * resolves access via an `appId` query param) but assigning per-app access is
 * an org-level operation on the target membership, not an app-scoped one
 * (see `@ee/features/app-access/actions.ts`) — these routes disable it and
 * rely entirely on the delegated action's own auth.
 */

import 'server-only';
import { z } from 'zod';
import { withApi } from '@/lib/api/with-api';
import { EntitlementForbiddenResponseSchema } from '@/lib/api/entitlement-response';
import { rejectAdminApiKeyBearer } from '@/lib/api/reject-admin-api-key-bearer';
import { listMemberRoles, assignMemberRole } from '@ee/features/app-access/http';
import { assignAppRoleInputSchema } from '@ee/features/app-access/schemas';

const AppParamsSchema = z.object({ orgName: z.string().min(1), appId: z.string().min(1) });
const ListQuerySchema = z.object({ membershipId: z.string().min(1).optional() });
const AssignBodySchema = assignAppRoleInputSchema.omit({ appId: true });

/** `AppMemberRoleRow` (`lib/system/app-access-reads.ts`) — the read-model shape: joined app name + member name/email, not the raw table row. */
const AppMemberRoleListItemSchema = z.object({
  id: z.string(),
  membershipId: z.string(),
  appId: z.string(),
  appName: z.string(),
  role: z.enum(['read', 'write', 'admin']).nullable(),
  memberName: z.string(),
  memberEmail: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

/** `AppMemberRoleRow` (`types/app-member-role.ts`) — the raw `app_member_role` table row `assign`/`update`/`revoke` write and return. */
const AppMemberRoleRowSchema = z.object({
  id: z.string(),
  membership_id: z.string(),
  app_id: z.string(),
  tenant_id: z.string(),
  role: z.enum(['read', 'write', 'admin']),
  custom_role_id: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
});

export const GET = withApi(
  {
    method: 'get',
    path: '/api/orgs/{orgName}/apps/{appId}/member-roles',
    tags: ['App Member Roles'],
    summary: 'List per-app role assignments',
    operationId: 'list-app-member-roles',
    description:
      'Lists per-app role assignments for the app, optionally filtered to one membership. Not gated by the ' +
      '`app_level_roles` entitlement — only by `app_member_role.read` — so an unlicensed org can still see ' +
      'assignments it created before downgrading.',
    authRequired: false,
    request: { params: AppParamsSchema, query: ListQuerySchema },
    responses: {
      200: { description: 'App-member-role assignment list.', schema: z.array(AppMemberRoleListItemSchema) },
      401: { description: 'Not authenticated. Admin API keys are not supported on this endpoint — session only.' },
      403: { description: 'Lacks `app_member_role.read`.' },
    },
  },
  async ({ request, input }) => {
    rejectAdminApiKeyBearer(request);
    return listMemberRoles(input.params.appId, input.query.membershipId);
  },
);

export const POST = withApi(
  {
    method: 'post',
    path: '/api/orgs/{orgName}/apps/{appId}/member-roles',
    tags: ['App Member Roles'],
    summary: 'Assign a per-app role',
    operationId: 'assign-app-member-role',
    description:
      'Assigns a built-in per-app role (read/write/admin) to a membership. Requires the `app_level_roles` ' +
      'entitlement — on a self-hosted or unlicensed org without it, this fails closed with 403 and ' +
      '`error.reason: "entitlement_denied"` rather than creating the assignment.',
    authRequired: false,
    request: { params: AppParamsSchema, body: AssignBodySchema },
    responses: {
      201: { description: 'The created app-member-role row.', schema: AppMemberRoleRowSchema },
      400: { description: 'Invalid body, or the target membership is an org owner.' },
      401: { description: 'Not authenticated. Admin API keys are not supported on this endpoint — session only.' },
      403: {
        description:
          'Lacks `app_member_role.insert` (plain `forbidden`), or the `app_level_roles` entitlement is absent ' +
          '(`forbidden` with `reason: "entitlement_denied"` and an `entitlement` upgrade payload).',
        schema: EntitlementForbiddenResponseSchema,
      },
    },
  },
  async ({ request, input }) => {
    rejectAdminApiKeyBearer(request);
    return assignMemberRole(input.params.appId, input.body.membershipId, input.body.role);
  },
);
