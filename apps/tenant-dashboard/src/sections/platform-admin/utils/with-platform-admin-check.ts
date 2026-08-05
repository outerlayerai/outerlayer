/* eslint-disable import/no-unused-modules -- Utility exports for platform admin server actions */
'use server';

import { createSupabaseServerClient } from '../../../supabaseServerClient';
import { createSupabaseAdminClient } from '../../../supabaseAdminClient';
import { AuditLogService } from '@/lib/system/audit-log';
import { ServerActionResponse } from '../../../types/server-action';
import type { PlatformRole } from '../../../types/platform-admin';
import {
  allowedPlatformAdminDomainsLabel,
  isAllowedPlatformAdminEmail,
} from '../../../auth/platform-admin-domain';

/**
 * Every denied attempt to use the internal platform-admin surface is
 * audit-worthy, reads included — this is the internal tool. Only anonymous
 * failures are skipped (no actor to attribute). Never throws.
 */
async function auditPlatformAccessDenied(
  user: { id: string; email?: string },
  reason: string
): Promise<void> {
  const auditLog = new AuditLogService({ db: createSupabaseAdminClient() });
  await auditLog.create({
    actorId: user.id,
    actorLabel: user.email ?? null,
    actionType: 'permission_denied',
    targetType: 'permission',
    targetIdentifier: 'platform_admin',
    details: { scope: 'platform', reason, email: user.email ?? null },
  });
}

export interface PlatformAdminUser {
  id: string;
  email: string;
  platformRole: PlatformRole;
}

/**
 * Check if the current user is a platform admin.
 *
 * Platform admin requirements:
 * 1. User must be authenticated
 * 2. User must be on an allowed platform-admin email domain
 * 3. User must have a row in platform_user_role table (orthogonal from tenant roles)
 */
async function checkPlatformAdmin(): Promise<{
  user: PlatformAdminUser | null;
  error?: string;
}> {
  const supabase = await createSupabaseServerClient();

  // Check user authentication
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user || !user.email) {
    return {
      user: null,
      error: authError?.message || 'User not authenticated',
    };
  }

  // Check email domain
  if (!isAllowedPlatformAdminEmail(user.email)) {
    await auditPlatformAccessDenied(user, 'email_domain');
    return {
      user: null,
      error: `Access denied. Platform admin requires a ${allowedPlatformAdminDomainsLabel()} email.`,
    };
  }

  // Check platform admin role (from platform_user_role table - separate from tenant membership roles)
  const supabaseAdmin = createSupabaseAdminClient();
  const { data: roleData, error: roleError } = await supabaseAdmin
    .from('platform_user_role')
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (roleError || !roleData) {
    await auditPlatformAccessDenied(user, 'not_platform_admin');
    return {
      user: null,
      error: 'Access denied. Platform admin role required.',
    };
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      platformRole: roleData.role as PlatformRole,
    },
  };
}

/**
 * Wrapper for server actions that require platform admin access.
 *
 * Usage:
 * ```typescript
 * export async function listOrganizations(params: ListOrganizationsParams) {
 *   return await withPlatformAdminCheck(async (adminUser) => {
 *     // adminUser.id and adminUser.email are available
 *     // ... implementation
 *     return { data: result };
 *   });
 * }
 * ```
 */
export async function withPlatformAdminCheck<T>(
  action: (user: PlatformAdminUser) => Promise<ServerActionResponse<T>>
): Promise<ServerActionResponse<T>> {
  const { user, error } = await checkPlatformAdmin();

  if (error || !user) {
    return { error: error || 'Access denied' };
  }

  return await action(user);
}
