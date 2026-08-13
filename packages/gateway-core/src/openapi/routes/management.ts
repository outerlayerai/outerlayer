/**
 * Org-management API — the public, management-API-key-authenticated
 * counterpart of the dashboard's `/api/orgs/{orgName}/members*` routes.
 * Consumes `@repo/org-management-service`'s framework-free
 * `MembershipService` + `management-api-key-authority`; the gateway's own
 * contribution is the adapter wiring in `../../lib/management-adapters.ts`
 * (see that module's doc comment for exactly which dependencies are fully
 * wired vs. fail closed on this deployment) and the auth guard in
 * `../../lib/management-auth.ts` (`Bearer olk_...` only — see that module's
 * doc comment for why these routes bypass the shared `authMiddleware`).
 *
 * Routes:
 *   - GET    /v1/orgs/{orgName}/members                      — membership.read
 *   - POST   /v1/orgs/{orgName}/members/invites               — membership.insert
 *   - POST   /v1/orgs/{orgName}/members/invites/{id}/resend   — membership.insert
 *   - PATCH  /v1/orgs/{orgName}/members/{userId}               — membership.update
 *   - DELETE /v1/orgs/{orgName}/members/{userId}               — membership.delete
 *   - GET    /v1/orgs/{orgName}/roles                          — membership.read
 */

import { itemResponse } from '@repo/api-schemas';
import type { User } from '@supabase/supabase-js';
import {
  MembershipService,
  MembershipRoleEnum,
  type MembershipRole,
} from '@repo/org-management-service';
import { createSystemAdminClient } from '../../lib/system-client';
import type { ManagementAuthContext } from '../middleware';
import {
  buildManagementAppRoleAssigner,
  buildManagementAuditLogWriter,
  buildManagementEmailService,
  buildManagementEntitlementGate,
  buildManagementLogger,
  buildManagementRateLimitService,
  buildManagementRequestContext,
  buildManagementStripeService,
} from '../../lib/management-adapters';
import { BaseRoute, errorResponse, parseJsonBody, structuredError, z, type AppContext } from './_shared';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const ORG_MEMBER_ROLES = [
  MembershipRoleEnum.OWNER,
  MembershipRoleEnum.ADMIN,
  MembershipRoleEnum.WRITE,
  MembershipRoleEnum.READ,
  MembershipRoleEnum.DISABLED,
] as const;

const OrgNameParamsSchema = z.object({ orgName: z.string().min(1) });

const TenantMemberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(ORG_MEMBER_ROLES),
  membershipId: z.string(),
  membershipStatus: z.enum(['active', 'pending']),
  customRoleId: z.string().optional(),
  customRoleName: z.string().optional(),
  isConfirmed: z.boolean(),
});

const RoleSchema = z.object({ value: z.string(), label: z.string() });

/** Set by `managementAuthGuard` before every management route handler runs. */
function getManagementAuth(c: AppContext): ManagementAuthContext {
  return c.get('managementAuth');
}

/** `MembershipService` methods only ever read `adminUser.id` — see its own doc comment. */
function actorUser(auth: ManagementAuthContext): User {
  return { id: auth.ctx.actor.userId } as User;
}

function buildMembershipService(c: AppContext): MembershipService {
  const admin = createSystemAdminClient(c.env);
  return new MembershipService({
    // No RLS-scoped client exists for a bearer caller (see the package doc on
    // `ManagementApiKeyServiceContext.db`). `supabaseServer` is read in exactly
    // one place (`resendInviteLink`'s company-name lookup for the email
    // subject line) and degrades to a harmless `'an organization'` fallback on
    // any read failure — safe to reuse the admin client here.
    supabaseAdmin: admin,
    supabaseServer: admin,
    emailService: buildManagementEmailService(c.env),
    rateLimitService: buildManagementRateLimitService(c),
    stripeService: buildManagementStripeService(),
    entitlements: buildManagementEntitlementGate(admin, c.env),
    auditLog: buildManagementAuditLogWriter(admin),
    getRequestContext: buildManagementRequestContext(c),
    logger: buildManagementLogger(),
    appRoleAssigner: buildManagementAppRoleAssigner(),
    appUrl: c.env.DASHBOARD_BASE_URL ?? '',
  });
}

// ---------------------------------------------------------------------------
// GET /v1/orgs/{orgName}/members
// ---------------------------------------------------------------------------

export class ListOrgMembers extends BaseRoute {
  schema = {
    tags: ['Org Management'],
    summary: 'List org members and pending invites',
    operationId: 'list-org-members',
    description:
      'Returns active memberships and pending invites for the org. Requires the `membership.read` management-API-key permission.',
    security: [{ ManagementApiKeyAuth: [] }],
    request: { params: OrgNameParamsSchema },
    responses: {
      200: {
        description: 'Active memberships and pending invites.',
        content: { 'application/json': { schema: itemResponse(z.array(TenantMemberSchema)) } },
      },
      401: errorResponse('Missing or invalid management API key.'),
      403: errorResponse("Key does not belong to this org, or lacks 'membership.read'."),
    },
  };

  async handle(c: AppContext) {
    const auth = getManagementAuth(c);
    const admin = createSystemAdminClient(c.env);

    const { data: memberships } = await admin
      .from('membership')
      .select('id, user_id, role, status, custom_role_id, custom_role(name)')
      .eq('tenant_id', auth.ctx.tenantId)
      .in('status', ['active', 'pending']);

    if (!memberships || memberships.length === 0) {
      return c.json({ data: [] });
    }

    const userIds = memberships.map((m: { user_id: string }) => m.user_id);
    const membershipByUser = new Map(
      memberships.map((m: {
        id: string;
        user_id: string;
        role: string;
        status: string;
        custom_role_id: string | null;
        custom_role: { name: string } | null;
      }) => [
        m.user_id,
        {
          membershipId: m.id,
          role: m.role,
          status: m.status as 'active' | 'pending',
          customRoleName: m.custom_role?.name ?? undefined,
          customRoleId: m.custom_role_id ?? undefined,
        },
      ]),
    );

    const { data: profiles } = await admin.from('profile').select('id, name, email').in('id', userIds);

    const members = await Promise.all(
      (profiles ?? []).map(async (profile: { id: string; name: string | null; email: string }) => {
        const membership = membershipByUser.get(profile.id);
        const { data: authUser } = await admin.auth.admin.getUserById(profile.id);
        return {
          id: profile.id,
          name: profile.name,
          email: profile.email,
          role: (membership?.role ?? 'read') as MembershipRole,
          membershipId: membership?.membershipId ?? '',
          membershipStatus: membership?.status ?? 'pending',
          customRoleId: membership?.customRoleId,
          customRoleName: membership?.customRoleName,
          isConfirmed: !!authUser.user?.email_confirmed_at,
        };
      }),
    );

    return c.json({ data: members });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/orgs/{orgName}/members/invites
// ---------------------------------------------------------------------------

const InviteBodySchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().min(1).email(),
  role: z.enum(ORG_MEMBER_ROLES),
  appRoles: z
    .array(z.object({ appId: z.string().min(1), role: z.enum(['read', 'write', 'admin']) }))
    .optional(),
});

export class InviteOrgMember extends BaseRoute {
  schema = {
    tags: ['Org Management'],
    summary: 'Invite an org member',
    operationId: 'invite-org-member',
    description:
      'Sends an org invite. Requires the `membership.insert` management-API-key permission. `appRoles` is accepted but not yet honored on this endpoint — see the response for details when supplied.',
    security: [{ ManagementApiKeyAuth: [] }],
    request: { params: OrgNameParamsSchema, body: { content: { 'application/json': { schema: InviteBodySchema } } } },
    responses: {
      200: {
        description: 'Invite created.',
        content: { 'application/json': { schema: itemResponse(z.object({ membershipId: z.string() })) } },
      },
      400: errorResponse('Invalid input, or a business-rule denial (e.g. only owners can invite owners).'),
      401: errorResponse('Missing or invalid management API key.'),
      403: errorResponse("Key does not belong to this org, or lacks 'membership.insert'."),
    },
  };

  async handle(c: AppContext) {
    const auth = getManagementAuth(c);
    const raw = await parseJsonBody(c);
    const parsed = InviteBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(structuredError('invalid_request_body', 'Invalid request body'), 400);
    }
    const body = parsed.data;

    const service = buildMembershipService(c);
    const result = await service.sendInvite({
      adminUser: actorUser(auth),
      tenantId: auth.ctx.tenantId,
      name: body.name,
      email: body.email,
      role: body.role,
      origin: c.env.DASHBOARD_BASE_URL ?? '',
      appRoles: body.appRoles,
    });

    if (!result.success) {
      if (result.error === 'entitlement_denied') {
        return c.json(
          structuredError('entitlement_denied', 'The org plan does not allow this invite', {
            entitlement: result.entitlement,
          }),
          403,
        );
      }
      return c.json(structuredError('invite_failed', result.error ?? 'Invite failed'), 400);
    }

    return c.json({ data: { membershipId: result.membershipId } });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/orgs/{orgName}/members/invites/{inviteId}/resend
// ---------------------------------------------------------------------------

const InviteIdParamsSchema = OrgNameParamsSchema.extend({ inviteId: z.string().min(1) });

export class ResendOrgMemberInvite extends BaseRoute {
  schema = {
    tags: ['Org Management'],
    summary: 'Resend a pending invite',
    operationId: 'resend-org-member-invite',
    description: "Resends the invite email for a pending membership. Requires 'membership.insert'.",
    security: [{ ManagementApiKeyAuth: [] }],
    request: { params: InviteIdParamsSchema },
    responses: {
      200: { description: 'Resend accepted.', content: { 'application/json': { schema: itemResponse(z.object({ success: z.literal(true) })) } } },
      401: errorResponse('Missing or invalid management API key.'),
      403: errorResponse("Key does not belong to this org, or lacks 'membership.insert'."),
      404: errorResponse('No pending invite with that id in this org.'),
    },
  };

  async handle(c: AppContext) {
    const auth = getManagementAuth(c);
    const { params } = (await this.getValidatedData()) as { params: { orgName: string; inviteId: string } };
    const { inviteId } = params;
    const admin = createSystemAdminClient(c.env);

    const { data: membership } = await admin
      .from('membership')
      .select('id, user_id')
      .eq('id', inviteId)
      .eq('tenant_id', auth.ctx.tenantId)
      .eq('status', 'pending')
      .maybeSingle();
    if (!membership) {
      return c.json(structuredError('invite_not_found', 'Pending invite not found'), 404);
    }

    const { data: profile } = await admin.from('profile').select('email').eq('id', membership.user_id).maybeSingle();
    if (!profile?.email) {
      return c.json(structuredError('invite_not_found', 'Pending invite not found'), 404);
    }

    const service = buildMembershipService(c);
    const result = await service.resendInviteLink({
      adminUser: actorUser(auth),
      tenantId: auth.ctx.tenantId,
      email: profile.email,
      origin: c.env.DASHBOARD_BASE_URL ?? '',
    });

    if (!result.success) {
      return c.json(structuredError('resend_failed', result.error ?? 'Resend failed'), 400);
    }
    return c.json({ data: { success: true as const } });
  }
}

// ---------------------------------------------------------------------------
// PATCH /v1/orgs/{orgName}/members/{userId}
// ---------------------------------------------------------------------------

const UserIdParamsSchema = OrgNameParamsSchema.extend({ userId: z.string().min(1) });

const ChangeRoleBodySchema = z.object({
  role: z.enum(ORG_MEMBER_ROLES),
  customRoleId: z.string().min(1).nullable().optional(),
});

export class ChangeOrgMemberRole extends BaseRoute {
  schema = {
    tags: ['Org Management'],
    summary: "Change a member's role",
    operationId: 'change-org-member-role',
    description: "Changes a member's built-in or custom role. Requires 'membership.update'.",
    security: [{ ManagementApiKeyAuth: [] }],
    request: {
      params: UserIdParamsSchema,
      body: { content: { 'application/json': { schema: ChangeRoleBodySchema } } },
    },
    responses: {
      200: { description: 'Role changed.', content: { 'application/json': { schema: itemResponse(z.object({ success: z.literal(true) })) } } },
      400: errorResponse('Business-rule denial (e.g. last-owner protection).'),
      401: errorResponse('Missing or invalid management API key.'),
      403: errorResponse("Key does not belong to this org, or lacks 'membership.update'."),
      404: errorResponse('No member with that id in this org.'),
    },
  };

  async handle(c: AppContext) {
    const auth = getManagementAuth(c);
    const { params } = (await this.getValidatedData()) as { params: { orgName: string; userId: string } };
    const { userId } = params;
    const raw = await parseJsonBody(c);
    const parsed = ChangeRoleBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(structuredError('invalid_request_body', 'Invalid request body'), 400);
    }

    const service = buildMembershipService(c);
    const result = await service.changeUserRole({
      adminUser: actorUser(auth),
      tenantId: auth.ctx.tenantId,
      targetUserId: userId,
      newRole: parsed.data.role,
      customRoleId: parsed.data.customRoleId,
    });

    if (!result.success) {
      const notFound = /not found/i.test(result.error ?? '');
      return c.json(
        structuredError(notFound ? 'member_not_found' : 'role_change_failed', result.error ?? 'Role change failed'),
        notFound ? 404 : 400,
      );
    }
    return c.json({ data: { success: true as const } });
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/orgs/{orgName}/members/{userId}
// ---------------------------------------------------------------------------

export class RemoveOrgMember extends BaseRoute {
  schema = {
    tags: ['Org Management'],
    summary: 'Remove a member from the org',
    operationId: 'remove-org-member',
    description: "Removes a member from the org. Requires 'membership.delete'.",
    security: [{ ManagementApiKeyAuth: [] }],
    request: { params: UserIdParamsSchema },
    responses: {
      200: { description: 'Member removed.', content: { 'application/json': { schema: itemResponse(z.object({ success: z.literal(true) })) } } },
      400: errorResponse('Business-rule denial (e.g. last-owner protection).'),
      401: errorResponse('Missing or invalid management API key.'),
      403: errorResponse("Key does not belong to this org, or lacks 'membership.delete'."),
      404: errorResponse('No member with that id in this org.'),
    },
  };

  async handle(c: AppContext) {
    const auth = getManagementAuth(c);
    const { params } = (await this.getValidatedData()) as { params: { orgName: string; userId: string } };
    const { userId } = params;

    const service = buildMembershipService(c);
    const result = await service.removeUserFromOrg({
      adminUser: actorUser(auth),
      tenantId: auth.ctx.tenantId,
      targetUserId: userId,
    });

    if (!result.success) {
      const notFound = /not found/i.test(result.error ?? '');
      return c.json(
        structuredError(notFound ? 'member_not_found' : 'remove_failed', result.error ?? 'Remove failed'),
        notFound ? 404 : 400,
      );
    }
    return c.json({ data: { success: true as const } });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/orgs/{orgName}/roles
// ---------------------------------------------------------------------------

const BUILT_IN_ROLES: Array<{ value: string; label: string }> = [
  { value: MembershipRoleEnum.OWNER, label: 'Owner' },
  { value: MembershipRoleEnum.ADMIN, label: 'Admin' },
  { value: MembershipRoleEnum.WRITE, label: 'Write' },
  { value: MembershipRoleEnum.READ, label: 'Read' },
  { value: MembershipRoleEnum.DISABLED, label: 'Disabled' },
];

export class ListOrgRoles extends BaseRoute {
  schema = {
    tags: ['Org Management'],
    summary: 'List built-in org roles',
    operationId: 'list-org-roles',
    description: "Returns the built-in role catalog. Requires 'membership.read'.",
    security: [{ ManagementApiKeyAuth: [] }],
    request: { params: OrgNameParamsSchema },
    responses: {
      200: {
        description: 'The built-in role catalog.',
        content: { 'application/json': { schema: itemResponse(z.array(RoleSchema)) } },
      },
      401: errorResponse('Missing or invalid management API key.'),
      403: errorResponse("Key does not belong to this org, or lacks 'membership.read'."),
    },
  };

  async handle(c: AppContext) {
    return c.json({ data: BUILT_IN_ROLES });
  }
}
