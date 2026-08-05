import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { evalsService } from "./service";
import type { EvalRunSummary } from "./types";

/**
 * The React Server Component (RSC) read behind the benchmarks page's run history: the app's persisted
 * runs, newest-first, resolved under the request tenant. The page calls this
 * server-side and seeds the history table — the table never fetches on
 * mount. Scoped by the `eval_run.read` RLS policy, so a caller without the
 * permission or outside the tenant gets an empty list.
 */
export async function loadEvalRunsForApp(
  appId: string,
  limit = 50,
): Promise<EvalRunSummary[]> {
  const ctx = await loadRequestServiceContext();
  return evalsService.list(ctx, appId, limit);
}
