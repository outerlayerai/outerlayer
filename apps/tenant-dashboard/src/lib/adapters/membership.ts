import 'server-only';

import type { User } from '@supabase/supabase-js';

import { createSupabaseAdminClient } from '@/supabaseAdminClient';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { MembershipService, type InviteResult } from '@/lib/system/membership-service';
import {
  createBillingService,
  createEmailService,
  createInviteRateLimiter,
} from '@/lib/external-services';
import { AuditLogService } from '@/lib/system/audit-log';
import type { UserRole } from '@/auth/types';
import type { AppMemberRole } from '@/types/app-member-role';

/**
 * The members-mutation crossing to the legacy `MembershipService` — real
 * production dependencies (admin + RLS-scoped clients, email, rate limiting,
 * billing) construct it exactly as the pre-migration `actions.ts` did.
 * `MembershipService`'s four public methods only ever read `.id` off the
 * `adminUser: User` parameter they take (the actor's own id, for the
 * owner-role check, the audit actor, and the invite/change/remove RPCs' actor
 * arg) — so a `ServiceContext.actor` is enough to satisfy it; the adapter
 * never needs the caller's full Supabase `User` object.
 */
async function createMembershipService(): Promise<MembershipService> {
  const supabaseAdmin = createSupabaseAdminClient();
  const supabaseServer = await createSupabaseServerClient();
  return new MembershipService({
    supabaseAdmin,
    supabaseServer,
    emailService: createEmailService(),
    rateLimitService: createInviteRateLimiter(),
    stripeService: createBillingService(),
  });
}

function actorUser(userId: string): User {
  return { id: userId } as User;
}

interface SendInviteInput {
  tenantId: string;
  actorUserId: string;
  name: string;
  email: string;
  role: UserRole;
  origin: string;
  appRoles?: Array<{ appId: string; role: AppMemberRole }>;
  /** Assigned to the new membership after invite creation, tenant-verified. */
  customRoleId?: string;
}

/**
 * Sends the invite, then — if a custom role was requested — assigns it to the
 * new membership as a second step (tenant-verified: a `customRoleId` from
 * another tenant is rejected without failing the invite itself, which has
 * already succeeded). Two steps rather than one transaction because the
 * custom-role table is a different aggregate than the invite transaction
 * RPCs (`invite_new/existing_user_transaction`) already own.
 */
export async function sendMemberInvite(input: SendInviteInput): Promise<InviteResult> {
  const service = await createMembershipService();
  const result = await service.sendInvite({
    adminUser: actorUser(input.actorUserId),
    tenantId: input.tenantId,
    name: input.name,
    email: input.email,
    role: input.role,
    origin: input.origin,
    appRoles: input.appRoles,
  });

  if (!result.success || !result.membershipId || !input.customRoleId) {
    return result;
  }

  const admin = createSupabaseAdminClient();
  const { data: roleExists } = await admin
    .from('custom_role')
    .select('id')
    .eq('id', input.customRoleId)
    .eq('tenant_id', input.tenantId)
    .single();

  if (!roleExists) {
    return {
      ...result,
      success: false,
      error: 'User was invited but custom role assignment failed. Role not found.',
    };
  }

  const { data: updated, error: updateError } = await admin
    .from('membership')
    .update({ custom_role_id: input.customRoleId })
    .eq('id', result.membershipId)
    .eq('tenant_id', input.tenantId)
    .select('id, custom_role_id')
    .single();

  if (updateError || !updated) {
    return {
      ...result,
      success: false,
      error: 'User was invited but custom role assignment failed. Please assign the role manually.',
    };
  }

  await new AuditLogService({ db: admin }).create({
    tenantId: input.tenantId,
    actorId: input.actorUserId,
    actionType: 'custom_role_assigned',
    targetType: 'membership',
    targetId: result.membershipId,
    targetIdentifier: input.email,
    afterState: { custom_role_id: input.customRoleId },
    details: { during: 'invite' },
  });

  return result;
}

interface ResendInviteInput {
  tenantId: string;
  actorUserId: string;
  email: string;
  origin: string;
}

export async function resendMemberInvite(
  input: ResendInviteInput,
): Promise<{ success: boolean; error?: string }> {
  const service = await createMembershipService();
  return service.resendInviteLink({
    adminUser: actorUser(input.actorUserId),
    tenantId: input.tenantId,
    email: input.email,
    origin: input.origin,
  });
}

interface ChangeMemberRoleInput {
  tenantId: string;
  actorUserId: string;
  targetUserId: string;
  newRole: UserRole;
  customRoleId?: string | null;
}

export async function changeMemberRole(
  input: ChangeMemberRoleInput,
): Promise<{ success: boolean; error?: string }> {
  const service = await createMembershipService();
  return service.changeUserRole({
    adminUser: actorUser(input.actorUserId),
    tenantId: input.tenantId,
    targetUserId: input.targetUserId,
    newRole: input.newRole,
    customRoleId: input.customRoleId,
  });
}

interface RemoveMemberInput {
  tenantId: string;
  actorUserId: string;
  targetUserId: string;
}

export async function removeMember(
  input: RemoveMemberInput,
): Promise<{ success: boolean; error?: string }> {
  const service = await createMembershipService();
  return service.removeUserFromOrg({
    adminUser: actorUser(input.actorUserId),
    tenantId: input.tenantId,
    targetUserId: input.targetUserId,
  });
}
