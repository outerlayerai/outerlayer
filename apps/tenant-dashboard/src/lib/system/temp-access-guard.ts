import 'server-only';
import { getAdminDataClient } from '@/lib/system/admin-client';
import { analyticsLogger } from '@/lib/analytics/logger';

/**
 * Read-only marker for platform-admin temporary access.
 *
 * A temp-access grant is a `role='read'` membership plus a `temp_access_grant`
 * row (see TempAccessService). The grant dialog promises the admin cannot
 * "create, edit, or delete any data", and for Postgres that promise is kept by
 * the read role + RLS. Stores RLS does not reach — ClickHouse writes — get no
 * such protection: a write gated only on a read permission (e.g. `trace.read`)
 * is satisfied by the read membership, so the write goes through.
 *
 * Write-capable routes over those stores must therefore refuse temp-access
 * sessions explicitly. This returns whether the caller's access to `tenantId`
 * is such a grant.
 *
 * The read goes through the service-role client on purpose: `temp_access_grant`
 * has a single service_role RLS policy, so an authenticated (impersonating)
 * session can neither read the table to self-certify nor hide its own grant.
 * Scoped to `tenantId` so a platform admin who holds a grant on one org is
 * still free to write in a *different* org they legitimately belong to.
 *
 * On a lookup failure this returns `false` (does not block). The write path
 * has already cleared the primary permission check; failing this
 * defence-in-depth read closed would deny every non-impersonating caller on a
 * transient database error, which trades a narrow privileged-misuse window for
 * a broad outage. The failure is logged instead.
 */
export async function isTempAccessReadOnlySession(
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const db = getAdminDataClient();

  const { data, error } = await db
    .from('temp_access_grant')
    .select('id')
    .eq('created_by', userId)
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1);

  if (error) {
    analyticsLogger.error(
      'temp-access read-only check failed; allowing write',
      error,
    );
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}
