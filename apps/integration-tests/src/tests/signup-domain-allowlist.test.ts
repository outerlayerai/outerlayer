import { createClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient, SupabaseAdminClient } from '../lib/supabase-admin';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
// Well-known Supabase local-dev demo anon key (iss: supabase-demo) — the
// default baked into every `supabase start`, not a secret.
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// The exact message the before_user_created_hook returns; asserted verbatim
// because it is the caller-visible contract of the gate.
const REJECTION_MESSAGE =
  'Signups on this environment are restricted to approved email domains.';

const ALLOWED_DOMAIN = 'signup-gate-allowed.example';
const BLOCKED_DOMAIN = 'signup-gate-blocked.example';

// A non-empty allowlist gates EVERY signup on the shared local GoTrue, and the
// `parallel` vitest project runs test files concurrently. Almost every test
// creates users through the admin API, which the hook does not intercept —
// the one exception is registration-flow.test.ts, which exercises the real
// signup path. While this suite holds the gate open, every domain that file
// signs up with must be allowlisted, or its signups flake whenever the two
// files overlap. Keep this set a superset of registration-flow's domains.
const CONCURRENT_SUITE_DOMAINS = ['testcompany.com', 'gmail.com', 'protonmail.com'];

// Signups go straight to GoTrue with an anon client (not through the app's
// registration service) so the assertions pin the hook's own HTTP contract —
// status and message — rather than the app's error mapping.
const anonAuthClient = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const uniqueEmail = (domain: string) =>
  `signup-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${domain}`;

describe('signup domain allowlist (before_user_created_hook)', () => {
  let admin: SupabaseAdminClient;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    admin = createSupabaseAdminClient();
  });

  const clearAllowlist = async () => {
    const { error } = await admin
      .from('signup_domain_allowlist')
      .delete()
      .neq('domain', '');
    expect(error).toBeNull();
  };

  afterAll(async () => {
    // Clear the allowlist FIRST: test files run sequentially, and leftover
    // rows would gate every signup in the files that follow.
    await clearAllowlist();
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  describe('with an empty allowlist', () => {
    it('lets any domain sign up (gate off is the default posture)', async () => {
      await clearAllowlist();

      const email = uniqueEmail(BLOCKED_DOMAIN);
      const { data, error } = await anonAuthClient().auth.signUp({
        email,
        password: 'Str0ng!allowlist-pass',
      });

      expect(error).toBeNull();
      expect(data.user?.email).toBe(email);
      if (data.user) createdUserIds.push(data.user.id);
    });
  });

  describe('with a seeded allowlist', () => {
    beforeAll(async () => {
      const { error } = await admin
        .from('signup_domain_allowlist')
        .insert(
          [ALLOWED_DOMAIN, ...CONCURRENT_SUITE_DOMAINS].map((domain) => ({ domain })),
        );
      expect(error).toBeNull();
    });

    afterAll(async () => {
      await clearAllowlist();
    });

    it('rejects a non-allowlisted domain with 403 and the gate message', async () => {
      const { data, error } = await anonAuthClient().auth.signUp({
        email: uniqueEmail(BLOCKED_DOMAIN),
        password: 'Str0ng!allowlist-pass',
      });

      expect(error?.status).toBe(403);
      expect(error?.message).toBe(REJECTION_MESSAGE);
      expect(data.user).toBeNull();
    });

    it('accepts an allowlisted domain', async () => {
      const email = uniqueEmail(ALLOWED_DOMAIN);
      const { data, error } = await anonAuthClient().auth.signUp({
        email,
        password: 'Str0ng!allowlist-pass',
      });

      expect(error).toBeNull();
      expect(data.user?.email).toBe(email);
      if (data.user) createdUserIds.push(data.user.id);
    });

    it('matches the domain case-insensitively', async () => {
      const email = uniqueEmail(ALLOWED_DOMAIN);
      const upperCased = email.replace(`@${ALLOWED_DOMAIN}`, `@${ALLOWED_DOMAIN.toUpperCase()}`);
      const { data, error } = await anonAuthClient().auth.signUp({
        email: upperCased,
        password: 'Str0ng!allowlist-pass',
      });

      expect(error).toBeNull();
      // GoTrue stores the address lowercased; the hook must have accepted the
      // mixed-case submission for that stored row to exist.
      expect(data.user?.email).toBe(email);
      if (data.user) createdUserIds.push(data.user.id);
    });
  });
});
