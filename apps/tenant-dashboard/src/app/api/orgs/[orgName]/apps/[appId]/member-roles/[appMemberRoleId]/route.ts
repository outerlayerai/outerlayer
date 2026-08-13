/**
 * Per-app member-role update/revoke.
 *
 * PATCH  /api/orgs/{orgName}/apps/{appId}/member-roles/{appMemberRoleId}
 * DELETE /api/orgs/{orgName}/apps/{appId}/member-roles/{appMemberRoleId}
 *
 * Thin shim — see `../route.ts` for the EE-boundary rationale shared by both
 * files.
 *
 * A PATCH body carries either `{ role }` (switch to a built-in role) or
 * `{ customRoleId }` (switch to a custom-role override) — the two map to
 * different actions/permissions on the service
 * (`updateAppRoleAction` / `updateAppCustomRoleAction`), so the route
 * dispatches on which key the body sends.
 */

import 'server-only';
import { z } from 'zod';
import { withApi } from '@/lib/api/with-api';
import { EntitlementForbiddenResponseSchema } from '@/lib/api/entitlement-response';
import { rejectManagementApiKeyBearer } from '@/lib/api/reject-management-api-key-bearer';
import { updateMemberRoleBuiltin, updateMemberRoleCustom, revokeMemberRole } from '@ee/features/app-access/http';

const MemberRoleParamsSchema = z.object({
  orgName: z.string().min(1),
  appId: z.string().min(1),
  appMemberRoleId: z.string().min(1),
});

const UpdateBodySchema = z
  .object({
    role: z.enum(['read', 'write', 'admin']).optional(),
    customRoleId: z.string().min(1).optional(),
  })
  .refine((body) => (body.role !== undefined) !== (body.customRoleId !== undefined), {
    message: 'Provide exactly one of `role` or `customRoleId`',
  });

/** `AppMemberRoleRow` (`types/app-member-role.ts`) — the raw `app_member_role` table row `update` returns. */
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

/** `AppMemberRoleService.revoke` (`ee/features/app-access/app-member-role-service.ts`) returns a bare ack, not the deleted row. */
const RevokeResultSchema = z.object({ success: z.boolean() });

export const PATCH = withApi(
  {
    method: 'patch',
    path: '/api/orgs/{orgName}/apps/{appId}/member-roles/{appMemberRoleId}',
    tags: ['App Member Roles'],
    summary: 'Update a per-app role assignment',
    operationId: 'update-app-member-role',
    description:
      'Switches an existing per-app role assignment to a different built-in role (`role`) or a custom-role ' +
      'override (`customRoleId`) — exactly one of the two. Requires the `app_level_roles` entitlement — on a ' +
      'self-hosted or unlicensed org without it, this fails closed with 403 and `error.reason: ' +
      '"entitlement_denied"` rather than applying the change.',
    authRequired: false,
    request: { params: MemberRoleParamsSchema, body: UpdateBodySchema },
    responses: {
      200: { description: 'The updated app-member-role row.', schema: AppMemberRoleRowSchema },
      400: { description: 'Neither or both of `role`/`customRoleId` given.' },
      401: { description: 'Not authenticated. Management API keys are not supported on this endpoint — session only.' },
      403: {
        description:
          'Lacks `app_member_role.update` (plain `forbidden`), or the `app_level_roles` entitlement is absent ' +
          '(`forbidden` with `reason: "entitlement_denied"` and an `entitlement` upgrade payload).',
        schema: EntitlementForbiddenResponseSchema,
      },
    },
  },
  async ({ request, input }) => {
    rejectManagementApiKeyBearer(request);
    const { role, customRoleId } = input.body;
    return role !== undefined
      ? updateMemberRoleBuiltin(input.params.appMemberRoleId, role)
      : updateMemberRoleCustom(input.params.appMemberRoleId, customRoleId as string);
  },
);

export const DELETE = withApi(
  {
    method: 'delete',
    path: '/api/orgs/{orgName}/apps/{appId}/member-roles/{appMemberRoleId}',
    tags: ['App Member Roles'],
    summary: 'Revoke a per-app role assignment',
    operationId: 'revoke-app-member-role',
    description:
      'Revokes a per-app role assignment; the membership falls back to its org-level role for the app. ' +
      'Requires the `app_level_roles` entitlement — on a self-hosted or unlicensed org without it, this fails ' +
      'closed with 403 and `error.reason: "entitlement_denied"` rather than revoking the assignment.',
    authRequired: false,
    request: { params: MemberRoleParamsSchema },
    responses: {
      200: { description: 'Acknowledgement of the revoke — not the deleted row.', schema: RevokeResultSchema },
      401: { description: 'Not authenticated. Management API keys are not supported on this endpoint — session only.' },
      403: {
        description:
          'Lacks `app_member_role.delete` (plain `forbidden`), or the `app_level_roles` entitlement is absent ' +
          '(`forbidden` with `reason: "entitlement_denied"` and an `entitlement` upgrade payload).',
        schema: EntitlementForbiddenResponseSchema,
      },
    },
  },
  async ({ request, input }) => {
    rejectManagementApiKeyBearer(request);
    return revokeMemberRole(input.params.appMemberRoleId);
  },
);
