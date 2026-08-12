/**
 * `pr_session_comment` tenancy acceptance — the RLS policy is the ONLY guard
 * on this table, so it gets a real-Postgres test rather than a mocked one.
 *
 * Why this table specifically. Its rows identify `(tenant, repository,
 * pr_number)` — which repositories an org works in, and which of their PRs an
 * agent touched. The schema now REVOKEs the legacy default grants and
 * re-grants only SELECT to `authenticated`, but "only SELECT" still means
 * every authenticated user in the system can attempt a read; what keeps one
 * org's rows out of another's result set is the single SELECT policy keyed on
 * `public.tenant_id()`. Nothing else. A future permissive policy, or an
 * accidental `ENABLE ROW LEVEL SECURITY` regression, would be invisible to
 * every unit test in this feature because they all run against a mocked
 * PostgREST that has no policies at all.
 *
 * So the claims here are deliberately about the boundary, not the feature:
 * a member of org B cannot read org A's rows, and an anonymous caller can
 * neither read nor write. The orchestrator's behaviour is covered by
 * `refresh.test.ts`.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { supabase as anonClient } from '../../lib/supabase';
import { createTenantWithOwner, SameTenantUser } from '../app-level-roles/helpers';

const REPO_A = 'acme/api';
const REPO_B = 'globex/web';
const PR_A = 4101;
const PR_B = 4102;

describe('pr_session_comment is readable only within its own tenant', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser;
  let orgB: SameTenantUser;

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();

    // Seed one identity row per org through the service role, the way the
    // orchestrator writes them.
    const { error } = await admin.from('pr_session_comment').insert([
      {
        tenant_id: orgA.tenantId,
        repository: REPO_A,
        pr_number: PR_A,
        github_comment_id: 900001,
        last_body_hash: 'hash-a',
      },
      {
        tenant_id: orgB.tenantId,
        repository: REPO_B,
        pr_number: PR_B,
        github_comment_id: 900002,
        last_body_hash: 'hash-b',
      },
    ]);
    if (error) throw new Error(`seed pr_session_comment: ${error.message}`);
  }, 90000);

  afterAll(async () => {
    // Guarded: if `beforeAll` died partway (a stack that isn't up, a seed
    // that failed), cleanup must not throw a second, more confusing error
    // over the top of the real one.
    const seeded = [orgA, orgB].filter(Boolean);
    if (seeded.length === 0) return;
    const tenantIds = seeded.map((u) => u.tenantId);
    await admin.from('pr_session_comment').delete().in('tenant_id', tenantIds);
    await admin.from('membership').delete().in('user_id', seeded.map((u) => u.id));
    for (const user of seeded) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', tenantIds);
  });

  it("a member sees only their own tenant's rows, never another tenant's", async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    // An UNFILTERED read: whatever comes back is exactly what the policy
    // allows, so a policy that stopped filtering would surface here.
    const { data, error } = await asA.from('pr_session_comment').select('tenant_id, repository, pr_number');

    expect(error).toBeNull();
    expect(data).toEqual([
      { tenant_id: orgA.tenantId, repository: REPO_A, pr_number: PR_A },
    ]);
  });

  it("naming another tenant's row explicitly still returns nothing", async () => {
    const asB = await createTenantScopedClient(orgB, orgB.tenantId);

    // Org B knows org A's repo and PR number — a public repo makes both
    // public knowledge. Knowing the key must not be enough to read the row.
    const { data, error } = await asB
      .from('pr_session_comment')
      .select('id')
      .eq('repository', REPO_A)
      .eq('pr_number', PR_A);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('an anonymous caller can neither read nor write', async () => {
    const { data: readData } = await anonClient
      .from('pr_session_comment')
      .select('id');
    // Denied outright or filtered to nothing — either is fail-closed; what
    // must never happen is a row coming back.
    expect(readData ?? []).toEqual([]);

    const { error: writeError } = await anonClient.from('pr_session_comment').insert({
      tenant_id: orgA.tenantId,
      repository: REPO_A,
      pr_number: 999999,
      last_body_hash: 'anon-write',
    });
    expect(writeError).not.toBeNull();

    // And nothing landed.
    const { data: rows } = await admin
      .from('pr_session_comment')
      .select('id')
      .eq('pr_number', 999999);
    expect(rows).toEqual([]);
  });

  it('an authenticated member cannot write either — SELECT is the only grant', async () => {
    const asA = await createTenantScopedClient(orgA, orgA.tenantId);

    // The comment identity is written by the service-role orchestrator only.
    // A dashboard user holding a valid session must not be able to forge or
    // repoint one, which would hand them an edit target in someone else's
    // repository.
    const { error: insertError } = await asA.from('pr_session_comment').insert({
      tenant_id: orgA.tenantId,
      repository: REPO_A,
      pr_number: 888888,
      last_body_hash: 'member-write',
    });
    expect(insertError).not.toBeNull();

    const { error: updateError, data: updated } = await asA
      .from('pr_session_comment')
      .update({ github_comment_id: 123 })
      .eq('tenant_id', orgA.tenantId)
      .eq('pr_number', PR_A)
      .select('id');
    // Either a hard denial or zero rows affected; never a successful repoint.
    expect(updateError !== null || (updated ?? []).length === 0).toBe(true);

    const { data: unchanged } = await admin
      .from('pr_session_comment')
      .select('github_comment_id')
      .eq('tenant_id', orgA.tenantId)
      .eq('pr_number', PR_A);
    expect(unchanged).toEqual([{ github_comment_id: 900001 }]);
  });
});
