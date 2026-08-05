/**
 * Header-scoped, authenticated supabase-js client for request-tenant coverage.
 *
 * A dashboard request derives its tenant from the URL org and sends it to the
 * database as an `X-Tenant-Id` header; `public.tenant_id()` validates that
 * header against the caller's active membership and scopes the request to it (or
 * denies, fail-closed, when the caller is not a member). This helper reproduces
 * that exact wire path in a test: it returns a supabase-js client that runs under
 * an already-signed-in user's access token AND carries `X-Tenant-Id` on every
 * PostgREST call, so acceptance tests assert real RLS behavior through Kong →
 * PostgREST rather than stubbing the boundary.
 *
 * PostgREST lowercases the header into the `request.headers` GUC as `x-tenant-id`
 * — the exact key the resolver reads — so no rename or special casing is needed.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'tenant-dashboard/src/types/db';
import { retryingFetch } from './retrying-fetch';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * A signed-in test user whose session backs an authenticated client. Satisfied
 * by both `createAuthenticatedUser()` (TestUser) and the app-level-roles
 * fixtures (`createTenantWithOwner` / `addUserToTenant` → SameTenantUser).
 */
export interface AuthedTestUser {
  client: SupabaseClient<Database> | SupabaseClient;
}

/**
 * Return a supabase-js client that acts AS `user` but scopes every request to
 * `tenantId` via the `X-Tenant-Id` header — the server-derived signal the
 * middleware would attach for a `/orgs/[orgName]/…` request.
 *
 * The client is bound to the user's access token (never signs in itself, so it
 * holds no session state of its own) and injects the tenant header statically,
 * making it safe to build one per (user, tenant) pairing a test needs.
 */
export async function createTenantScopedClient(
  user: AuthedTestUser,
  tenantId: string,
): Promise<SupabaseClient<Database>> {
  const { data, error } = await user.client.auth.getSession();
  if (error || !data.session) {
    throw new Error(
      `createTenantScopedClient: user has no active session (${error?.message ?? 'no session'})`,
    );
  }
  const accessToken = data.session.access_token;

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // Run under the user's token without this client managing its own session,
    // so the static header below is the only per-request tenancy signal.
    accessToken: async () => accessToken,
    global: {
      headers: { 'X-Tenant-Id': tenantId },
      // Absorb transient local-Supabase gateway 502s under parallel CI load.
      fetch: retryingFetch,
    },
  });
}
