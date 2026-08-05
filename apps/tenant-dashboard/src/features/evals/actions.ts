"use server";

import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";

import { evalsService } from "./service";
import { launchEvalRunInput, listEvalRunsInput } from "./schemas";

/** The benchmarks route that renders the run history; re-seeded after a launch. */
const BENCHMARKS_PATH = "/orgs/[orgName]/apps/[appName]/env/[envName]/benchmarks";

/**
 * Launch a Report Card run. Validates the two configs + environment, authorizes
 * the app-scoped `eval_run.insert` (a read-only role is refused here, before any
 * Vault read or credential mint), and delegates to the single dispatch call.
 * The just-queued run is surfaced by re-rendering the React Server Component (RSC) that owns the
 * history read (revalidatePath), not a client refetch.
 */
export const launchEvalRun = authorizedAction({
  input: launchEvalRunInput,
  permission: "eval_run.insert",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const result = await evalsService.dispatch(ctx, input);
    revalidatePath(BENCHMARKS_PATH, "page");
    return result;
  },
});

/**
 * Re-read the app's run history on demand. The RSC seeds the history at
 * render time (`revalidatePath` after a launch re-seeds it too), but a
 * dispatched run's terminal status/cost land later — written by the worker
 * while the client is mid-poll — so the client calls this once the poll ends
 * to pick up the just-finished run without a page reload. `eval_run.read` is
 * held by every role (including read-only), matching the RLS SELECT policy
 * the underlying query runs under.
 */
export const refreshEvalRuns = authorizedAction({
  input: listEvalRunsInput,
  permission: "eval_run.read",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    return evalsService.list(ctx, input.appId);
  },
});
