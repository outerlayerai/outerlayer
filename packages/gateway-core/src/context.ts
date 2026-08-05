import type { GatewayRequest, Env } from "./types";
import type { LogContext } from "./types/context";

/**
 * Key used to store log context in request.context
 */
const LOG_CONTEXT_KEY = "__logContext";

/**
 * Generate a new UUID v4 for request IDs.
 * Uses crypto.randomUUID() which is available in Cloudflare Workers.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Create a LogContext from request information and environment.
 * Extracts tenantId and userId from authenticated user if available.
 */
export function createLogContext(request: GatewayRequest, env: Env): LogContext {
  // Extract from authenticated user if available (set by auth middleware)
  const tenantId = request.user?.tenantId;
  const userId = request.context?.userId as string | undefined;

  return {
    requestId: generateRequestId(),
    isProduction: env.NODE_ENV === "production",
    tenantId,
    userId,
  };
}

/**
 * Set the log context on the request object.
 * Call this early in the request lifecycle (e.g., in index.ts after auth).
 */
export function setLogContext(
  request: GatewayRequest,
  context: LogContext
): void {
  request.context ??= {};
  request.context[LOG_CONTEXT_KEY] = context;
}

/**
 * Get the log context from the request object.
 * Returns undefined if context hasn't been set.
 */
export function getLogContext(request: GatewayRequest): LogContext | undefined {
  if (!request.context) {
    return undefined;
  }
  return request.context[LOG_CONTEXT_KEY] as LogContext | undefined;
}

/**
 * Initialize log context on a request.
 * Combines createLogContext and setLogContext for convenience.
 */
export function initLogContext(request: GatewayRequest, env: Env): LogContext {
  const context = createLogContext(request, env);
  setLogContext(request, context);
  return context;
}
