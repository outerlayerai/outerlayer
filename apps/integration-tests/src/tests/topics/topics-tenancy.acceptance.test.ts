/**
 * Topics tenancy acceptance — the list read and generation gate are tenant-
 * and permission-scoped, proven through the real wire paths
 * `loadTopicsForApp` / `generateTopics` run on.
 *
 * Four layers, each the exact mechanism the dashboard code runs through:
 *
 *  - The app-lookup gate. `checkAppPermission` (and `getAppIdByName`) resolve
 *    the requested app under the caller's ACTIVE membership before any
 *    ClickHouse read runs. Modeled on `rbac/request-tenant-visibility.
 *    acceptance.test.ts` / the onboarding tenancy acceptance test's
 *    `resolveAppUnderTenant` pattern: a header-scoped, authenticated client
 *    drives the same RLS-scoped `app` lookup those functions perform, so a
 *    non-member tenant header resolves no row and the real gate would deny
 *    (ForbiddenError) before any signal reaches ClickHouse.
 *  - The ClickHouse read. `trace_facets` / `trace_topic_maps` carry the
 *    `TenantId = getSetting('SQL_tenant_id')` row policy (migration 29) that
 *    `createTenantReadClient` scopes every dashboard read through. Rows are
 *    seeded via the writer identity (mirroring what `generateTopics` itself
 *    writes), then read back through the REAL `buildTopicsService` — the same
 *    class and queries `loadTopicsForApp` runs — under the real
 *    `analytics_reader` identity this integration ClickHouse provisions.
 *  - The steering facet's capture-tier read. `read.ts` dropped
 *    `resolveTenantCaptureTier`'s admin client in favor of the request-scoped
 *    `ctx.db`, relying on the "Users can read tenant" policy's
 *    active-membership clause (12-rbac.sql) needing no permission grant. That
 *    assumption is pinned here directly against Postgres RLS: a plain member
 *    reads their own tenant's `agent_capture_tier`, and a non-member under a
 *    spoofed tenant header reads nothing — the fail-closed case `read.ts`
 *    then folds into its documented `'full'` fallback rather than ever
 *    exposing the other tenant's real tier.
 *  - Generation's read-only temp-access refusal. `isTempAccessReadOnlySession`
 *    is a plain Postgres lookup against a real seeded `temp_access_grant` row
 *    — the exact function `generateTopics`'s action handler calls before it
 *    writes, refusing a grant that would otherwise satisfy `trace.read`.
 *
 * `tenant-dashboard`'s own ClickHouse env vars are mocked to `undefined` for
 * this whole test run (`test-setup.ts`'s `tenant-dashboard/src/env` mock), so
 * the read client here is built directly against the integration container —
 * the same approach `security/clickhouse-read-path-leak.test.ts` uses to prove
 * the analogous case for `AnalyticsService`. Runs under the `clickhouse`
 * vitest project (real analytics_reader, migration-29 policies); see
 * vitest.config.ts.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';
import {
  CLICKHOUSE_TEST_HOST,
  CLICKHOUSE_TEST_READ_USER,
  CLICKHOUSE_TEST_READ_PASSWORD,
  executeClickHouse,
} from '../../../clickhouse/setup-clickhouse';
import { buildTopicsService } from 'tenant-dashboard/src/features/topics/service';
import { isTempAccessReadOnlySession } from 'tenant-dashboard/src/lib/system/temp-access-guard';

const RUN = randomBytes(4).toString('hex');
// The dashboard is pinned to the default environment everywhere today
// (DEFAULT_ENV_NAME) — matches what `read.ts` / `actions.ts` resolve server-side.
const ENV_NAME = 'dev';
// Every tenant is born at 'full' (the schema default and read.ts's fallback),
// so a non-default value is what lets the RLS assertions below distinguish a
// real read from the degradation path silently kicking in.
const CAPTURE_TIER_A = 'metrics';

/** A ClickHouse client scoped exactly like `createTenantReadClient` builds one:
 * the real `analytics_reader` identity plus the row-policy settings. */
function readerClient(scope: { tenantId: string; appId: string }): ClickHouseClient {
  return createClient({
    url: CLICKHOUSE_TEST_HOST,
    username: CLICKHOUSE_TEST_READ_USER,
    password: CLICKHOUSE_TEST_READ_PASSWORD,
    database: 'default',
    clickhouse_settings: { SQL_tenant_id: scope.tenantId, SQL_app_id: scope.appId },
  });
}

describe('topics reads are tenant-scoped; generation refuses read-only temp access', () => {
  const admin = createSupabaseAdminClient();
  const clients: ClickHouseClient[] = [];

  let orgA: SameTenantUser; // owner of A, member of A only
  let orgB: SameTenantUser; // owner of B, member of B only
  let appA: string;
  let appB: string;

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id;
  };

  /** The exact lookup `checkAppPermission`/`getAppIdByName` run — the topics
   * auth gate. Returns the app id when the gate opens, or null when it denies. */
  async function resolveAppUnderTenant(
    user: SameTenantUser,
    requestTenantId: string,
    appId: string,
  ): Promise<string | null> {
    const scoped = await createTenantScopedClient(user, requestTenantId);
    const { data } = await scoped
      .from('app')
      .select('id')
      .eq('id', appId)
      .eq('tenant_id', requestTenantId)
      .maybeSingle();
    return data?.id ?? null;
  }

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    const suffix = randomUUID().slice(0, 8);
    appA = await seedApp(`topics-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`topics-b-${suffix}`, orgB.tenantId, orgB.id);

    // A non-default tier — every tenant is born at the 'full' default, so the
    // capture-tier RLS assertions below seed a value the fallback couldn't
    // produce by accident.
    const { error: tierError } = await admin
      .from('tenant')
      .update({ agent_capture_tier: CAPTURE_TIER_A })
      .eq('tenant_id', orgA.tenantId);
    if (tierError) throw new Error(`seed capture tier: ${tierError.message}`);

    // One generated map + one classified facet row per org — the shape
    // `generateTopics` itself writes (map row activating a version whose
    // facet rows already carry that TopicId/MapVersion).
    await executeClickHouse(`
      INSERT INTO trace_topic_maps (TenantId, AppId, Environment, Facet, MapVersion, TopicId, Name, Description)
      VALUES
        ('${orgA.tenantId}', '${appA}', '${ENV_NAME}', 'task', 1, 'topic-a-${RUN}', 'Org A topic', 'seeded for acceptance'),
        ('${orgB.tenantId}', '${appB}', '${ENV_NAME}', 'task', 1, 'topic-b-${RUN}', 'Org B topic', 'seeded for acceptance')
    `);
    await executeClickHouse(`
      INSERT INTO trace_facets (TenantId, AppId, Environment, TraceId, Facet, ItemIndex, ExtractorVersion, Summary, Status, TopicId, MapVersion)
      VALUES
        ('${orgA.tenantId}', '${appA}', '${ENV_NAME}', 'topics-trace-a-${RUN}', 'task', 0, 1, 'org a summary', 'ok', 'topic-a-${RUN}', 1),
        ('${orgB.tenantId}', '${appB}', '${ENV_NAME}', 'topics-trace-b-${RUN}', 'task', 0, 1, 'org b summary', 'ok', 'topic-b-${RUN}', 1)
    `);
  }, 90000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    for (const table of ['trace_topic_maps', 'trace_facets']) {
      await executeClickHouse(
        `ALTER TABLE ${table} DELETE WHERE TenantId IN ('${orgA.tenantId}', '${orgB.tenantId}')`,
      );
    }
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id]);
    for (const user of [orgA, orgB]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  describe('the app-lookup gate (checkAppPermission / getAppIdByName)', () => {
    it('opens for a member reading their own app — the read would then run', async () => {
      await expect(resolveAppUnderTenant(orgA, orgA.tenantId, appA)).resolves.toBe(appA);
    });

    it('denies a non-member under a spoofed tenant header — no signal ever reaches ClickHouse', async () => {
      // orgB's owner is not a member of org A; the middleware would never mint
      // this header, but the gate must fail closed if one ever reached it:
      // public.tenant_id() resolves to no tenant, RLS returns no app row.
      await expect(resolveAppUnderTenant(orgB, orgA.tenantId, appA)).resolves.toBeNull();
    });
  });

  describe('ClickHouse read: trace_facets/trace_topic_maps are tenant-scoped (migration 29) — the exact query loadTopicsForApp runs', () => {
    it("a member of Org A sees only Org A's map", async () => {
      const client = readerClient({ tenantId: orgA.tenantId, appId: appA });
      clients.push(client);

      const result = await buildTopicsService(client).listTopics(
        { tenantId: orgA.tenantId, appId: appA, environment: ENV_NAME, environmentIsDefault: true },
        'task',
      );

      expect(result.mapVersion).toBe(1);
      expect(result.topics).toHaveLength(1);
      expect(result.topics[0]).toMatchObject({
        topicId: `topic-a-${RUN}`,
        name: 'Org A topic',
        sessionCount: 1,
        share: 1,
      });
    });

    it("naming Org B's app under Org A's tenant scope returns nothing — the tenant policy, not the appId filter, is the boundary", async () => {
      const client = readerClient({ tenantId: orgA.tenantId, appId: appB });
      clients.push(client);

      const result = await buildTopicsService(client).listTopics(
        { tenantId: orgA.tenantId, appId: appB, environment: ENV_NAME, environmentIsDefault: true },
        'task',
      );

      expect(result.mapVersion).toBe(0);
      expect(result.topics).toEqual([]);
    });

    it("RED TEAM: a cross-tenant probe (Org B's tenant scope, Org A's app id) returns nothing", async () => {
      const client = readerClient({ tenantId: orgB.tenantId, appId: appA });
      clients.push(client);

      const result = await buildTopicsService(client).listTopics(
        { tenantId: orgB.tenantId, appId: appA, environment: ENV_NAME, environmentIsDefault: true },
        'task',
      );

      expect(result.mapVersion).toBe(0);
      expect(result.topics).toEqual([]);
    });
  });

  describe("steering's capture-tier read (the resolveTenantCaptureTier admin-client drop)", () => {
    it("a plain member reads their own tenant's capture tier through the request-scoped client", async () => {
      const scoped = await createTenantScopedClient(orgA, orgA.tenantId);
      const { data, error } = await scoped
        .from('tenant')
        .select('agent_capture_tier')
        .eq('tenant_id', orgA.tenantId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.agent_capture_tier).toBe(CAPTURE_TIER_A);
    });

    it('a non-member under a spoofed tenant header reads nothing — read.ts then folds this into the full fallback, never the real tier', async () => {
      // orgB's owner is not a member of org A; RLS's active-membership clause
      // (12-rbac.sql) admits no row, so `data` is null here exactly as it is
      // in read.ts — which is what drives its `tier === ... ? tier : 'full'`
      // fallback rather than ever returning CAPTURE_TIER_A to a non-member.
      const spoofed = await createTenantScopedClient(orgB, orgA.tenantId);
      const { data, error } = await spoofed
        .from('tenant')
        .select('agent_capture_tier')
        .eq('tenant_id', orgA.tenantId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });
  });

  describe("generate refuses a read-only temp-access session even though it satisfies trace.read", () => {
    it('a normal member does not hold read-only temp access', async () => {
      await expect(isTempAccessReadOnlySession(orgA.id, orgA.tenantId)).resolves.toBe(false);
    });

    it('a seeded temp-access grant IS read-only — generation must refuse it', async () => {
      const { error } = await admin.from('temp_access_grant').insert({
        created_by: orgA.id,
        tenant_id: orgA.tenantId,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        customer_permission_confirmed: true,
      });
      if (error) throw new Error(`seed temp_access_grant: ${error.message}`);

      await expect(isTempAccessReadOnlySession(orgA.id, orgA.tenantId)).resolves.toBe(true);

      await admin
        .from('temp_access_grant')
        .delete()
        .eq('tenant_id', orgA.tenantId)
        .eq('created_by', orgA.id);
    });
  });
});
