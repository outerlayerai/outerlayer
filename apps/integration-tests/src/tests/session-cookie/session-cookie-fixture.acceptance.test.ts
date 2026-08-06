/**
 * Canary + first converted case for the session-cookie fixture
 * (`src/lib/session-cookie.ts`).
 *
 * The canary pins the fixture's own contract end-to-end: `actAs(user)` mints a
 * real GoTrue session into the `next/headers` cookie stub, and the UN-mocked
 * `createSupabaseServerClient()` (the one function every dashboard request-scoped
 * client goes through) reads it back — `auth.getUser()` resolves to the same
 * user id, and an RLS-scoped read sees a row seeded for that user's tenant. If a
 * future `@supabase/ssr`/`supabase-js` upgrade changes cookie mechanics, this is
 * the test that reds first.
 *
 * The remaining cases drive `cancelWorkerAction` (`@/features/workers/actions.ts`)
 * as a true Server Action call — permission gate, terminal-run no-op, and a
 * successful cancel. No other workers suite reaches those paths: they exercise
 * the RLS policies directly instead of calling the action.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';
import { actAs, actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { cancelWorkerAction } from '@/features/workers/actions';

describe('session-cookie fixture', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let reader: SameTenantUser; // read-only role: holds worker_run.read, not .update
  let appId: string;
  let runRunning: string; // running — the success-path target
  let runCompleted: string; // completed — terminal, so a cancel is a no-op

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    reader = await addUserToTenant(owner.tenantId, 'read');

    const { data: appRow, error: appError } = await admin
      .from('app')
      .insert({
        name: `session-cookie-${randomUUID().slice(0, 8)}`,
        tenant_id: owner.tenantId,
        created_by: owner.id,
      })
      .select('id')
      .single();
    if (appError) throw new Error(`seed app: ${appError.message}`);
    appId = appRow!.id;

    // dispatch 'local' with no machine and no workspace: the cancel teardown
    // then has no Fly machine to stop, so the action stays inside this database.
    const seedRun = async (status: 'running' | 'completed'): Promise<string> => {
      const { data, error } = await admin
        .from('worker_run')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          agent: 'claude-code',
          task_prompt: 'fixture run',
          dispatch: 'local',
          status,
          created_by: owner.id,
        })
        .select('id')
        .single();
      if (error) throw new Error(`seed worker_run (${status}): ${error.message}`);
      return data!.id;
    };
    runRunning = await seedRun('running');
    runCompleted = await seedRun('completed');
  }, 90000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    await admin.from('worker_run').delete().eq('app_id', appId);
    await admin.from('app').delete().eq('id', appId);
    await admin.from('membership').delete().in('user_id', [owner.id, reader.id]);
    for (const user of [owner, reader]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().eq('tenant_id', owner.tenantId);
  });

  it('actAs mints a real session cookie that the aliased createSupabaseServerClient reads back', async () => {
    await actAs(owner);

    const db = await createSupabaseServerClient();
    const {
      data: { user },
      error,
    } = await db.auth.getUser();
    expect(error).toBeNull();
    expect(user?.id).toBe(owner.id);

    // RLS-scoped read under the JWT-claim tenant (no X-Tenant-Id header): the
    // seeded app is visible to its owner.
    const { data: apps, error: readError } = await db.from('app').select('id').eq('id', appId);
    expect(readError).toBeNull();
    expect((apps ?? []).map((a) => a.id)).toEqual([appId]);
  });

  it('cancelWorkerAction denies a reader who holds worker_run.read but not .update', async () => {
    await actAsInOrg(reader, owner.tenantId);

    const result = await cancelWorkerAction({ appId, runId: runRunning });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'forbidden' }),
    });

    // The denied action never reached the service — the row is untouched.
    const { data: row } = await admin
      .from('worker_run')
      .select('status')
      .eq('id', runRunning)
      .single();
    expect(row!.status).toBe('running');
  });

  it('cancelWorkerAction leaves a terminal (completed) run alone and reports its status', async () => {
    await actAsInOrg(owner, owner.tenantId);

    const result = await cancelWorkerAction({ appId, runId: runCompleted });
    expect(result).toEqual({
      ok: true,
      data: { kind: 'noop', status: 'completed' },
    });

    const { data: row } = await admin
      .from('worker_run')
      .select('status')
      .eq('id', runCompleted)
      .single();
    expect(row!.status).toBe('completed');
  });

  it('cancelWorkerAction cancels a running run end-to-end, through the real action', async () => {
    await actAsInOrg(owner, owner.tenantId);

    const result = await cancelWorkerAction({ appId, runId: runRunning });
    expect(result).toEqual({
      ok: true,
      data: { kind: 'ok', status: 'cancelled' },
    });

    const { data: row } = await admin
      .from('worker_run')
      .select('status, completed_at')
      .eq('id', runRunning)
      .single();
    expect(row!.status).toBe('cancelled');
    expect(row!.completed_at).not.toBeNull();
  });
});
