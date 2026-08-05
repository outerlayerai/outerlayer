/**
 * Acceptance: the workers feature's behavior surface not already covered by
 * worker-tenant-visibility.acceptance.test.ts (request-tenant scoping + the
 * read-only role's DB-level insert/update denial — cited, not duplicated
 * here).
 *
 * Every mutation action in `features/workers/actions.ts` is wrapped in
 * `authorizedAction`, which needs a live Next.js request scope this harness
 * doesn't have (same gap documented in the context domain's
 * context-write-actions-boundary suite) — so none of `launchWorkerAction`,
 * `createEnvironmentAction`, `runEnvironmentTurnAction`, `cancelWorkerAction`
 * can be invoked directly. What they call past permission-check IS directly
 * reachable, though:
 *
 *   - `WorkersService` (`features/workers/service.ts`) is a plain class over
 *     `ServiceContext` (`{db, tenantId, actor}`) with no Next.js dependency —
 *     driven directly here with a real, tenant-scoped Supabase client.
 *   - `runWorkspaceTurn` (`lib/adapters/worker-machine.ts`) checks the target
 *     environment exists BEFORE calling the real dispatch machine — that
 *     early-return is exercised directly (real function, real DB, no mock).
 *
 * UNCOVERABLE, verified by reading the implementation:
 *   - The actual compute dispatch for a launch/turn (`dispatchWorkerRunMachine`
 *     / `startWorkspaceFirstTurn` / `dispatchEnvironmentTurn`'s success path)
 *     always reaches `worker-dispatch`'s Fly-or-local runner — real compute
 *     (a Fly machine, or literally spawning a local agent process with
 *     provider credentials) with no fixture this harness can drive.
 *   - `checkWorkerLaunchEntitlements` / `checkWorkerEnvironmentEntitlements`
 *     gate the dispatch call but are billing-plan logic orthogonal to the
 *     feature-behavior surface covered here; not exercised.
 *
 * `createEnvironmentAction`'s "environment" naming denotes the
 * `worker_workspace` concept, not the app's `environment` table — a
 * workspace is what it creates. No name-uniqueness constraint exists on
 * `worker_workspace`. Its behavior is covered here as: workspace create →
 * exact-shape re-read through `getWorkspace`/`listWorkspaces`' own
 * projection (`WorkersService`, same tenant-scoped-client pattern used
 * throughout this file), plus the invalid-agent boundary
 * (`getAgentDescriptor` returning null) at the one layer that's honestly
 * drivable — it's a plain, framework-free function, so it's exercised
 * directly rather than through the unreachable action. No test here reaches
 * `startWorkspaceFirstTurn` — `createWorkspace` alone (the row/RLS layer) is
 * separable from the action's subsequent dispatch call.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../custom-roles/helpers';
import { workersService } from 'tenant-dashboard/src/features/workers/service';
import { getAgentDescriptor } from 'tenant-dashboard/src/lib/worker-agents';
import { runWorkspaceTurn } from 'tenant-dashboard/src/lib/adapters/worker-machine';
import type { ServiceContext } from 'tenant-dashboard/src/lib/action-kit/service-context';

const untyped = (client: { from: SupabaseClient['from'] }): SupabaseClient => client as unknown as SupabaseClient;

/** A minimal ServiceContext over a real, already-authenticated tenant client — the same shape authorizedAction hands the handler, built by hand since the wrapper itself can't run here. */
function ctxFor(user: SameTenantUser): ServiceContext {
  return { db: untyped(user.client), tenantId: user.tenantId, actor: { userId: user.id, role: user.orgRole } };
}

describe('workers feature behavior — WorkersService + runWorkspaceTurn boundary', () => {
  const admin = createSupabaseAdminClientUntyped();

  let owner: SameTenantUser;
  let otherOrg: SameTenantUser;
  let appId: string;
  let environmentId: string;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `worker-svc-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id as string;

    // AFTER INSERT ON app seeds the mandatory default 'dev' environment
    // (public.app_seed_default_env, 52-environment.sql) — fetch it rather
    // than inserting a second default, which would violate the
    // one-default-per-app constraint.
    const { data: env, error: envError } = await admin
      .from('environment')
      .select('id')
      .eq('app_id', appId)
      .eq('is_default', true)
      .single();
    if (envError) throw new Error(`environment lookup: ${envError.message}`);
    environmentId = env!.id as string;
  }, 60000);

  afterAll(async () => {
    // `app` cascade-deletes worker_run/environment (FK app_id ON DELETE CASCADE).
    await admin.from('app').delete().eq('id', appId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  describe('run creation lands the exact row the runs read polls for', () => {
    it('createRun persists a queued run, re-readable via getRun with the exact detail shape', async () => {
      const ctx = ctxFor(owner);
      const created = await workersService.createRun(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: 'sonnet',
        taskPrompt: 'add a /health route',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      expect(created.status).toBe('queued');
      expect(created.dispatch).toBe('local');

      const detail = await workersService.getRun(ctx, appId, created.id);
      expect(detail).toEqual({
        id: created.id,
        agent: 'claude-code',
        model: 'sonnet',
        task_prompt: 'add a /health route',
        attachments: [],
        status: 'queued',
        outcome: null,
        branch_name: null,
        pr_url: null,
        pr_number: null,
        failure_code: null,
        error_message: null,
        duration_ms: null,
        created_at: expect.any(String),
        base_branch: 'main',
        cost_usd: null,
        num_turns: null,
        workspace_id: null,
      });
    });
  });

  describe('createEnvironmentAction: workspace create + invalid-agent boundary', () => {
    it('createWorkspace persists a workspace row, re-readable via getWorkspace with the exact projection', async () => {
      const ctx = ctxFor(owner);
      const created = await workersService.createWorkspace(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: 'sonnet',
        baseBranch: 'main',
        substrate: 'local',
      });
      expect(created.substrate).toBe('local');

      const workspace = await workersService.getWorkspace(ctx, appId, created.id);
      expect(workspace).toEqual({
        id: created.id,
        agent: 'claude-code',
        model: 'sonnet',
        base_branch: 'main',
        work_branch: null,
        substrate: 'local',
        status: 'creating',
        current_run_id: null,
        session_ref: null,
        last_active_at: null,
        created_at: expect.any(String),
      });
    });

    it('the created workspace appears in listWorkspaces, excluding a foreign tenant’s read entirely', async () => {
      const ctx = ctxFor(owner);
      const created = await workersService.createWorkspace(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'codex',
        model: null,
        baseBranch: 'main',
        substrate: 'local',
      });

      const list = await workersService.listWorkspaces(ctx, appId);
      expect(list.map((w) => w.id)).toContain(created.id);

      const foreignRead = await workersService.listWorkspaces(ctxFor(otherOrg), appId);
      expect(foreignRead).toEqual([]);
    });

    it('getAgentDescriptor rejects an unknown agent id — the boundary createEnvironmentAction checks before any DB write', () => {
      // Framework-free, no DB/Next dependency — the one layer honestly
      // drivable here, since the action itself needs a Next.js request scope.
      expect(getAgentDescriptor('not-a-real-agent')).toBeNull();
      expect(getAgentDescriptor('claude-code')).not.toBeNull();
    });
  });

  describe('runEnvironmentTurnAction boundary: an unknown environmentId never reaches dispatch', () => {
    it('runWorkspaceTurn rejects an unknown envId with workspace_missing, no run row created', async () => {
      const bogusEnvId = randomUUID();
      const before = await workersService.listRunsByWorkspace(ctxFor(owner), appId, bogusEnvId);
      expect(before).toEqual([]);

      const result = await runWorkspaceTurn({
        appId,
        envId: bogusEnvId,
        taskPrompt: 'this must not dispatch',
        createdBy: owner.id,
        tenantId: owner.tenantId,
      });

      expect(result).toEqual({ ok: false, code: 'workspace_missing', message: 'Environment not found.' });

      const after = await workersService.listRunsByWorkspace(ctxFor(owner), appId, bogusEnvId);
      expect(after).toEqual([]);
    });
  });

  describe('cancelWorkerAction: cancelRun status transition and terminal no-op', () => {
    it('cancels a non-terminal run, transitioning it to the terminal "cancelled" status', async () => {
      const ctx = ctxFor(owner);
      const created = await workersService.createRun(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'fix the flaky test',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      await admin.from('worker_run').update({ status: 'running' }).eq('id', created.id);

      const cancelled = await workersService.cancelRun(ctx, appId, created.id);
      expect(cancelled).toEqual({ id: created.id, dispatch: 'local', machine_id: null, workspace_id: null });

      const detail = await workersService.getRun(ctx, appId, created.id);
      expect(detail!.status).toBe('cancelled');
    });

    it('a second cancel of the now-terminal run is a no-op — no status regression', async () => {
      const ctx = ctxFor(owner);
      const created = await workersService.createRun(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'already completed run',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      await admin.from('worker_run').update({ status: 'completed' }).eq('id', created.id);

      const result = await workersService.cancelRun(ctx, appId, created.id);
      expect(result).toBeNull();

      const detail = await workersService.getRun(ctx, appId, created.id);
      expect(detail!.status).toBe('completed');
    });
  });

  describe('run history list: ordering, projection, and cross-tenant absence', () => {
    it('lists runs newest-first with the exact summary projection, and excludes a foreign tenant’s own app entirely', async () => {
      const ctx = ctxFor(owner);
      const first = await workersService.createRun(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'first run',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });
      await admin.from('worker_run').update({ status: 'completed' }).eq('id', first.id);

      const second = await workersService.createRun(ctx, {
        appId,
        environmentId,
        createdBy: owner.id,
        agent: 'claude-code',
        model: null,
        taskPrompt: 'second run',
        attachments: [],
        baseBranch: 'main',
        dispatch: 'local',
        wallClockCapS: 1800,
      });

      const list = await workersService.listRuns(ctx, appId);
      const ids = list.map((r) => r.id);
      // Newest-first: second created after first, so it sorts before it.
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

      const secondRow = list.find((r) => r.id === second.id);
      expect(secondRow).toEqual({
        id: second.id,
        agent: 'claude-code',
        model: null,
        task_prompt: 'second run',
        attachments: [],
        status: 'queued',
        outcome: null,
        branch_name: null,
        pr_url: null,
        pr_number: null,
        failure_code: null,
        error_message: null,
        duration_ms: null,
        created_at: expect.any(String),
      });

      // otherOrg holds no membership on owner's app — RLS admits none of its runs.
      const foreignRead = await workersService.listRuns(ctxFor(otherOrg), appId);
      expect(foreignRead).toEqual([]);
    });
  });
});
