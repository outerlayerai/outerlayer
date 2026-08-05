/**
 * Test stub for `next/cache`, aliased the same way as `next/headers` (see that
 * stub for why aliasing, not `vi.mock`, is required). The real
 * `revalidatePath`/`revalidateTag` require a Next request/build scope that does
 * not exist when a server action is invoked directly in a test — calling them
 * outside that scope throws. Actions under test (e.g. `src/features/escalations/actions.ts`,
 * `src/features/topics/actions.ts`, `src/actions/env-var-actions.ts`) call these
 * as a side effect after a mutation; the no-op here lets the action body run to
 * completion so the test can assert on its return value / DB effect instead of
 * crashing on the cache call.
 */
export function revalidatePath(): void {}

export function revalidateTag(): void {}

/**
 * `unstable_cache` wraps a function in Next's build-time data cache. Outside a
 * Next request/build scope there is nothing to cache into, and caching across
 * tests would leak state between cases (a different tenant's seed data
 * returned from a prior test's cache entry) — so this passes the wrapped
 * function through uncached rather than reimplementing the cache semantics.
 */
export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
