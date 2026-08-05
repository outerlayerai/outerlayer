"use server";

import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";

import { escalationsService } from "./service";
import { transitionEscalationInput } from "./schemas";
import type { EnvEscalationRow } from "./types";

/** The benchmarks route that renders the queue; re-seeded after a transition. */
const BENCHMARKS_PATH = "/orgs/[orgName]/apps/[appName]/env/[envName]/benchmarks";

/**
 * Outcome of an ack/resolve attempt. `not_found` is a business outcome, not a
 * failure of the action itself — the caller's `appId` passed authorization,
 * so the missing row (unknown id or a foreign tenant's, indistinguishable
 * under RLS — no oracle) still deserves an `ok: true` envelope, matching how
 * `cancelWorkerAction` (`features/workers/actions.ts`) surfaces its own
 * no-row case through this same wrapper. An illegal transition is a
 * programming/state error instead, so it still throws and maps to
 * `internal_error` via the wrapper's catch-all.
 */
type TransitionEscalationResult = { kind: "ok"; escalation: EnvEscalationRow } | { kind: "not_found" };

/**
 * Ack/resolve one escalation. Validates `{appId, escalationId, status}`,
 * authorizes the app-scoped `env_escalation.update` (the only mutation
 * permission — a read-only role is denied here, matching the RLS UPDATE
 * policy), and delegates to the single service call. Freshness comes from
 * re-rendering the React Server Component (RSC) that owns the read (revalidatePath), not a client
 * refetch — so it runs only on a real transition, never on the not-found path.
 */
export const transitionEscalation = authorizedAction({
  input: transitionEscalationInput,
  permission: "env_escalation.update",
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<TransitionEscalationResult> => {
    const updated = await escalationsService.transition(ctx, input);
    if (!updated) {
      return { kind: "not_found" };
    }
    revalidatePath(BENCHMARKS_PATH, "page");
    return { kind: "ok", escalation: updated };
  },
});
