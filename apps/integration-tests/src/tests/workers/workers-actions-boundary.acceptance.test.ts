/**
 * Acceptance: the workers mutation actions driven as real `authorizedAction`
 * Server Action calls, via the session-cookie fixture — the layer
 * `workers-feature-behavior.acceptance.test.ts` cannot reach (it drives
 * `WorkersService` and `runWorkspaceTurn` directly, bypassing the actions'
 * own permission gate and pre-dispatch validation).
 *
 * `launchWorkerAction` / `createEnvironmentAction` / `runEnvironmentTurnAction`
 * every eventually call the real dispatch machine
 * (`dispatchWorkerRunMachine`/`startWorkspaceFirstTurn`/`dispatchEnvironmentTurn`)
 * — real compute, no fixture — so only their PRE-dispatch surface is covered
 * here: the permission gate (denies before the handler body runs at all) and
 * the early-return validation branches (unknown agent, unknown environment)
 * that return before entitlements or dispatch are ever reached.
 *
 * `cancelWorkerAction` is the one action with no live-compute dependency on
 * its success path: `teardownCancelledRun` only calls Fly when
 * `dispatch === 'fly'` (verified by reading `lib/adapters/worker-machine.ts`),
 * so a seeded `dispatch: 'local'` run exercises the action end-to-end,
 * including the teardown call, with zero external reach.
 *
 * A read-only role's DB-level denial (RLS INSERT/UPDATE policy) is already
 * proven in `worker-tenant-visibility.acceptance.test.ts` — not duplicated
 * here; the `cancelWorkerAction` reader case below proves the DISTINCT
 * `app_authorize` permission-gate layer instead (denial before the RLS layer
 * is ever reached).
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, addUserToTenant, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { workersService } from '@/features/workers/service';
import {
  launchWorkerAction,
  createEnvironmentAction,
  runEnvironmentTurnAction,
  cancelWorkerAction,
} from '@/features/workers/actions';
import type { ServiceContext } from '@/lib/action-kit/service-context';

describe('workers mutation actions — real Server Action calls (session-cookie fixture)', () => {
  const admin = createSupabaseAdminClientUntyped();

  let owner: SameTenantUser;
  let reader: SameTenantUser;
  let otherOrg: SameTenantUser;
  let appId: string;
  let environmentId: string;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    reader = await addUserToTenant(owner.tenantId, 'read');
    otherOrg = await createTenantWithOwner();

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `worker-act-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id as string;

    // AFTER INSERT ON app seeds the mandatory default 'dev' environment
    // (public.app_seed_default_env, 52-environment.sql).
    const { data: env, error: envError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', appId)
      .eq('is_default', true)
      .single();
    if (envError) throw new Error(`environment lookup: ${envError.message}`);
    environmentId = env!.id as string;
  }, 60000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    await admin.from('app').delete().eq('id', appId);
    await cleanupTenantAndUsers(owner.tenantId, [owner, reader]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  describe('cross-tenant denial: every worker action rejects a foreign appId before touching dispatch', () => {
    it('launchWorkerAction', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await launchWorkerAction({ appId, agent: 'claude-code', taskPrompt: 'do the thing' });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('createEnvironmentAction', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await createEnvironmentAction({ appId, agent: 'claude-code', taskPrompt: 'do the thing' });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('runEnvironmentTurnAction', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await runEnvironmentTurnAction({ appId, envId: environmentId, taskPrompt: 'do the thing' });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });

    it('cancelWorkerAction', async () => {
      await actAsInOrg(otherOrg, otherOrg.tenantId);
      const result = await cancelWorkerAction({ appId, runId: randomUUID() });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
    });
  });

  describe('launchWorkerAction / createEnvironmentAction: pre-dispatch validation through the real action', () => {
    it('launchWorkerAction rejects an unknown agent before reaching entitlements or dispatch', async () => {
      await actAsInOrg(owner, owner.tenantId);
      const result = await launchWorkerAction({ appId, agent: 'not-a-real-agent', taskPrompt: 'x' });
      expect(result).toEqual({
        ok: true,
        data: { kind: 'invalid', message: 'Unknown agent: not-a-real-agent' },
      });
    });

    it('createEnvironmentAction rejects an unknown agent before reaching entitlements or dispatch', async () => {
      await actAsInOrg(owner, owner.tenantId);
      const result = await createEnvironmentAction({ appId, agent: 'not-a-real-agent', taskPrompt: 'x' });
      expect(result).toEqual({
        ok: true,
        data: { kind: 'invalid', message: 'Unknown agent: not-a-real-agent' },
      });
    });
  });

  describe('runEnvironmentTurnAction: unknown environmentId through the real action', () => {
    it('rejects an unknown envId, never reaching dispatch', async () => {
      await actAsInOrg(owner, owner.tenantId);
      const bogusEnvId = randomUUID();
      const result = await runEnvironmentTurnAction({ appId, envId: bogusEnvId, taskPrompt: 'must not dispatch' });
      expect(result).toEqual({
        ok: true,
        data: { kind: 'failed', busy: false, message: 'Environment not found.' },
      });
    });
  });

  describe('cancelWorkerAction: end-to-end (dispatch: local, no live compute reached)', () => {
    function ctxFor(user: SameTenantUser): ServiceContext {
      return { db: user.client as never, tenantId: user.tenantId, actor: { userId: user.id, role: user.orgRole } };
    }

    it('cancels a non-terminal run through the real action — status transitions to cancelled', async () => {
      const created = await workersService.createRun(ctxFor(owner), {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'cancel me via the real action',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      await admin.from('worker_run').update({ status: 'running' }).eq('id', created.id);

      await actAsInOrg(owner, owner.tenantId);
      const result = await cancelWorkerAction({ appId, runId: created.id });
      expect(result).toEqual({ ok: true, data: { kind: 'ok', status: 'cancelled' } });

      const detail = await workersService.getRun(ctxFor(owner), appId, created.id);
      expect(detail!.status).toBe('cancelled');
    });

    it('a second cancel of the now-terminal run is a no-op through the real action — no status regression', async () => {
      const created = await workersService.createRun(ctxFor(owner), {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'already terminal',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      await admin.from('worker_run').update({ status: 'completed' }).eq('id', created.id);

      await actAsInOrg(owner, owner.tenantId);
      const result = await cancelWorkerAction({ appId, runId: created.id });
      expect(result).toEqual({ ok: true, data: { kind: 'noop', status: 'completed' } });

      const detail = await workersService.getRun(ctxFor(owner), appId, created.id);
      expect(detail!.status).toBe('completed');
    });

    it('denies a read-only role at the permission gate — distinct from the RLS-layer denial', async () => {
      const created = await workersService.createRun(ctxFor(owner), {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'reader must not cancel this',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      await admin.from('worker_run').update({ status: 'running' }).eq('id', created.id);

      await actAsInOrg(reader, owner.tenantId);
      const result = await cancelWorkerAction({ appId, runId: created.id });
      expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });

      const detail = await workersService.getRun(ctxFor(owner), appId, created.id);
      expect(detail!.status).toBe('running');
    });
  });
});
