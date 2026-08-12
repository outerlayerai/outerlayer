/**
 * Custom-role list/create.
 *
 * GET  /api/orgs/{orgName}/custom-roles
 * POST /api/orgs/{orgName}/custom-roles
 *
 * Thin shim: all auth, permission gating, and the `custom_roles` entitlement
 * check run inside `@ee/features/custom-roles` — see `./http.ts` there — so
 * a self-hosted (AGPL) build carries no paid-feature implementation here.
 * `withApi`'s built-in session auth is app-scoped (it resolves access via an
 * `appId`), which doesn't fit an org-scoped resource like a custom role, so
 * these routes disable it and rely entirely on the delegated action's own
 * auth — the same seam every server action in the new world uses.
 */

import 'server-only';
import { z } from 'zod';
import { withApi } from '@/lib/api/with-api';
import { EntitlementForbiddenResponseSchema } from '@/lib/api/entitlement-response';
import { listCustomRoles, createCustomRole } from '@ee/features/custom-roles/http';
import { createCustomRoleInputSchema } from '@ee/features/custom-roles/schemas';

const OrgParamsSchema = z.object({ orgName: z.string().min(1) });

/** `CustomRoleWithPermissions` (`ee/features/custom-roles/custom-role-service.ts`) — the `custom_role` row plus its permission set and assigned-member count. */
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

export const GET = withApi(
  {
    method: 'get',
    path: '/api/orgs/{orgName}/custom-roles',
    tags: ['Custom Roles'],
    summary: 'List custom roles',
    operationId: 'list-custom-roles',
    description:
      'Lists the org\'s custom roles with their permissions and member counts. Unlike the mutation ' +
      'endpoints below, listing isn\'t gated by the `custom_roles` entitlement — only by the ' +
      '`custom_role.read` permission — so an unlicensed org can still see roles it created before downgrading.',
    authRequired: false,
    request: { params: OrgParamsSchema },
    responses: {
      200: { description: 'Custom role list.', schema: z.array(CustomRoleSchema) },
      401: { description: 'Not authenticated.' },
      403: { description: 'Lacks `custom_role.read`.' },
    },
  },
  async () => listCustomRoles(),
);

export const POST = withApi(
  {
    method: 'post',
    path: '/api/orgs/{orgName}/custom-roles',
    tags: ['Custom Roles'],
    summary: 'Create a custom role',
    operationId: 'create-custom-role',
    description:
      'Creates a custom role with the given permission set. Requires the `custom_roles` entitlement — on a ' +
      'self-hosted or unlicensed org without it, this fails closed with 403 and `error.reason: ' +
      '"entitlement_denied"` rather than creating the role.',
    authRequired: false,
    request: { params: OrgParamsSchema, body: createCustomRoleInputSchema },
    responses: {
      201: { description: 'The created custom role.', schema: CustomRoleSchema },
      400: { description: 'Invalid body, or a role with this name already exists.' },
      401: { description: 'Not authenticated.' },
      403: {
        description:
          'Lacks `custom_role.insert` (plain `forbidden`), or the `custom_roles` entitlement is absent ' +
          '(`forbidden` with `reason: "entitlement_denied"` and an `entitlement` upgrade payload).',
        schema: EntitlementForbiddenResponseSchema,
      },
    },
  },
  async ({ input }) => createCustomRole(input.body),
);
