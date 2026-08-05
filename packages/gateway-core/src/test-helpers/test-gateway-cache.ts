/**
 * An isolated `GatewayCache` for unit tests.
 *
 * Uses the real namespaces so tests get production TTL behavior, but over a
 * fresh store each call. The shared `memory` store would leak entries between
 * tests and make cache-hit assertions depend on test order.
 */
import { MemoryStore } from '@unkey/cache/stores';
import { NoopCacheStore } from '../runtime/adapters/noop-cache-store';
import { initCache } from '../utils';
import type { GatewayCache } from '../types';
import type { ExecutionCtx } from '../runtime/execution';

const noopExecutionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionCtx;

/** Fresh cache with empty stores. Call once per test that asserts on hits. */
export function createTestGatewayCache(): GatewayCache {
  return initCache(
    new NoopCacheStore(),
    noopExecutionCtx,
    new MemoryStore({ persistentMap: new Map() }),
  );
}
