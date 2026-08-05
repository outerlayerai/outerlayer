import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_API } from '@/config-global';
import { SUPABASE_SECRET_KEY } from '@/config-global.server';
import type { Database } from '@/types/db';
import type { TenantContext } from '@/lib/analytics/tenant-context';

/**
 * The Supabase-side onboarding counts, gathered under the service-role client.
 *
 * Scoping: API keys, the git connection, and branches are **app-scoped**
 * (`app_id`) — keys are minted bound to an app (see
 * `features/api-keys/actions.ts`), matching the trace signal and the
 * panel's per-app view. Membership is **tenant-scoped** (`tenant_id`):
 * teammates belong to the tenant, not a single app.
 *
 * Each signal is computed independently and degrades to 0/null on its own
 * failure — a single failing query must never collapse the whole checklist into
 * "nothing done". `safeCount`/`safeMaybeRow` enforce that.
 */
type OnboardingSignalCounts = {
  apiKeyCount: number;
  memberCount: number;
  /** `git_connection.provider` for the app, or null when not connected. */
  gitProvider: string | null;
  /** `git_connection.installation_id` (GitHub App); null when not connected. */
  gitInstallationId: string | null;
  gitBranchCount: number;
};

/**
 * Await a Supabase head-count query and return its `count`, defaulting to 0.
 *
 * Supabase resolves (rather than rejects) with `{ count, error }`, so a failed
 * count surfaces as `count: null` rather than a throw — `count ?? 0` handles
 * that. The `try/catch` still guards the genuinely-thrown case (e.g. the client
 * itself blowing up) so a single broken signal yields 0, not an unhandled
 * rejection that takes down the route.
 */
export async function safeCount(
  query: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  try {
    const { count } = await query;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Await a Supabase `.maybeSingle()` query and return its row, defaulting to
 * null. Same degradation contract as `safeCount`: a failed lookup (error
 * payload or a thrown client) yields "no row", never an exception — the git
 * signals must not be able to take down the whole checklist.
 */
export async function safeMaybeRow<T>(
  query: PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T | null> {
  try {
    const { data } = await query;
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Count the four Supabase onboarding signals for an app/tenant under the
 * service-role client. All run in parallel; each independently degrades to
 * 0/null on failure.
 *
 * RLS-bypass justification: `api_key.read` is not held by the viewer (read)
 * role, so a read-only member cannot count their app's keys under RLS — the key
 * signal would silently read 0. The counts run under the service-role client so
 * the checklist is consistent for every role. The scoping inputs are the
 * verified `TenantContext` (`tenantId`/`appId` already proven to belong to the
 * caller in `withApi`'s auth), never user-supplied query params — so the client
 * cannot be steered to count another tenant's rows.
 */
export async function countOnboardingSignals(
  context: TenantContext,
): Promise<OnboardingSignalCounts> {
  const db = createClient<Database>(
    `${SUPABASE_API.url}`,
    `${SUPABASE_SECRET_KEY}`,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const [apiKeyCount, memberCount, gitConnection, gitBranchCount] =
    await Promise.all([
      safeCount(
        db
          .from('api_key')
          .select('id', { count: 'exact', head: true })
          .eq('app_id', context.appId),
      ),
      safeCount(
        db
          .from('membership')
          .select('*', { count: 'exact', head: true })
          .eq('tenant_id', context.tenantId)
          .in('status', ['active', 'pending']),
      ),
      safeMaybeRow<{ provider: string | null; installation_id: string | null }>(
        db
          .from('git_connection')
          .select('provider, installation_id')
          .eq('app_id', context.appId)
          .limit(1)
          .maybeSingle(),
      ),
      safeCount(
        db
          .from('git_branch')
          .select('id', { count: 'exact', head: true })
          .eq('app_id', context.appId),
      ),
    ]);

  return {
    apiKeyCount,
    memberCount,
    gitProvider: gitConnection?.provider ?? null,
    gitInstallationId: gitConnection?.installation_id ?? null,
    gitBranchCount,
  };
}
