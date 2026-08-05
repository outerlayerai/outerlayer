import "server-only";

import { loadRequestServiceContext } from "@/lib/adapters";

import { aiCostService } from "./service";
import type { AiCostConfig } from "./types";

/**
 * The React Server Component (RSC) read behind the AI-costs settings page: the request tenant's
 * config. Scoped by `ai_cost_config.read` RLS, so a caller without the
 * permission gets null and the page renders the zero-state form rather than
 * throwing.
 */
export async function loadAiCostConfig(): Promise<AiCostConfig | null> {
  const ctx = await loadRequestServiceContext();
  return aiCostService.getConfig(ctx);
}
