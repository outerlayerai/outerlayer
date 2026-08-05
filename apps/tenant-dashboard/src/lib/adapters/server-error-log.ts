/**
 * Narrow bridge to the shared server logger — React Server Component (RSC) context resolvers and
 * services log an unexpected error through this instead of reaching into
 * `@/lib/observability` directly.
 */
import { serverLogger } from '@/lib/observability/server-logger'

export async function logServerError(
  error: unknown,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await serverLogger.error(error instanceof Error ? error : new Error(String(error)), metadata)
}

export async function logServerInfo(
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await serverLogger.info(message, metadata)
}
