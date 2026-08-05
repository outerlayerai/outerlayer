/**
 * Integration test for the user_git_identity SELECT owner-scoping (Medium M1).
 *
 * The SELECT policy on public.user_git_identity must scope to
 * `profile_id = auth.uid()`, matching its sibling INSERT/UPDATE/DELETE
 * policies. A tenant-wide SELECT (`tenant_id() = tenant_id` only) would let
 * any tenant member read every colleague's row — (app-layer-encrypted)
 * access_token / refresh_token plus email / provider_user_id. This drives
 * real RLS through a member's own authenticated client to prove the read is
 * owner-scoped.
 */

import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createAuthenticatedUser, cleanupTestUsers } from '../../lib/test-utils';

describe('user_git_identity SELECT owner-scoping (M1)', { retry: 2 }, () => {
  let supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;

  beforeAll(() => {
    supabaseAdmin = createSupabaseAdminClient();
  });

  afterEach(async () => {
    await cleanupTestUsers();
  });

  it("does not let a member read a colleague's git identity in the same tenant", async () => {
    const alice = await createAuthenticatedUser('owner'); // owns tenant T
    const bob = await createAuthenticatedUser('read');

    // Bob is a colleague in Alice's tenant.
    const { error: memErr } = await supabaseAdmin.from('membership').insert({
      user_id: bob.id,
      tenant_id: alice.tenantId,
      role: 'read',
      status: 'active',
    });
    expect(memErr).toBeNull();

    // Both connect a git identity (written server-side by the OAuth callback).
    const { error: idErr } = await supabaseAdmin.from('user_git_identity').insert([
      {
        profile_id: alice.id,
        tenant_id: alice.tenantId,
        provider: 'github',
        username: 'alice',
        provider_user_id: 'gh-alice',
        email: 'alice@example.com',
        access_token: 'enc-alice-token',
      },
      {
        profile_id: bob.id,
        tenant_id: alice.tenantId,
        provider: 'github',
        username: 'bob',
        provider_user_id: 'gh-bob',
        email: 'bob@example.com',
        access_token: 'enc-bob-token',
      },
    ]);
    expect(idErr).toBeNull();

    // Alice reads user_git_identity through her OWN authenticated client (RLS on).
    const { data, error } = await alice.client
      .from('user_git_identity')
      .select('profile_id, username, email, access_token');

    expect(error).toBeNull();
    // She sees ONLY her own identity — never Bob's token/email/provider id.
    expect(data).toHaveLength(1);
    expect(data?.[0]?.profile_id).toBe(alice.id);
    expect((data ?? []).map((row) => row.profile_id)).not.toContain(bob.id);
  });

  it('still lets a member read their own git identity', async () => {
    const alice = await createAuthenticatedUser('owner');

    const { error: idErr } = await supabaseAdmin.from('user_git_identity').insert({
      profile_id: alice.id,
      tenant_id: alice.tenantId,
      provider: 'github',
      username: 'alice',
      provider_user_id: 'gh-alice',
      email: 'alice@example.com',
      access_token: 'enc-alice-token',
    });
    expect(idErr).toBeNull();

    const { data, error } = await alice.client
      .from('user_git_identity')
      .select('profile_id, username');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.profile_id).toBe(alice.id);
  });
});
