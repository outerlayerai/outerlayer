import { MemoryStore } from "@unkey/cache/stores";

/**
 * Shared in-process memory store for the gateway cache.
 * Survives across requests within the same Worker instance.
 * Lives in its own module, not in index.ts, so chanfana routes can
 * initialize caches without a circular import.
 */
export const memory = new MemoryStore({ persistentMap: new Map() });
