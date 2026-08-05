import "server-only";

import type { EntitlementDeniedInfo } from "@/config/entitlements";
import { createSupabaseAdminClient } from "@/supabaseAdminClient";
import { EntitlementService, buildDeniedInfo } from "@/lib/system/entitlement-service";

/**
 * The workers domain's composed entitlement gate over the system entitlement
 * service: the feature flag, then the concurrency limit, then the monthly
 * minutes cap, with denied-info construction for whichever check fails first.
 * The tier/override read runs service-role because the acting user cannot see
 * the `billing` and override tables under RLS (they require `billing.read`);
 * the usage counts it gates on are supplied by the caller, read under the
 * request tenant's RLS client. Confining this module's own admin-client
 * construction to `lib/system` is a separate, broader change (out of scope
 * here — every other `createSupabaseAdminClient` call site moves together).
 */

type EntitlementGate = { allowed: true } | { allowed: false; denied: EntitlementDeniedInfo };

function service(): EntitlementService {
  return new EntitlementService({ db: createSupabaseAdminClient() });
}

/**
 * Gate a one-shot run launch: the feature flag, then the concurrency limit
 * against the tenant's in-flight run count, then the monthly minutes cap.
 */
export async function checkWorkerLaunchEntitlements(
  tenantId: string,
  usage: { activeRuns: number; usedMinutes: number },
): Promise<EntitlementGate> {
  const entitlements = service();

  if (!(await entitlements.canAccess(tenantId, "workers_enabled"))) {
    return { allowed: false, denied: buildDeniedInfo("workers_enabled") };
  }

  const concurrency = await entitlements.checkLimit(
    tenantId,
    "max_concurrent_worker_runs",
    usage.activeRuns,
  );
  if (!concurrency.allowed) {
    return { allowed: false, denied: buildDeniedInfo("max_concurrent_worker_runs", concurrency) };
  }

  const minutes = await entitlements.checkLimit(
    tenantId,
    "max_worker_minutes_per_month",
    usage.usedMinutes,
  );
  if (!minutes.allowed) {
    return { allowed: false, denied: buildDeniedInfo("max_worker_minutes_per_month", minutes) };
  }

  return { allowed: true };
}

/**
 * Gate a persistent-environment creation: the feature flag, then the live
 * environment count against the cap.
 */
export async function checkWorkerEnvironmentEntitlements(
  tenantId: string,
  usage: { activeWorkspaces: number },
): Promise<EntitlementGate> {
  const entitlements = service();

  if (!(await entitlements.canAccess(tenantId, "persistent_worker_environments"))) {
    return { allowed: false, denied: buildDeniedInfo("persistent_worker_environments") };
  }

  const limit = await entitlements.checkLimit(
    tenantId,
    "max_persistent_worker_environments",
    usage.activeWorkspaces,
  );
  if (!limit.allowed) {
    return { allowed: false, denied: buildDeniedInfo("max_persistent_worker_environments", limit) };
  }

  return { allowed: true };
}
