"use server";

import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";

import { aiCostService } from "./service";
import { updateAiCostConfigInput } from "./schemas";

const AI_COSTS_SETTINGS_PATH = "/orgs/[orgName]/settings/ai-costs";

/**
 * Upserts the org's AI-cost config. Gated `ai_cost_config.update` — the RLS
 * UPDATE policy backs the same check, so a denial here and a denial at the
 * DB agree; the action just gets there first with a typed response instead
 * of a raw PostgREST error. `tenantId` always comes from the resolved
 * request context, never client input. A role holding `update` but not
 * `insert` is denied at the DB on a tenant's first-ever configure — that is
 * correct fail-closed behaviour, not a bug.
 */
export const updateAiCostConfigAction = authorizedAction({
  input: updateAiCostConfigInput,
  permission: "ai_cost_config.update",
  handler: async (ctx, input) => {
    const updated = await aiCostService.upsertConfig(ctx, input);
    revalidatePath(AI_COSTS_SETTINGS_PATH, "page");
    return updated;
  },
});
