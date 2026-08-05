import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/db';

/**
 * Every app has exactly one default
 * environment, auto-created on app creation and named `dev`. `api_key` and
 * `deployment` rows carry a NOT NULL `environment_id`; insert sites that are
 * not env-aware (CLI dev keys, dashboard API keys, push-webhook deployments,
 * the link-repository flow) bind to the app's default env.
 *
 * Throws when the app has no default env — that would mean the app-creation
 * action failed to provision one, which is a hard invariant violation.
 */
export async function resolveDefaultEnvironmentId(
  supabase: SupabaseClient<Database>,
  appId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();

  if (error) {
    throw new Error(
      `resolveDefaultEnvironmentId(${appId}) failed: ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `App ${appId} has no default environment — feature-054 invariant violated`,
    );
  }
  return data.id;
}
