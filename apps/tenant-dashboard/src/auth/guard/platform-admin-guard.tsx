/* eslint-disable import/no-unused-modules -- Utility functions for future platform admin phases */
import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { createSupabaseServerClient } from '../../supabaseServerClient';
import { createSupabaseAdminClient } from '../../supabaseAdminClient';
import { AuditLogService } from '@/lib/system/audit-log';
import { paths } from '../../routes/paths';
import type { PlatformRole } from '../../types/platform-admin';
import { isAllowedPlatformAdminEmail } from '../platform-admin-domain';


type Props = {
  children: React.ReactNode;
};

/**
 * Server-side utility to check if a user is a platform admin.
 *
 * Platform admin requirements:
 * 1. User must be on an allowed platform-admin email domain
 * 2. User must have a row in platform_user_role table (orthogonal from tenant roles)
 */
export async function isPlatformAdmin(userId: string, email: string): Promise<boolean> {
  // 1. Email domain check
  if (!isAllowedPlatformAdminEmail(email)) {
    return false;
  }

  // 2. Platform admin role check (from platform_user_role table - separate from tenant roles)
  const supabaseAdmin = createSupabaseAdminClient();
  const { data } = await supabaseAdmin
    .from('platform_user_role')
    .select('role')
    .eq('user_id', userId)
    .single();

  return !!data;
}

/**
 * Get the platform role for a user.
 * Returns null if user has no platform role.
 */
export async function getPlatformRole(userId: string): Promise<PlatformRole | null> {
  const supabaseAdmin = createSupabaseAdminClient();
  const { data } = await supabaseAdmin
    .from('platform_user_role')
    .select('role')
    .eq('user_id', userId)
    .single();

  return data?.role ?? null;
}

/**
 * Server component guard for platform admin routes.
 * Wraps children and shows ForbiddenView if user is not a platform admin.
 * Redirects to login if user is not authenticated.
 */
export default async function PlatformAdminGuard({ children }: Props) {
  const supabase = await createSupabaseServerClient();

  // Get current user
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Redirect to login if not authenticated
    redirect(paths.auth.login);
  }

  // Check platform admin status
  const isAdmin = await isPlatformAdmin(user.id, user.email || '');

  if (!isAdmin) {
    // Every denied attempt to reach the internal admin surface is
    // audit-worthy (see also with-platform-admin-check for server actions).
    const auditLog = new AuditLogService({ db: createSupabaseAdminClient() });
    await auditLog.create({
      actorId: user.id,
      actorLabel: user.email ?? null,
      actionType: 'permission_denied',
      targetType: 'permission',
      targetIdentifier: 'platform_admin',
      details: { scope: 'platform', reason: 'not_platform_admin', email: user.email ?? null },
    });
    // Return 404 instead of 403 to hide the existence of this page from non-admins
    notFound();
  }

  return <>{children}</>;
}

/**
 * Get the current platform admin user info (for use in server actions/components)
 * Returns null if user is not a platform admin.
 */
export async function getPlatformAdminUser(): Promise<{
  id: string;
  email: string;
} | null> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return null;
  }

  const isAdmin = await isPlatformAdmin(user.id, user.email);

  if (!isAdmin) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
  };
}
