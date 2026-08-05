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
 * The remaining cases drive `transitionEscalation` (`@/features/escalations/actions.ts`)
 * as a true Server Action call — permission gate, business-rule rejection, and a
 * successful transition. No other escalations suite reaches those paths: the
 * tenancy suite (`escalations/env-escalation-tenancy.acceptance.test.ts`)
 * re-implements the UPDATE policy by hand instead of calling the action.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient, createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';
import { createTenantWithOwner, addUserToTenant, SameTenantUser } from '../app-level-roles/helpers';
import { actAs, actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { createSupabaseServerClient } from '@/supabaseServerClient';
import { transitionEscalation } from '@/features/escalations/actions';

/** Address env_escalation (absent from the generated Database type) untyped. */
const untyped = (client: unknown) => client as SupabaseClient;

describe('session-cookie fixture', () => {
  const admin = createSupabaseAdminClient();
  const adminUntyped = createSupabaseAdminClientUntyped();

  let owner: SameTenantUser;
  let reader: SameTenantUser; // read-only role: holds env_escalation.read, not .update
  let appId: string;
  let escOpen: string; // open — the success-path target
  let escResolved: string; // resolved — terminal, so any transition off it is illegal

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

    const seedEscalation = async (status: 'open' | 'resolved'): Promise<string> => {
      const { data, error } = await untyped(adminUntyped)
        .from('env_escalation')
        .insert({
          tenant_id: owner.tenantId,
          app_id: appId,
          repo: `acme/repo-${randomUUID().slice(0, 8)}`,
          base_commit: 'c0ffee',
          status,
        })
        .select('id')
        .single();
      if (error) throw new Error(`seed escalation (${status}): ${error.message}`);
      return data!.id as string;
    };
    escOpen = await seedEscalation('open');
    escResolved = await seedEscalation('resolved');
  }, 90000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    await untyped(adminUntyped).from('env_escalation').delete().eq('app_id', appId);
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

  it('transitionEscalation denies a reader who holds .read but not .update', async () => {
    await actAsInOrg(reader, owner.tenantId);

    const result = await transitionEscalation({ appId, escalationId: escOpen, status: 'acked' });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'forbidden' }),
    });

    // The denied action never reached the service — the row is untouched.
    const { data: row } = await untyped(adminUntyped)
      .from('env_escalation')
      .select('status')
      .eq('id', escOpen)
      .single();
    expect(row!.status).toBe('open');
  });

  it('transitionEscalation rejects an illegal transition off a terminal (resolved) escalation', async () => {
    await actAsInOrg(owner, owner.tenantId);

    const result = await transitionEscalation({ appId, escalationId: escResolved, status: 'acked' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).toBe('cannot move an escalation from "resolved" to "acked"');
    }

    const { data: row } = await untyped(adminUntyped)
      .from('env_escalation')
      .select('status')
      .eq('id', escResolved)
      .single();
    expect(row!.status).toBe('resolved');
  });

  it('transitionEscalation acks an open escalation end-to-end, through the real action', async () => {
    await actAsInOrg(owner, owner.tenantId);

    const result = await transitionEscalation({ appId, escalationId: escOpen, status: 'acked' });
    expect(result).toEqual({
      ok: true,
      data: { kind: 'ok', escalation: expect.objectContaining({ id: escOpen, status: 'acked' }) },
    });

    const { data: row } = await untyped(adminUntyped)
      .from('env_escalation')
      .select('status')
      .eq('id', escOpen)
      .single();
    expect(row!.status).toBe('acked');
  });
});
