/** The AI-cost settings read/write shape (`public.ai_cost_config`, supabase/schemas/67-ai-cost-config.sql). */
export interface AiCostConfig {
  /** Paid AI tool seats across the org (blended across tools). */
  seatCount: number;
  /** Blended monthly $ per seat. */
  costPerSeatUsd: number;
}
