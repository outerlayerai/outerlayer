import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeCompare } from "@/utils/safe-compare";
import { workerSecretVaultName } from "@repo/worker-core";

/**
 * Verify the per-run worker secret presented by the runner on the
 * events/callback routes. The secret is stashed in Vault at
 * dispatch (`worker_secret_<runId>`) and read here with the service-role
 * client; constant-time compared against the bearer token. A missing entry
 * (run terminal → secret cleaned up) or mismatch both fail closed.
 */
export async function verifyWorkerSecret(
  admin: SupabaseClient<any, any, any>,
  workerRunId: string,
  authHeader: string | null,
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const presented = authHeader.slice("Bearer ".length);
  const { data, error } = await admin.rpc("read_secret", {
    secret_name: workerSecretVaultName(workerRunId),
  });
  if (error || !data) return false;
  return safeCompare(presented, data as string);
}
