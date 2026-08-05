import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { escalationsService } from "./service";
import type { EnvEscalationRow } from "./types";

/**
 * The React Server Component (RSC) read behind the queue: the actionable set (open + acked) for one
 * app, resolved under the request tenant. The benchmarks page calls this
 * server-side and seeds the card — the card never fetches. Reads are scoped
 * by the `env_escalation.read` RLS policy, so a caller without the permission
 * or outside the tenant gets an empty list, and the card self-hides.
 */
export async function loadEscalationsForApp(appId: string): Promise<EnvEscalationRow[]> {
  const ctx = await loadRequestServiceContext();
  return escalationsService.list(ctx, appId);
}
