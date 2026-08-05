/**
 * Tests for github/oauth.ts.
 *
 * `saveGitHubIdentity` is the only function in the module after the
 * dead-code cleanup. Mutation targets: OptionalChaining on `user?.id`,
 * LogicalOperator on `email || null`, the literal `'github'` provider
 * string, the upsert conflict key `'profile_id, provider'`, and the
 * field-name spellings (`profile_id`, `username`, `provider_user_id`).
 *
 * Boundary: the SupabaseClient is dependency-injected — passing a mock
 * directly is the cheapest and clearest assertion surface. No MSW
 * scaffolding needed for an injected interface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { saveGitHubIdentity } from '../oauth';

function makeMockSupabase(user: { id: string } | null) {
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const from = vi.fn().mockReturnValue({ upsert });
  return {
    client: {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user }, error: null }),
      },
      from,
    } as unknown as SupabaseClient,
    from,
    upsert,
  };
}

describe('saveGitHubIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts user_git_identity with profile_id, provider="github", username, email, provider_user_id', async () => {
    const { client, from, upsert } = makeMockSupabase({ id: 'user-1' });

    await saveGitHubIdentity(client, 'octocat', 'octo@example.com', 'gh-user-42');

    expect(from).toHaveBeenCalledWith('user_git_identity');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      {
        profile_id: 'user-1',
        provider: 'github',
        username: 'octocat',
        email: 'octo@example.com',
        provider_user_id: 'gh-user-42',
      },
      { onConflict: 'profile_id, provider' },
    );
  });

  it('stores null for email when caller omits it', () => {
    // The `email || null` fallback — a mutation to `email && null` would
    // store undefined for any non-empty email, breaking the column.
    const { client, upsert } = makeMockSupabase({ id: 'user-2' });

    return saveGitHubIdentity(client, 'no-email-user').then(() => {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ email: null }),
        expect.anything(),
      );
    });
  });

  it('stores null for provider_user_id when caller omits it', async () => {
    const { client, upsert } = makeMockSupabase({ id: 'user-3' });

    await saveGitHubIdentity(client, 'username-only');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ provider_user_id: null }),
      expect.anything(),
    );
  });

  it('stores null for both email AND provider_user_id when both are empty strings', () => {
    // Edge: empty string is falsy, so `'' || null` evaluates to null.
    // Pinning this so a mutation that flips `||` to `??` (which would
    // preserve the empty string) is caught.
    const { client, upsert } = makeMockSupabase({ id: 'user-4' });

    return saveGitHubIdentity(client, 'u', '', '').then(() => {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ email: null, provider_user_id: null }),
        expect.anything(),
      );
    });
  });

  it('does NOTHING when there is no authenticated user', async () => {
    // OptionalChaining + truthy-check: `if (user?.id)`. The function must
    // be a no-op if getUser() returns null. Otherwise we'd insert a row
    // with `profile_id: undefined`, breaking the NOT NULL constraint.
    const { client, from, upsert } = makeMockSupabase(null);

    await saveGitHubIdentity(client, 'orphan', 'orphan@example.com');

    expect(from).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does NOTHING when getUser returns a user without an id', async () => {
    // `user?.id` is falsy — the optional chain returns undefined.
    const { client, from, upsert } = makeMockSupabase({} as { id: string });

    await saveGitHubIdentity(client, 'no-id', 'noid@example.com');

    expect(from).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('always uses the literal provider string "github" (catches StringLiteral mutations)', async () => {
    // Pinning the provider literal — a mutation that drops or alters the
    // string would mis-route the identity to the wrong provider scope.
    const { client, upsert } = makeMockSupabase({ id: 'u' });

    await saveGitHubIdentity(client, 'x');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github' }),
      expect.anything(),
    );
  });

  it('uses the exact onConflict key "profile_id, provider"', async () => {
    // Pinning the conflict key — a mutation that changes it (e.g. drops
    // the provider half) would let two identities for the same profile
    // collide silently and overwrite each other.
    const { client, upsert } = makeMockSupabase({ id: 'u' });

    await saveGitHubIdentity(client, 'x');

    expect(upsert).toHaveBeenCalledWith(expect.anything(), {
      onConflict: 'profile_id, provider',
    });
  });
});
