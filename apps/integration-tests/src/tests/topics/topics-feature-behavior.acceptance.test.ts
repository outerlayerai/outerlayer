/**
 * Acceptance: the topics feature's facet-validation boundary and
 * `generateTopics`'s permission-denial branch — the parts of this domain
 * reachable without a live ClickHouse instance.
 *
 * `loadTopicsForApp`'s empty/gate shape and `generateTopics`'s PERMITTED
 * outcome are UNCOVERABLE here, verified by reading the implementation, not
 * assumed:
 *   - `loadTopicsForApp` (`features/topics/read.ts:42-47`) calls
 *     `createTenantReadClient`, which returns `null` whenever `CLICKHOUSE_HOST`
 *     is unset (`lib/analytics/client.ts:198-201`) — this harness's
 *     `test-setup.ts` sets `CLICKHOUSE_HOST: undefined` explicitly, and no
 *     ClickHouse container runs alongside the shared integration-tests
 *     Supabase stack. On a null client the read THROWS
 *     `ServiceUnavailableError` before ever computing a shape — unlike the
 *     context domain's Overview (`getOverview`), which degrades to an
 *     inventory-only response on the same null client, topics has no
 *     degrade path. There is no way to reach the "no map generated" empty
 *     shape without a real ClickHouse to query zero rows from.
 *   - `generateTopics`'s handler (`features/topics/actions.ts`) reaches
 *     `getDefaultClient()` and throws on a null client for the same reason —
 *     so a PERMITTED member's outcome stays unreachable.
 *
 * `generateTopics`'s DENIAL branch IS reachable, though: `authorizedAction`'s
 * `trace.read` permission check runs before the handler body — before
 * `getDefaultClient()` is ever called — so a member without `trace.read` is
 * rejected `forbidden` with no ClickHouse involved. Every built-in role
 * (owner/admin/write/read) holds `trace.read`, so the denial needs a custom
 * role with no permissions, driven as the real Server Action via the
 * session-cookie fixture.
 *
 * The cross-tenant guarantee has no live-wire seam to exercise for the same
 * reason, but the codebase already enforces and PROVES it structurally:
 * `topics-sql-tenant-enforcement.test.ts` (features/topics/) statically scans
 * every SQL template in the topics directory and fails if any tenant-table
 * query is missing a `TenantId` predicate — a stronger, exhaustive guarantee
 * than one seeded cross-tenant read would be. Cited, not duplicated (and not
 * extendable while ClickHouse is absent).
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { generateTopicsInput } from 'tenant-dashboard/src/features/topics/schemas';
import { TOPIC_FACETS } from 'tenant-dashboard/src/lib/analytics/topics/topics-shared';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import {
  createTenantWithOwner,
  cleanupTenantAndUsers,
  createCustomRole,
  assignCustomRole,
  cleanupCustomRoles,
  type SameTenantUser,
} from '../custom-roles/helpers';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { generateTopics } from '@/features/topics/actions';

describe('generateTopics permission gate (real Server Action, session-cookie fixture)', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let noTraceReadUser: SameTenantUser;
  let appId: string;

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    noTraceReadUser = await createTenantWithOwner(); // own tenant; membership repointed below

    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `topics-gate-${randomUUID().slice(0, 8)}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id as string;

    // A custom role with NO permissions, assigned in owner's own tenant —
    // authorize() reads custom_role_id straight off the membership row (a
    // stored custom role wins over the built-in role), so this is enough to
    // deny trace.read for a member who otherwise would hold it via any
    // built-in role.
    const noPermsRole = await createCustomRole(admin, owner.tenantId, 'no-permissions', []);
    const { data: membership, error: membershipError } = await admin
      .from('membership')
      .insert({ tenant_id: owner.tenantId, user_id: noTraceReadUser.id, role: 'read', status: 'active' })
      .select('id')
      .single();
    if (membershipError) throw new Error(`membership insert: ${membershipError.message}`);
    await assignCustomRole(admin, membership!.id as string, noPermsRole.id);
  }, 90000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    await admin.from('membership').delete().eq('user_id', noTraceReadUser.id).eq('tenant_id', owner.tenantId);
    await cleanupCustomRoles(admin, owner.tenantId);
    await admin.from('app').delete().eq('id', appId);
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(noTraceReadUser.tenantId, [noTraceReadUser]);
  });

  it('denies a member whose custom role holds no permissions — before ClickHouse is ever reached', async () => {
    await actAsInOrg(noTraceReadUser, owner.tenantId);
    const result = await generateTopics({ appId, facet: 'task' });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) });
  });

  it('positive control: a permitted owner clears the gate — the permission check itself is not what fails', async () => {
    // Distinguishes "denied at the gate" from "denied for any reason at all":
    // the owner holds trace.read via the built-in role, so this reaches PAST
    // authorizedAction's permission check and fails on the null ClickHouse
    // client instead (internal_error, not forbidden) — proof the denial case
    // above is really the permission gate, not some other rejection this
    // harness happens to always hit.
    await actAsInOrg(owner, owner.tenantId);
    const result = await generateTopics({ appId, facet: 'task' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal_error');
  });
});

describe('topics feature behavior — facet validation boundary', () => {
  it('accepts every declared facet', () => {
    for (const facet of TOPIC_FACETS) {
      const result = generateTopicsInput.safeParse({ appId: 'app-1', facet });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unknown facet string at the schema boundary', () => {
    const result = generateTopicsInput.safeParse({ appId: 'app-1', facet: 'not-a-real-facet' });
    expect(result.success).toBe(false);
  });

  it('defaults to "task" when facet is omitted', () => {
    const result = generateTopicsInput.safeParse({ appId: 'app-1' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.facet).toBe('task');
  });

  it('rejects an empty appId', () => {
    const result = generateTopicsInput.safeParse({ appId: '', facet: 'task' });
    expect(result.success).toBe(false);
  });
});
