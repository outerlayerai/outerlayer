import "server-only";

/**
 * Git Provider Connection Management
 *
 * Creates Git provider instances from database connections.
 * A GitHub connection authenticates as the App installation, so the row
 * supplies only the installation id — no stored credential is involved.
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../types/db';
import type { GitProvider } from './git-provider.interface';
import { createGitProvider } from './factory';

/**
 * Create a Git provider for a specific app connection.
 *
 * This is the primary way to get a provider instance for database-stored connections.
 * It handles:
 * - Looking up the connection by app ID
 * - Passing database context for webhook management
 *
 * @param supabase - Supabase client
 * @param appId - The app ID to create provider for
 * @returns Git provider or null if connection not found
 *
 * @example
 * ```typescript
 * const provider = await createGitProviderForApp(supabase, appId);
 * if (provider) {
 *   const files = await provider.listDirectory('owner/repo', 'src', 'main');
 * }
 * ```
 */
export async function createGitProviderForApp(
  supabase: SupabaseClient<Database>,
  appId: string
): Promise<GitProvider | null> {
  // Get the connection to determine provider type
  const { data: connection, error } = await supabase
    .from('git_connection')
    .select('provider, installation_id')
    .eq('app_id', appId)
    .single();

  if (error || !connection) {
    console.error('createGitProviderForApp: No connection found for app', appId, error);
    return null;
  }

  return createGitHubProviderForApp(connection.installation_id, appId);
}

/**
 * Create a GitHub provider for an app connection.
 * Uses GitHub App installation authentication.
 */
async function createGitHubProviderForApp(
  installationId: number | null,
  appId: string
): Promise<GitProvider | null> {
  if (!installationId) {
    console.error('createGitProviderForApp: No installation_id for GitHub app', appId);
    return null;
  }

  return createGitProvider('github', {
    provider: 'github',
    installationId: Number(installationId),
  });
}

