import "server-only";

/**
 * GitHub Provider - OAuth Utilities
 *
 * Persists the user's GitHub identity to user_git_identity after Supabase
 * Auth completes the OAuth handshake. The GitHub App installation flow
 * (for repository access) is handled in `lib/system/git/connection`.
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../../types/db';

/**
 * Save or update the user's GitHub identity.
 * Called after successful GitHub OAuth linking.
 *
 * @param supabase - Supabase client
 * @param username - GitHub username
 * @param email - GitHub email (optional)
 * @param providerUserId - GitHub user ID (optional)
 */
export async function saveGitHubIdentity(
  supabase: SupabaseClient<Database>,
  username: string,
  email?: string,
  providerUserId?: string
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.id) {
    // Uses user_git_identity table (normalized identity storage)
    // Note: tenant_id is set by database trigger, so we use type assertion
    await supabase.from('user_git_identity').upsert(
      {
        profile_id: user.id,
        provider: 'github',
        username,
        email: email || null,
        provider_user_id: providerUserId || null,
      } as Database['public']['Tables']['user_git_identity']['Insert'],
      {
        onConflict: 'profile_id, provider',
      }
    );
  }
}
