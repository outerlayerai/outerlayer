import { z } from "zod";

/**
 * The ack/resolve transition input. `status` is the only mutation target —
 * `open` is never a transition destination (a row is born open; reopening is a
 * new escalation), so the enum here is what enforces the "no bogus target"
 * rejection at the action boundary before any DB round-trip.
 */
export const transitionEscalationInput = z.object({
  appId: z.uuid(),
  escalationId: z.uuid(),
  status: z.enum(["acked", "resolved"]),
});

export type TransitionEscalationInput = z.infer<typeof transitionEscalationInput>;
