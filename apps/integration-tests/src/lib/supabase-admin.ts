import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'tenant-dashboard/src/types/db';
import { retryingFetch } from './retrying-fetch';

export type SupabaseAdminClient = SupabaseClient<Database>;

const ADMIN_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
// Well-known Supabase local-dev demo service_role key (iss: supabase-demo).
// Local/CI only — the default baked into every `supabase start`, NOT a
// production secret. Overridden by SUPABASE_SERVICE_ROLE_KEY when set.
const ADMIN_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const ADMIN_AUTH_OPTS = { autoRefreshToken: false, persistSession: false } as const;

// Capture the real fetch ONCE, at module load — before any spec's `beforeEach`
// can `vi.stubGlobal('fetch', …)`. The admin client routes every DB query
// through `adminFetch`; pinning the underlying fetch here keeps those queries on
// the real transport even in a spec that stubs the global to mock its own
// code-under-test (e.g. dispatch-webhook-multi-env stubs fetch for the
// gateway/webhook calls). Without this, PostgREST would receive the stub's body
// and throw `"…" is not valid JSON`. This mirrors how supabase-js captured the
// default global fetch at client-creation time before the retry wrapper existed.
const REAL_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);
const adminFetch: typeof fetch = (input, init) =>
  retryingFetch(input, init, undefined, undefined, REAL_FETCH);

export function createSupabaseAdminClient(): SupabaseAdminClient {
  return createClient<Database>(ADMIN_URL, ADMIN_SERVICE_KEY, {
    auth: ADMIN_AUTH_OPTS,
    db: { schema: 'public' },
    // Absorb transient local-Supabase gateway 502s under parallel CI load.
    global: { fetch: adminFetch },
  });
}

// Untyped variant (no Database generic) for callers that address tables and
// columns dynamically — e.g. generic test helpers that loop over many tables by
// name. Same URL + key as the typed client; dropping the generic lets dynamic
// `.from(string)` / `.insert(record)` type-check honestly instead of via a cast.
export function createSupabaseAdminClientUntyped(): SupabaseClient {
  return createClient(ADMIN_URL, ADMIN_SERVICE_KEY, {
    auth: ADMIN_AUTH_OPTS,
    global: { fetch: adminFetch },
  });
}
