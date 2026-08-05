import 'server-only';

/**
 * Re-exports the shared server-logger singleton so callers depend on this
 * named crossing rather than reaching into `@/lib/observability` directly.
 */
export { serverLogger } from '@/lib/observability/server-logger';
