/**
 * Acceptance: the feature_flag table is not readable through the Data API.
 *
 * anon holds SELECT on the table, so an unrestricted read predicate would let
 * anyone holding the publishable key enumerate every flag — key, description,
 * and enabled state, including unshipped features. The publishable key ships in
 * the browser bundle, so "holds the key" means "opened the site".
 *
 * These drive a real PostgREST client rather than `SET ROLE` on a direct
 * connection, because PostgREST is the exposure path: the publishable key is
 * what an outsider actually has, and a `SET ROLE` test would pass against a
 * database whose API-side grants had drifted.
 *
 * The service-role case is not a formality. Every production reader bypasses
 * RLS through an admin client — the gateway's flag evaluation, the dashboard's
 * flag evaluation, and the platform-admin management UI — so a policy change
 * that silently broke flag evaluation would look identical to a fix from the
 * anon side alone. It is asserted here so tightening the policy further cannot
 * quietly disable every gated feature.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  type SameTenantUser,
} from '../app-level-roles/helpers';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

describe('feature_flag is not readable through the Data API', () => {
  const admin = createSupabaseAdminClient();
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let owner: SameTenantUser; // an ordinary authenticated user, not a platform admin
  let flagKey: string;
  let flagId: string;

  beforeAll(async () => {
    owner = await createTenantWithOwner();

    flagKey = `unreleased_${randomUUID().slice(0, 8)}`;
    const { data, error } = await admin
      .from('feature_flag')
      .insert({
        key: flagKey,
        description: 'not shipped yet',
        is_enabled: false,
        strategy: 'global',
      })
      .select('id')
      .single();
    if (error) throw new Error(`seed flag: ${error.message}`);
    flagId = data.id;
  });

  afterAll(async () => {
    await admin.from('feature_flag').delete().eq('id', flagId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
  });

  it('returns nothing to an anonymous caller holding the publishable key', async () => {
    const { data, error } = await anon.from('feature_flag').select('key, description, is_enabled');

    // RLS filters rather than rejects, so the tell is an empty set with no
    // error — asserting on `error` alone would pass against a wide-open table.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('returns nothing to an authenticated user who is not a platform admin', async () => {
    const { data, error } = await owner.client
      .from('feature_flag')
      .select('key')
      .eq('key', flagKey);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('still serves the flag to the service-role clients every reader uses', async () => {
    const { data, error } = await admin
      .from('feature_flag')
      .select('key, description, is_enabled')
      .eq('id', flagId)
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({
      key: flagKey,
      description: 'not shipped yet',
      is_enabled: false,
    });
  });
});
