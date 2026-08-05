/**
 * Acceptance: internal SECURITY DEFINER functions are not callable by anon or
 * authenticated.
 *
 * A SECURITY DEFINER function in the public schema is reachable over
 * `/rest/v1/rpc/*` by anyone the EXECUTE grant admits, and it runs with the
 * definer's privileges. Two rules keep that surface closed:
 *   - JWT-reading authz helpers live in the unexposed `private` schema, with
 *     thin public SECURITY INVOKER wrappers for external callers.
 *   - Internal/service-role/trigger functions hold no PUBLIC/anon/authenticated
 *     EXECUTE grant (96-function-execution-grants.sql).
 *
 * These run against a REAL local Supabase, asserting the live grant state — the
 * exact surface a mocked unit test cannot exercise. They lock two contracts:
 *   1. Negative: anon AND authenticated are denied the internal functions, so a
 *      `GRANT ... TO authenticated` that reopens the surface fails here as a
 *      fast, named test.
 *   2. Positive: the public INVOKER wrappers stay callable by authenticated, so
 *      the gateway/dashboard permission checks keep working.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createAuthenticatedUser, cleanupTestUsers, type TestUser } from '../../lib/test-utils';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// A function with no EXECUTE grant returns a 403 "permission denied for
// function"; one that is not exposed in the API schema at all returns
// PostgREST's "Could not find the function ... in the schema cache" (PGRST202).
const DENIED = /permission denied|could not find|not exist|forbidden|schema cache/i;

// These tests deliberately probe functions by name at runtime, including ones
// absent from the public RPC types because they live in the private schema
// (e.g. platform_authorize). The typed client only accepts the known-function
// union, so call through an untyped view for the dynamic probes.
const rpcByName = (
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: { message?: string } | null }> =>
  (client.rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>)(
    name,
    args,
  );

describe('SECURITY DEFINER execution grants', () => {
  let anon: SupabaseClient;
  let user: TestUser;

  beforeAll(async () => {
    anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    user = await createAuthenticatedUser('owner');
  });

  afterAll(async () => {
    await cleanupTestUsers();
  });

  // Each entry: rpc name + a representative arg payload (values are irrelevant —
  // the EXECUTE-privilege check fires before the body runs).
  const internalFns: Array<{ name: string; args: Record<string, unknown> }> = [
    // Vault secrets — an anon- or authenticated-callable grant here exposes
    // every tenant's secrets over RPC.
    { name: 'read_secret', args: { secret_name: 'x' } },
    { name: 'insert_secret', args: { name: 'x', secret: 'y' } },
    { name: 'delete_secret', args: { secret_name: 'x' } },
    // JWT claims mutation.
    { name: 'set_claim', args: { uid: '00000000-0000-0000-0000-000000000000', claim: 'x', value: {} } },
    { name: 'get_claim', args: { uid: '00000000-0000-0000-0000-000000000000', claim: 'x' } },
    // Privileged transaction / provisioning RPCs.
    {
      name: 'create_organization_transaction',
      args: { p_user_id: '00000000-0000-0000-0000-000000000000', p_organization_name: 'x', p_company_name: 'x', p_stripe_customer_id: 'x' },
    },
    // Auth hook — a revoke from authenticated and anon alone leaves it reachable
    // through the default PUBLIC grant.
    { name: 'custom_access_token_hook', args: { event: {} } },
    // Internal RLS helper: lives in the private schema, no public RPC.
    { name: 'platform_authorize', args: { required_permission: 'platform.environment.read' } },
  ];

  describe.each(internalFns)('internal function $name', ({ name, args }) => {
    it('is NOT executable by anon', async () => {
      const { error } = await rpcByName(anon, name, args);
      expect(error).not.toBeNull();
      expect(error?.message ?? '').toMatch(DENIED);
    });

    it('is NOT executable by an authenticated user', async () => {
      const { error } = await rpcByName(user.client, name, args);
      expect(error).not.toBeNull();
      expect(error?.message ?? '').toMatch(DENIED);
    });
  });

  describe('public INVOKER wrappers remain callable by authenticated', () => {
    const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

    it('authorize() executes and returns a boolean (no permission error)', async () => {
      const { data, error } = await user.client.rpc('authorize', { requested_permission: 'app.read' });
      expect(error).toBeNull();
      expect(typeof data).toBe('boolean');
    });

    it('app_authorize() executes and returns a boolean (no permission error)', async () => {
      const { data, error } = await user.client.rpc('app_authorize', {
        requested_permission: 'app.read',
        target_app_id: ZERO_UUID,
      });
      expect(error).toBeNull();
      expect(typeof data).toBe('boolean');
    });

    it('get_current_user_app_permissions() executes and returns an array', async () => {
      const { data, error } = await user.client.rpc('get_current_user_app_permissions', {
        target_app_id: ZERO_UUID,
      });
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
