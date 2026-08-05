import { z } from "zod";

/**
 * The AI-cost settings form's write payload. Both fields are also clamped in
 * the service (`Math.max`/`Math.round`) so the DB CHECK constraints can never
 * be the thing that rejects a write; this schema exists to give the actor a
 * validation-class denial before any request reaches the database.
 */
export const updateAiCostConfigInput = z.object({
  seatCount: z.coerce.number().int().min(0),
  costPerSeatUsd: z.coerce.number().min(0),
});

export type UpdateAiCostConfigInput = z.infer<typeof updateAiCostConfigInput>;
