/**
 * Custom-role detail — get/update/delete.
 *
 * GET    /api/orgs/{orgName}/custom-roles/{roleId}
 * PATCH  /api/orgs/{orgName}/custom-roles/{roleId}
 * DELETE /api/orgs/{orgName}/custom-roles/{roleId}?fallbackRole=...
 *
 * Thin shim — see `../route.ts` for the EE-boundary rationale shared by both
 * files.
 *
 * Delete accepts `fallbackRole` as a query param, not a body: a role with
 * assigned members must be reassigned somewhere on delete
 * (`CustomRoleService.delete`), and query params keep that optional
 * disambiguator out of a DELETE body some HTTP clients drop.
 */

import 'server-only';
import { z } from 'zod';
import { withApi } from '@/lib/api/with-api';
import { EntitlementForbiddenResponseSchema } from '@/lib/api/entitlement-response';
import { rejectManagementApiKeyBearer } from '@/lib/api/reject-management-api-key-bearer';
import { getCustomRole, updateCustomRole, deleteCustomRole } from '@ee/features/custom-roles/http';
import { updateCustomRoleInputSchema } from '@ee/features/custom-roles/schemas';

const RoleParamsSchema = z.object({ orgName: z.string().min(1), roleId: z.string().min(1) });
const UpdateBodySchema = updateCustomRoleInputSchema.omit({ roleId: true });
const DeleteQuerySchema = z.object({ fallbackRole: z.string().min(1).optional() });

/** `CustomRoleWithPermissions` (`ee/features/custom-roles/custom-role-service.ts`) — same shape `POST`/`PATCH` return. */
const CustomRoleSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  permissions: z.array(z.string()),
  memberCount: z.number(),
});

/** `CustomRoleDetail` — the same base row, but with the assigned-member list in place of a bare count. */
const CustomRoleDetailSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  permissions: z.array(z.string()),
  members: z.array(z.object({ membershipId: z.string(), userName: z.string(), userEmail: z.string() })),
});

const DeleteResultSchema = z.object({ deleted: z.literal(true), membersReassigned: z.number() });

export const GET = withApi(
  {
    method: 'get',
    path: '/api/orgs/{orgName}/custom-roles/{roleId}',
    tags: ['Custom Roles'],
    summary: 'Get a custom role',
    operationId: 'get-custom-role',
    description:
      'Returns a custom role with its permissions and assigned members. Not gated by the `custom_roles` ' +
      'entitlement — only by `custom_role.read` — matching the list endpoint.',
    authRequired: false,
    request: { params: RoleParamsSchema },
    responses: {
      200: { description: 'The custom role.', schema: CustomRoleDetailSchema },
      401: { description: 'Not authenticated. Management API keys are not supported on this endpoint — session only.' },
      403: { description: 'Lacks `custom_role.read`.' },
    },
  },
  async ({ request, input }) => {
    rejectManagementApiKeyBearer(request);
    return getCustomRole(input.params.roleId);
  },
);

export const PATCH = withApi(
  {
    method: 'patch',
    path: '/api/orgs/{orgName}/custom-roles/{roleId}',
    tags: ['Custom Roles'],
    summary: 'Update a custom role',
    operationId: 'update-custom-role',
    description:
      'Updates a custom role\'s name, description, and/or permission set. Requires the `custom_roles` ' +
      'entitlement — on a self-hosted or unlicensed org without it, this fails closed with 403 and ' +
      '`error.reason: "entitlement_denied"` rather than applying the update.',
    authRequired: false,
    request: { params: RoleParamsSchema, body: UpdateBodySchema },
    responses: {
      200: { description: 'The updated custom role.', schema: CustomRoleSchema },
      400: { description: 'Invalid body, or a role with this name already exists.' },
      401: { description: 'Not authenticated. Management API keys are not supported on this endpoint — session only.' },
      403: {
        description:
          'Lacks `custom_role.update` (plain `forbidden`), or the `custom_roles` entitlement is absent ' +
          '(`forbidden` with `reason: "entitlement_denied"` and an `entitlement` upgrade payload).',
        schema: EntitlementForbiddenResponseSchema,
      },
    },
  },
  async ({ request, input }) => {
    rejectManagementApiKeyBearer(request);
    return updateCustomRole(input.params.roleId, input.body);
  },
);

export const DELETE = withApi(
  {
    method: 'delete',
    path: '/api/orgs/{orgName}/custom-roles/{roleId}',
    tags: ['Custom Roles'],
    summary: 'Delete a custom role',
    operationId: 'delete-custom-role',
    description:
      'Deletes a custom role. If members are still assigned, `fallbackRole` (a built-in role, or `custom:<id>`) ' +
      'is required and they are reassigned to it. Requires the `custom_roles` entitlement — on a self-hosted or ' +
      'unlicensed org without it, this fails closed with 403 and `error.reason: "entitlement_denied"` rather ' +
      'than deleting the role.',
    authRequired: false,
    request: { params: RoleParamsSchema, query: DeleteQuerySchema },
    responses: {
      200: { description: 'The deleted role and how many members were reassigned.', schema: DeleteResultSchema },
      400: { description: 'Members assigned and no `fallbackRole` given, or an invalid one.' },
      401: { description: 'Not authenticated. Management API keys are not supported on this endpoint — session only.' },
      403: {
        description:
          'Lacks `custom_role.delete` (plain `forbidden`), or the `custom_roles` entitlement is absent ' +
          '(`forbidden` with `reason: "entitlement_denied"` and an `entitlement` upgrade payload).',
        schema: EntitlementForbiddenResponseSchema,
      },
    },
  },
  async ({ request, input }) => {
    rejectManagementApiKeyBearer(request);
    return deleteCustomRole(input.params.roleId, input.query.fallbackRole);
  },
);
