import 'server-only';
import { headers } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The single server-derived tenant channel for a dashboard request.
 *
 * The middleware derives the tenant from the URL org and forwards it as the
 * `x-tenant-id` request header. Server components, server actions, and the
 * shared gatekeepers read it here and hand it to the header-attaching
 * Supabase server client. No header ⇒ tenant-scoped gatekeepers resolve no
 * tenant and deny.
 */

const TENANT_HEADER = 'x-tenant-id';

/** The request tenant the middleware derived from the URL org, or undefined. */
export async function getRequestTenantId(): Promise<string | undefined> {
  const requestHeaders = await headers();
  return requestHeaders.get(TENANT_HEADER) ?? undefined;
}

/**
 * The org slug carried by an authenticated path — `/orgs/<org>/…` for pages and
 * `/api/orgs/<org>/…` for canonical tenant-scoped API routes. Returns null when
 * the path carries no org.
 */
export function extractOrgName(pathname: string): string | null {
  const raw = pathname.match(/^\/(?:api\/)?orgs\/([^/]+)(?:\/|$)/)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Escapes LIKE metacharacters so an `ilike` match on an org slug is literal
 * (case-only insensitivity), never a wildcard pattern.
 */
function escapeOrgNameForIlike(orgName: string): string {
  return orgName.replace(/[\\%_]/g, '\\$&');
}

/**
 * Resolves an org slug to its tenant id through the authed user's own active
 * membership. The match is case-insensitive: `organization_name` carries a
 * unique index on `lower(organization_name)`, so `/orgs/Acme` and `/orgs/acme`
 * name the same tenant and a case-only difference must not miss.
 *
 * A slug the user is not an active member of resolves to null, so the
 * middleware sets no header; the page-level membership guards own the
 * non-member-URL UX. The membership row is the user's own, so this reads
 * under RLS without elevation.
 */
export async function resolveRequestTenantId(
  supabase: SupabaseClient,
  userId: string,
  orgName: string,
): Promise<string | null> {
  const literal = escapeOrgNameForIlike(orgName);
  const { data } = await supabase
    .from('membership')
    .select('tenant_id, tenant!inner(organization_name)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .ilike('tenant.organization_name', literal)
    .limit(1)
    .maybeSingle();

  return (data?.tenant_id as string | undefined) ?? null;
}
