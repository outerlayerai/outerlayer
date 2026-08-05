import { z } from "zod";

/**
 * LogContext - Request-scoped context stored in request.context
 * Automatically injected into all logs and traces
 */
export const LogContextSchema = z.object({
  /** Current tenant ID (no PII) */
  tenantId: z.string().uuid().optional(),

  /** Current user ID (no PII - not email) */
  userId: z.string().uuid().optional(),

  /** Unique request identifier (UUID) */
  requestId: z.string().uuid(),

  /** Whether running in production */
  isProduction: z.boolean(),
});

export type LogContext = z.infer<typeof LogContextSchema>;
