import { retryingFetch } from './retrying-fetch';

/**
 * Installs `retryingFetch` as `globalThis.fetch` for the `acceptance` project.
 *
 * The acceptance suites drive real Server Actions in-process (not over HTTP),
 * so the production Supabase client they exercise (`createSupabaseServerClient`,
 * built on `@supabase/ssr`'s `createServerClient`) uses whatever `globalThis.fetch`
 * is current — production code deliberately takes no retry seam of its own
 * (`checkRequestPermission`: "Fail-closed: an RPC error surfaces rather than
 * granting"). Under this suite's concurrent local-Supabase load, a transient
 * Kong/PostgREST gateway blip on that call surfaces as a real `internal_error`
 * from a permission check that should have resolved cleanly — the same class of
 * blip `retryingFetch`/`retryOnTransientError` already absorb for the test
 * fixtures' own admin-client calls. This closes the gap for the production code
 * path under test without adding any retry to that production code itself.
 *
 * Captured once, before any test file's `vi.stubGlobal('fetch', …)` can run —
 * a spec that intentionally stubs fetch for its own mocking still overrides
 * this for its own scope, and `vi.unstubAllGlobals()` restores this wrapper,
 * not raw `fetch`, afterward.
 */
export function installRetryingGlobalFetch(): void {
  const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    retryingFetch(input, init, undefined, undefined, originalFetch)) as typeof fetch;
}
