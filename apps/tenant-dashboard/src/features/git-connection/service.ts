import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/db';

type GitConnectionUpsert = {
  appId: string;
  provider: 'github';
  installationId: number | null;
};

/**
 * Persist a git connection for an app, clearing any stale branch rows first.
 *
 * `client` is already tenant-scoped by the caller — the OAuth callbacks build
 * it from the tenant carried by the HMAC-signed OAuth state. This function
 * never resolves tenancy itself: the `git_connection` row omits `tenant_id`,
 * so `set_tenant_id()` stamps it from `public.tenant_id()` (the scoped client's
 * validated `X-Tenant-Id`), and RLS admits the row only for a tenant the actor
 * is a member of — fail-closed for a foreign-tenant state.
 */
export async function upsertGitConnection(
  client: SupabaseClient<Database>,
  { appId, provider, installationId }: GitConnectionUpsert,
) {
  // Switching providers invalidates the tracked branches — clear them under the
  // same scoped client so the delete follows the connection write's tenant.
  await client.from('git_branch').delete().eq('app_id', appId);

  return client.from('git_connection').upsert(
    {
      app_id: appId,
      provider,
      installation_id: installationId,
      repository: null,
    } as Database['public']['Tables']['git_connection']['Insert'],
    {
      onConflict: 'tenant_id, app_id',
    },
  );
}
