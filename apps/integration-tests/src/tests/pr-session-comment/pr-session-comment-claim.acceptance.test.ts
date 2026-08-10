/**
 * `pr_session_comment` create-claim arbitration — against real Postgres.
 *
 * "One comment per PR" is not enforced by any code path that a mock can
 * prove. It rests on database semantics: an `ON CONFLICT DO NOTHING` insert
 * returning a row to exactly ONE of several concurrent callers, and a
 * compare-and-set UPDATE matching for exactly one taker. `refresh.test.ts`
 * drives that logic against a hand-written PostgREST fake, which is the right
 * place to pin the ORCHESTRATION — but the fake is single-threaded and
 * decides for itself who wins, so it can only ever confirm the code agrees
 * with the fake. If the real unique index, the real `ignoreDuplicates`
 * translation, or the real CAS behaved differently, every one of those tests
 * would still pass while production posted two comments on a customer's PR.
 *
 * So these tests issue the SAME queries `claimCreate` (refresh.ts) issues,
 * concurrently, against a real database, and assert on how many callers win.
 * They deliberately do not import the orchestrator: what is under test here
 * is the arbitration primitive it is built on.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantWithOwner, SameTenantUser } from '../app-level-roles/helpers';

const REPO = 'acme/claim-test';
/** One PR number per test, so nothing races between tests. */
const PR_FIRST_POST = 4201;
const PR_TAKEOVER = 4202;
const PR_BACKLOG_MARKER = 4203;
const PR_LIVE_CLAIM = 4204;

/** Mirrors `CREATE_CLAIM_TTL_MS` in refresh.ts. */
const CREATE_CLAIM_TTL_MS = 60_000;

describe('pr_session_comment create-claim arbitration', () => {
  const admin = createSupabaseAdminClient();

  let org: SameTenantUser;

  beforeAll(async () => {
    org = await createTenantWithOwner();
  }, 90000);

  afterAll(async () => {
    if (!org) return;
    await admin.from('pr_session_comment').delete().eq('tenant_id', org.tenantId);
    await admin.from('membership').delete().eq('user_id', org.id);
    await admin.from('profile').delete().eq('id', org.id);
    try {
      await admin.auth.admin.deleteUser(org.id);
    } catch {
      // best-effort; a leaked auth user does not affect other suites
    }
  });

  /** The claim insert, exactly as `claimCreate` issues it. */
  function claimInsert(prNumber: number, claimedAt: string) {
    return admin
      .from('pr_session_comment')
      .upsert(
        {
          tenant_id: org.tenantId,
          repository: REPO,
          pr_number: prNumber,
          last_body_hash: '',
          claimed_at: claimedAt,
        },
        { onConflict: 'tenant_id,repository,pr_number', ignoreDuplicates: true },
      )
      .select('id');
  }

  // The race the claim exists for: the webhook, the queue consumer, and the
  // cron sweep can all reach this line at once for one PR.
  it('hands the right to create to exactly ONE of several concurrent callers', async () => {
    const now = new Date().toISOString();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimInsert(PR_FIRST_POST, now)),
    );

    for (const result of results) {
      expect(result.error).toBeNull();
    }
    const winners = results.filter((r) => (r.data ?? []).length > 0);
    expect(winners).toHaveLength(1);

    // ...and exactly one ROW exists, which is what makes the losers' re-read
    // find the winner's state rather than a second identity.
    const { data: rows } = await admin
      .from('pr_session_comment')
      .select('id')
      .eq('tenant_id', org.tenantId)
      .eq('repository', REPO)
      .eq('pr_number', PR_FIRST_POST);
    expect(rows).toHaveLength(1);
  });

  /** The takeover CAS, exactly as `claimCreate` issues it for an expired claim. */
  function takeover(rowId: string, heldSince: string, now: string) {
    return admin
      .from('pr_session_comment')
      .update({ claimed_at: now })
      .eq('id', rowId)
      .is('github_comment_id', null)
      .eq('claimed_at', heldSince)
      .select('id');
  }

  // A claimant that died mid-post would strand the PR forever, so an expired
  // claim is takeable — but by ONE taker, or the takeover reintroduces the
  // very double-post the claim prevents.
  it('lets exactly ONE taker win an abandoned claim', async () => {
    const heldSince = new Date(Date.now() - CREATE_CLAIM_TTL_MS * 2).toISOString();
    const { data: seeded, error: seedError } = await admin
      .from('pr_session_comment')
      .insert({
        tenant_id: org.tenantId,
        repository: REPO,
        pr_number: PR_TAKEOVER,
        last_body_hash: '',
        claimed_at: heldSince,
      })
      .select('id, claimed_at')
      .single();
    if (seedError) throw new Error(`seed abandoned claim: ${seedError.message}`);

    const now = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => takeover(seeded!.id, seeded!.claimed_at!, now)),
    );

    const winners = results.filter((r) => (r.data ?? []).length > 0);
    expect(winners).toHaveLength(1);
  });

  // The cron backlog writes a row with NO claim (`claimed_at` NULL) purely to
  // remember "this PR still needs a refresh". That row must not read as a
  // live claim — otherwise flagging a PR would block its first comment for a
  // whole TTL — and `.is('claimed_at', null)` is what makes the takeover of
  // it match, where `.eq(null)` would match nothing at all.
  it('makes a never-claimed backlog row takeable immediately, by one taker', async () => {
    const { error: markError } = await admin.from('pr_session_comment').upsert(
      {
        tenant_id: org.tenantId,
        repository: REPO,
        pr_number: PR_BACKLOG_MARKER,
        needs_refresh: true,
      },
      { onConflict: 'tenant_id,repository,pr_number' },
    );
    if (markError) throw new Error(`seed backlog marker: ${markError.message}`);

    const { data: marker } = await admin
      .from('pr_session_comment')
      .select('id, claimed_at, needs_refresh')
      .eq('tenant_id', org.tenantId)
      .eq('repository', REPO)
      .eq('pr_number', PR_BACKLOG_MARKER)
      .single();
    expect(marker!.claimed_at).toBeNull();
    expect(marker!.needs_refresh).toBe(true);

    const now = new Date().toISOString();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        admin
          .from('pr_session_comment')
          .update({ claimed_at: now })
          .eq('id', marker!.id)
          .is('github_comment_id', null)
          .is('claimed_at', null)
          .select('id'),
      ),
    );

    const winners = results.filter((r) => (r.data ?? []).length > 0);
    expect(winners).toHaveLength(1);
  });

  // The other half of the same rule: a claim taken moments ago is NOT
  // takeable, so a second caller backs off instead of posting alongside a
  // poster that is still in flight.
  it('refuses the takeover of a live claim', async () => {
    const heldSince = new Date().toISOString();
    const { data: seeded, error: seedError } = await admin
      .from('pr_session_comment')
      .insert({
        tenant_id: org.tenantId,
        repository: REPO,
        pr_number: PR_LIVE_CLAIM,
        last_body_hash: '',
        claimed_at: heldSince,
      })
      .select('id, claimed_at')
      .single();
    if (seedError) throw new Error(`seed live claim: ${seedError.message}`);

    // A second caller re-reads and sees a claim inside the TTL...
    const { data: reread } = await admin
      .from('pr_session_comment')
      .select('claimed_at, github_comment_id')
      .eq('id', seeded!.id)
      .single();
    const age = Date.now() - Date.parse(reread!.claimed_at!);
    expect(age).toBeLessThan(CREATE_CLAIM_TTL_MS);
    expect(reread!.github_comment_id).toBeNull();

    // ...and even if it tried the CAS against a stale value, it would lose.
    const { data: taken } = await takeover(
      seeded!.id,
      new Date(Date.parse(heldSince) - 1000).toISOString(),
      new Date().toISOString(),
    );
    expect(taken ?? []).toHaveLength(0);
  });

  // The completion write clears both the claim and the backlog flag, so the
  // row stops looking like work in progress the moment the comment lands.
  it('clears the claim and the backlog flag when the posted id is persisted', async () => {
    const { error } = await admin.from('pr_session_comment').upsert(
      {
        tenant_id: org.tenantId,
        repository: REPO,
        pr_number: PR_BACKLOG_MARKER,
        github_comment_id: 900123,
        last_body_hash: 'hash-1',
        last_posted_at: new Date().toISOString(),
        claimed_at: null,
        needs_refresh: false,
      },
      { onConflict: 'tenant_id,repository,pr_number' },
    );
    expect(error).toBeNull();

    const { data: row } = await admin
      .from('pr_session_comment')
      .select('github_comment_id, claimed_at, needs_refresh')
      .eq('tenant_id', org.tenantId)
      .eq('repository', REPO)
      .eq('pr_number', PR_BACKLOG_MARKER)
      .single();
    expect(row).toMatchObject({
      github_comment_id: 900123,
      claimed_at: null,
      needs_refresh: false,
    });
  });
});
