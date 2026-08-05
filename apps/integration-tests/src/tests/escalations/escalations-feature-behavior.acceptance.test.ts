/**
 * Acceptance: the escalations feature's read shape and lifecycle
 * state-machine.
 *
 * `loadEscalationsForApp` (the RSC read) needs a live Next.js request scope
 * this harness fakes via the `next/cache`/`next/headers` stubs, but simplest
 * driven directly against `EnvEscalationService.list`, a plain class over
 * `ServiceContext` — no action wrapper involved for a read.
 *
 * `transitionEscalation`'s permission gate, the invalid-transition rejection,
 * and a successful ack — all as the real Server Action, via the
 * session-cookie fixture — are already proven end-to-end in
 * `session-cookie/session-cookie-fixture.acceptance.test.ts` (that fixture's
 * own first converted case); not duplicated here. What's added here: the
 * foreign-ESCALATION-id case — a caller's OWN valid appId paired with
 * another tenant's escalationId, which passes the `app_authorize` permission
 * gate (the appId is real and theirs) but the service's
 * `app_id`+`escalationId` read admits no row under RLS, the same
 * indistinguishable-from-missing outcome the direct-service test below pins
 * with a random id — proven here through the actual action end-to-end.
 *
 * Cross-tenant APP-id denial (the permission-gate layer) is already proven
 * end-to-end in `env-escalation-tenancy.acceptance.test.ts` ("a member cannot
 * ack an escalation in an org they do not belong to") — not duplicated here.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { escalationsService, EnvEscalationTransitionError } from 'tenant-dashboard/src/features/escalations/service';
import { transitionEscalationInput } from 'tenant-dashboard/src/features/escalations/schemas';
import { transitionEscalation } from '@/features/escalations/actions';
import type { ServiceContext } from 'tenant-dashboard/src/lib/action-kit/service-context';

const untyped = (client: { from: SupabaseClient['from'] }): SupabaseClient => client as unknown as SupabaseClient;

function ctxFor(user: SameTenantUser): ServiceContext {
  return { db: untyped(user.client), tenantId: user.tenantId, actor: { userId: user.id, role: user.orgRole } };
}

describe('escalations feature behavior — EnvEscalationService read shape + lifecycle', () => {
  const admin = createSupabaseAdminClientUntyped();

  let owner: SameTenantUser;
  let otherOrg: SameTenantUser;
  let appId: string;
  let otherAppId: string;
  const suffix = randomUUID().slice(0, 8);

  const seedEscalation = async (status: 'open' | 'acked' | 'resolved', repo: string, forAppId = appId, tenantId = owner.tenantId) => {
    const { data, error } = await admin
      .from('env_escalation')
      .insert({ tenant_id: tenantId, app_id: forAppId, repo, base_commit: 'c0ffee', status })
      .select('id')
      .single();
    if (error) throw new Error(`seed escalation: ${error.message}`);
    return data!.id as string;
  };

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();
    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `esc-behavior-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id as string;

    const { data: otherApp, error: otherAppError } = await admin
      .from('app')
      .insert({ name: `esc-behavior-other-${suffix}`, tenant_id: otherOrg.tenantId, created_by: otherOrg.id })
      .select('id')
      .single();
    if (otherAppError) throw new Error(`other app insert: ${otherAppError.message}`);
    otherAppId = otherApp!.id as string;
  }, 60000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    await admin.from('app').delete().eq('id', otherAppId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  describe('loadEscalationsForApp (EnvEscalationService.list)', () => {
    let openId: string;
    let ackedId: string;
    let resolvedId: string;

    beforeAll(async () => {
      resolvedId = await seedEscalation('resolved', `acme/repo-${suffix}-old`);
      openId = await seedEscalation('open', `acme/repo-${suffix}-open`);
      ackedId = await seedEscalation('acked', `acme/repo-${suffix}-acked`);
    }, 30000);

    it('defaults to the actionable set (open + acked), newest-first, excluding resolved', async () => {
      const rows = await escalationsService.list(ctxFor(owner), appId);
      const ids = rows.map((r) => r.id);
      expect(ids).not.toContain(resolvedId);
      expect(ids).toEqual([ackedId, openId]);
    });

    it('projects the exact queue row shape for one seeded row', async () => {
      const rows = await escalationsService.list(ctxFor(owner), appId, ['open']);
      expect(rows).toEqual([
        {
          id: openId,
          app_id: appId,
          eval_run_id: null,
          repo: `acme/repo-${suffix}-open`,
          base_commit: 'c0ffee',
          task_ids: [],
          last_errors: [],
          attempts: 0,
          cost_usd: 0,
          suggested_next_steps: '',
          status: 'open',
          created_at: expect.any(String),
          updated_at: null,
        },
      ]);
    });

    it('an explicit status filter for history includes resolved rows', async () => {
      const rows = await escalationsService.list(ctxFor(owner), appId, ['resolved']);
      expect(rows.map((r) => r.id)).toEqual([resolvedId]);
    });
  });

  describe('transitionEscalation lifecycle (EnvEscalationService.transition)', () => {
    it('rejects an unknown status string at the schema boundary — never reaches the DB', () => {
      const result = transitionEscalationInput.safeParse({
        appId,
        escalationId: randomUUID(),
        status: 'bogus',
      });
      expect(result.success).toBe(false);
    });

    it('rejects "open" as a transition target at the schema boundary — a row is born open, never reopened', () => {
      const result = transitionEscalationInput.safeParse({
        appId,
        escalationId: randomUUID(),
        status: 'open',
      });
      expect(result.success).toBe(false);
    });

    it('open → acked round-trips: the update is immediately re-readable in the new state', async () => {
      const ctx = ctxFor(owner);
      const id = await seedEscalation('open', `acme/repo-${suffix}-t1`);

      const updated = await escalationsService.transition(ctx, { appId, escalationId: id, status: 'acked' });
      expect(updated?.status).toBe('acked');

      // Other cases in this file seed their own 'acked' rows under the same
      // app — filter to this one's id rather than asserting list length.
      const reread = await escalationsService.list(ctx, appId, ['acked']);
      const row = reread.find((r) => r.id === id);
      expect(row?.status).toBe('acked');
    });

    it('acked → resolved round-trips', async () => {
      const ctx = ctxFor(owner);
      const id = await seedEscalation('acked', `acme/repo-${suffix}-t2`);

      const updated = await escalationsService.transition(ctx, { appId, escalationId: id, status: 'resolved' });
      expect(updated?.status).toBe('resolved');
    });

    it('resolved is terminal: acking a resolved escalation throws and the row stays unchanged', async () => {
      const ctx = ctxFor(owner);
      const id = await seedEscalation('resolved', `acme/repo-${suffix}-t3`);

      await expect(escalationsService.transition(ctx, { appId, escalationId: id, status: 'acked' })).rejects.toThrow(
        EnvEscalationTransitionError,
      );

      const { data: row } = await admin.from('env_escalation').select('status').eq('id', id).single();
      expect(row!.status).toBe('resolved');
    });

    it('an unknown escalationId returns null — the not-found path the action maps to a `kind: "not_found"` outcome', async () => {
      const ctx = ctxFor(owner);
      const result = await escalationsService.transition(ctx, {
        appId,
        escalationId: randomUUID(),
        status: 'acked',
      });
      expect(result).toBeNull();
    });
  });

  describe('transitionEscalation (real Server Action): a foreign escalationId under the caller’s own appId', () => {
    it('is denied not-found — the app_authorize gate passes (own appId), but the row is invisible under RLS', async () => {
      const foreignEscalationId = await seedEscalation(
        'open',
        `acme/repo-${suffix}-foreign`,
        otherAppId,
        otherOrg.tenantId,
      );

      await actAsInOrg(owner, owner.tenantId);
      const result = await transitionEscalation({ appId, escalationId: foreignEscalationId, status: 'acked' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({ kind: 'not_found' });

      const { data: row } = await admin.from('env_escalation').select('status').eq('id', foreignEscalationId).single();
      expect(row!.status).toBe('open');
    });
  });
});
