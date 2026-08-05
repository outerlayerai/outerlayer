import 'server-only';
import { getCachedTraces } from '@/lib/analytics/cache';
import { countOnboardingSignals } from '@/lib/system/onboarding-signals';
import type { TenantContext } from '@/lib/analytics/tenant-context';

/**
 * The raw onboarding signals for an app/tenant: the ClickHouse trace count plus
 * the four Supabase counts. The caller turns these into booleans via
 * `interpretChecklistCounts`.
 */
type OnboardingSignals = {
  traceTotal: number;
  apiKeyCount: number;
  memberCount: number;
  gitProvider: string | null;
  gitInstallationId: string | null;
  gitBranchCount: number;
};

/**
 * Gather every onboarding signal for an app/tenant. The trace count rides the
 * existing cache path (RLS-scoped by the verified context); the Supabase counts
 * come from the service-role `countOnboardingSignals` (see its RLS-bypass
 * justification). Both run in parallel and each degrades to 0/null on its own
 * failure, so a single broken query can't collapse the whole checklist.
 */
export async function gatherOnboardingSignals(
  context: TenantContext,
): Promise<OnboardingSignals> {
  const [traceTotal, counts] = await Promise.all([
    getCachedTraces(context, 1, 0)
      .then((d) => d.total)
      .catch(() => 0),
    countOnboardingSignals(context),
  ]);

  return { traceTotal, ...counts };
}
