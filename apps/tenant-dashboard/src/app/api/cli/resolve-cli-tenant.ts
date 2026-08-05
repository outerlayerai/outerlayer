/**
 * The CLI's tenant resolver. The CLI authenticates over a bearer Supabase
 * JWT, not a session cookie, so no middleware-derived `x-tenant-id` header
 * exists here.
 *
 * Precedence: an explicit `X-Tenant-Id` header the caller sends themselves →
 * their `profile.last_active_tenant_id` preference → their sole active
 * membership → deny. A header that does not resolve denies outright; it does
 * not fall through to the next branch.
 */

import 'server-only';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/types/db';

const TENANT_HEADER = 'x-tenant-id';

export type ResolveCliTenantResult =
  | { ok: true; tenantId: string }
  | { ok: false; status: number; error: string };

/**
 * Whether the caller has an active, non-disabled membership in `tenantId`,
 * read through the caller's own bearer-scoped client (membership self-rows
 * are visible under RLS).
 */
async function hasActiveMembership(
  supabase: SupabaseClient<Database>,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('membership')
    .select('id')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .neq('role', 'disabled')
    .maybeSingle();
  return data != null;
}

export async function resolveCliTenant(
  supabase: SupabaseClient<Database>,
  user: User,
  request: Request,
): Promise<ResolveCliTenantResult> {
  // Precedence 1: an explicit header, checked against the caller's memberships.
  const headerTenantId = request.headers.get(TENANT_HEADER);
  if (headerTenantId) {
    const isMember = await hasActiveMembership(supabase, user.id, headerTenantId);
    if (!isMember) {
      return { ok: false, status: 403, error: 'Not an active member of the requested tenant' };
    }
    return { ok: true, tenantId: headerTenantId };
  }

  // Precedence 2: the caller's last-active-org preference, checked the same
  // way.
  const { data: profile } = await supabase
    .from('profile')
    .select('last_active_tenant_id')
    .eq('id', user.id)
    .single();
  const preferredTenantId = profile?.last_active_tenant_id;
  if (preferredTenantId && (await hasActiveMembership(supabase, user.id, preferredTenantId))) {
    return { ok: true, tenantId: preferredTenantId };
  }

  // Precedence 3: exactly one active membership — nothing left to disambiguate.
  const { data: memberships } = await supabase
    .from('membership')
    .select('tenant_id')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .neq('role', 'disabled');

  if (memberships && memberships.length === 1) {
    return { ok: true, tenantId: memberships[0]!.tenant_id };
  }
  if (memberships && memberships.length > 1) {
    // A multi-org caller with no header and no usable preference gets an
    // explicit instruction rather than an arbitrary pick.
    return {
      ok: false,
      status: 400,
      error: 'Multiple organizations found — switch to the one you want in the dashboard, then retry',
    };
  }

  return { ok: false, status: 403, error: 'No tenant associated with user' };
}
