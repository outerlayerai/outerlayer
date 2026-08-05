import "server-only";

import { createClient } from "@supabase/supabase-js";
import { mintApiKey } from "@repo/api-key-service";

import type { Database } from "@/types/db";
import { SUPABASE_API } from "@/config-global";
import { API_KEY_PEPPER, SUPABASE_SECRET_KEY } from "@/config-global.server";

/**
 * Per-run gateway credentials for the eval worker.
 *
 * The Fly worker holds NO database credential: this per-run key is its only
 * secret, and every control-plane operation (job read, status reporting,
 * escalations, trial/session persistence) goes through gateway endpoints bound
 * server-side to exactly this run. Minting writes the key-store, which the
 * caller's RLS-scoped client cannot reach, so it runs on the service-role
 * client constructed here — the sole sanctioned home for the RLS-bypassing
 * client. The plaintext travels in the worker Machine's env: a conscious trade
 * documented on the dispatcher — Machine config is readable by Fly-token
 * holders, and what a reader gains is one run's scoped, short-lived credential
 * (`score.write` + `trace.write` only, env-bound, 24h expiry) that the gateway
 * revokes the moment the run reports a terminal status. The alternative (a
 * Vault handshake) would require the worker to hold the service-role key —
 * exactly the unscoped, tenant-wide credential this design keeps out of the
 * Fly trust domain.
 */

/** Fixed key-row name per run — the gateway's run↔key binding checks this exact
 *  name, and a re-mint for the same run is a rotation instead of a duplicate. */
export function evalRunKeyName(runId: string): string {
  return `eval-run:${runId}`;
}

const KEY_TTL_MS = 24 * 60 * 60 * 1000;

interface MintEvalWorkerCredentialsInput {
  tenantId: string;
  appId: string;
  environmentId: string;
  runId: string;
}

/**
 * Mint the run's gateway key (score.write + trace.write, bound to the run's
 * environment). Returns the plaintext exactly once — the caller puts it in the
 * worker Machine's env and drops it. Throws on failure: the caller fails the
 * run rather than dispatching a worker that cannot reach its control plane.
 */
export async function mintEvalWorkerCredentials(
  input: MintEvalWorkerCredentialsInput,
): Promise<{ key: string }> {
  const admin = createClient<Database>(SUPABASE_API.url, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { plaintext } = await mintApiKey({
    rowClient: admin,
    adminClient: admin,
    pepper: API_KEY_PEPPER,
    tenantId: input.tenantId,
    appId: input.appId,
    name: evalRunKeyName(input.runId),
    environmentId: input.environmentId,
    permissions: ["score.write", "trace.write"],
    expiresAt: new Date(Date.now() + KEY_TTL_MS).toISOString(),
    isMachine: true,
    actorMembershipId: null,
    createdBy: null,
    replaceExisting: true,
    prefix: "sk_outerlayer_eval_",
  });

  return { key: plaintext };
}
