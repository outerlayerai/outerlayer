import 'server-only';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { getRequestTenantId } from '@/lib/tenant/request-tenant';
import type { Permission } from '@/utils/permissions';
import type { Actor, ServiceContext } from '@/lib/action-kit/service-context';
import type { PreTenantActor } from '@/lib/action-kit/pre-tenant-action';

/**
 * The request-bound wiring behind the action-kit seams. It lives in the adapter
 * layer because it reaches the root Supabase server-client wrapper and request
 * headers — the one sanctioned crossing from new-world code to those legacy
 * surfaces. The tenant comes from the URL the middleware derived; the client
 * it builds carries that tenant on every query.
 */

/** Build the per-request `ServiceContext`: header-scoped client, tenant, actor. */
export async function loadRequestServiceContext(): Promise<ServiceContext> {
  const headerTenantId = await getRequestTenantId();
  const db = await createSupabaseServerClient(headerTenantId);

  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user) {
    throw new Error('Not authenticated');
  }

  if (!headerTenantId) {
    throw new Error('No tenant for request');
  }
  const tenantId = headerTenantId;

  // Role is read table-driven from the actor's active membership for this
  // tenant, never the JWT user_role claim — the claim can be stale or name a
  // different tenant's role.
  const { data: membership } = await db
    .from('membership')
    .select('role')
    .eq('user_id', user.id)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .maybeSingle();

  const role = (membership?.role as string | undefined) ?? '';

  return { db, tenantId, actor: { userId: user.id, role } };
}

/**
 * The authenticated identity for a `preTenantAction`, with no tenant scope.
 * Builds the Supabase client with no tenant argument, so it sends no
 * `X-Tenant-Id` header — a pre-tenant action has no tenant to scope to.
 */
export async function loadPreTenantActor(): Promise<PreTenantActor | null> {
  const db = await createSupabaseServerClient();

  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user) {
    return null;
  }

  return { userId: user.id, email: user.email ?? null, raw: user };
}

/**
 * The caller's own membership id for the request tenant, or null if they have
 * none (fail-closed for callers that pin a scope to it). RLS lets a user read
 * their own membership row, so the header-scoped client is enough here — no
 * admin client, no cross-user read.
 */
export async function resolveCallerMembershipId(
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const headerTenantId = await getRequestTenantId();
  const db = await createSupabaseServerClient(headerTenantId);
  const { data } = await db
    .from('membership')
    .select('id')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();
  return data?.id ?? null;
}

/**
 * The permission seam. The DB `authorize` / `app_authorize` RPCs resolve the
 * actor's effective permissions from membership for public.tenant_id()'s tenant,
 * so the header-scoped client answers for the URL tenant. `appId` selects the
 * app-scoped check. Fail-closed: an RPC error surfaces rather than granting.
 */
export async function checkRequestPermission(
  _actor: Actor,
  permission: string,
  appId?: string,
): Promise<boolean> {
  const headerTenantId = await getRequestTenantId();
  const db = await createSupabaseServerClient(headerTenantId);

  if (appId) {
    const { data, error } = await db.rpc('app_authorize', {
      requested_permission: permission as Permission,
      target_app_id: appId,
    });
    if (error) throw new Error(`app_authorize failed: ${error.message}`);
    return data === true;
  }

  const { data, error } = await db.rpc('authorize', {
    requested_permission: permission as Permission,
  });
  if (error) throw new Error(`authorize failed: ${error.message}`);
  return data === true;
}
