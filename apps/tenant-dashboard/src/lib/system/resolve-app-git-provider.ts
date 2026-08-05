import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_API } from '@/config-global';
import { SUPABASE_SECRET_KEY } from '@/config-global.server';
import { createGitProviderForApp } from '@/lib/adapters/context-git-provider';
import type { Database } from '@/types/db';

/**
 * Resolves an app's git provider client under the service-role admin client —
 * the one authoring-domain bypass.
 *
 * `createGitProviderForApp` reads the connection row under the service-role
 * client — the authoring domain's one sanctioned bypass. The bypass is named
 * and confined here; callers take the returned provider, never the admin
 * client.
 * Constructed with `createClient` directly (the sanctioned system-layer
 * construction) rather than the request-scoped client, so a user session is
 * never the thing holding these secrets.
 */
export async function resolveAppGitProvider(appId: string) {
  const admin = createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return createGitProviderForApp(admin, appId);
}
