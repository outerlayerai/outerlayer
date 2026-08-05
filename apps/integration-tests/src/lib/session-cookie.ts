/**
 * Mints a real session-cookie jar for an already-signed-in test user and loads
 * it into the `next/headers` stub, so any code path that builds a client via
 * `createSupabaseServerClient` (apps/tenant-dashboard/src/supabaseServerClient.ts)
 * sees the exact cookie set a real login response would have produced.
 *
 * How the mint works: `createAuthenticatedUser()`/`createTenantWithOwner()`
 * already sign the user in against local GoTrue, so a genuine access/refresh
 * token pair is in hand (`user.client.auth.getSession()`). We hand that pair to
 * a throwaway `@supabase/ssr` `createServerClient` bound to an in-memory jar and
 * call `auth.setSession(...)`. `setSession` awaits its `onAuthStateChange`
 * subscribers before returning (`GoTrueClient._setSession` → `_notifyAllSubscribers`),
 * and `createServerClient`'s own subscriber (`applyServerStorage`) is what writes
 * the cookie set via the jar's `setAll` — correct name (`sb-<host>-auth-token`),
 * base64url encoding, and chunking, entirely delegated to the installed package.
 * We never construct or parse a Supabase cookie ourselves.
 */
import { createServerClient } from '@supabase/ssr';
import type { AuthedTestUser } from './tenant-scoped-client';
import { __setCookies, __resetCookies, __setHeader, __resetHeaders } from '../stubs/next-headers';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * Mint a real session-cookie jar for `user` and load it into the `next/headers`
 * stub. After this resolves, any `createSupabaseServerClient()` call made by
 * the code under test (in this same test file, same module registry) reads
 * back that user's session — `auth.getUser()`, `authorize`/`app_authorize`, and
 * every `ctx.db` query run as that user against the real local stack, RLS
 * enforced, exactly as a signed-in request would.
 */
export async function actAs(user: AuthedTestUser): Promise<void> {
  const { data, error } = await user.client.auth.getSession();
  if (error || !data.session) {
    throw new Error(`actAs: user has no active session (${error?.message ?? 'no session'})`);
  }
  const { access_token, refresh_token } = data.session;

  const jar = new Map<string, string>();
  const mintClient = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return Array.from(jar.entries()).map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          jar.set(name, value);
        }
      },
    },
  });

  const { error: setSessionError } = await mintClient.auth.setSession({
    access_token,
    refresh_token,
  });
  if (setSessionError) {
    throw new Error(`actAs: failed to mint session cookies (${setSessionError.message})`);
  }
  if (jar.size === 0) {
    throw new Error('actAs: setSession produced no cookies — @supabase/ssr cookie mint contract broke');
  }

  __setCookies(Array.from(jar.entries()).map(([name, value]) => ({ name, value })));
}

/**
 * `actAs` plus the `x-tenant-id` header — reproduces the full middleware-shaped
 * request for an `/orgs/[orgName]/…` route: URL-derived tenant header + cookie
 * session, both read by `createSupabaseServerClient(tenantId)` callers.
 */
export async function actAsInOrg(user: AuthedTestUser, tenantId: string): Promise<void> {
  await actAs(user);
  __setHeader('x-tenant-id', tenantId);
}

/**
 * Reset both the cookie jar and the header store. Call in `afterEach` for any
 * test file using this fixture — stub state is per test file (vitest isolates
 * module registries per file) but shared within a file across sequential tests.
 */
export function resetRequestScope(): void {
  __resetCookies();
  __resetHeaders();
}
