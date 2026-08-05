import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";

/**
 * A real supabase-js client pointed at the MSW-intercepted local URL, for
 * service-layer unit tests: a service runs its queries through this client so
 * the PostgREST query shape (filters, ordering, the update payload) is
 * exercised against the MSW table handlers rather than a hand-faked query
 * chain. It lives here, outside the feature tree, because the feature layer's
 * admin-client rail keeps `createClient` out of feature files — a service test
 * takes the client as `ctx.db` instead of constructing one itself.
 *
 * The MSW-patched fetch is captured at construction and bound via
 * `global.fetch`: supabase-js resolves the global fetch lazily per request,
 * so a test that later calls `vi.stubGlobal("fetch", …)` to fake some other
 * service's HTTP would otherwise hijack this client's PostgREST traffic too.
 */
export function createMswRestClient(): SupabaseClient {
  const mswFetch = globalThis.fetch;
  return createClient(SUPABASE_URL, ANON, {
    global: { fetch: (...args) => mswFetch(...args) },
  });
}
