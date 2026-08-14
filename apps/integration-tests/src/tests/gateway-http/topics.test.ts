/**
 * HTTP-level coverage for `GET /v1/topics`: facet filtering, schema
 * conformance against the real `@repo/api-schemas` response schema, and the
 * live `topics_enabled` entitlement gate (402 on hobby, 200 on growth).
 *
 * Seeds the exact ClickHouse shape `generateTopics` writes — an activated
 * `trace_topic_maps` row plus a matching `trace_facets` row per facet — the
 * same pattern `topics/topics-tenancy.acceptance.test.ts` uses, but driven
 * through the real gateway HTTP boundary instead of `TopicsService` directly.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TopicsResponseSchema } from '@repo/api-schemas';
import { executeClickHouse } from '../../../clickhouse/setup-clickhouse';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);

async function defaultEnvironmentName(appId: string): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from('environment')
    .select('name')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw new Error(`environment lookup failed: ${error.message}`);
  if (!data?.name) throw new Error(`no default environment for app ${appId}`);
  return data.name;
}

/** Tenant tier the gateway resolves `topics_enabled` against — `hobby`
 * withholds it, `growth` includes it (see `TIER_FIXTURES` in
 * `entitlements/helpers.ts`). */
async function setTier(tenantId: string, tierId: 'hobby' | 'growth'): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: existing } = await admin.from('billing').select('tenant_id').eq('tenant_id', tenantId).maybeSingle();
  if (existing) {
    await admin.from('billing').update({ tier_id: tierId }).eq('tenant_id', tenantId);
    return;
  }
  const { error } = await admin.from('billing').insert({ tenant_id: tenantId, tier_id: tierId });
  if (error) throw new Error(`billing seed failed: ${error.message}`);
}

describe('GET /v1/topics', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();
  let envName: string;

  const TOPIC_ISSUES = `topic-issues-${RUN_ID}`;
  const TOPIC_TASK = `topic-task-${RUN_ID}`;
  const TOPIC_STEERING = `topic-steering-${RUN_ID}`;

  beforeAll(async () => {
    envName = await defaultEnvironmentName(appId);
    await setTier(tenantId, 'growth');

    await executeClickHouse(`
      INSERT INTO trace_topic_maps (TenantId, AppId, Environment, Facet, MapVersion, TopicId, Name, Description)
      VALUES
        ('${tenantId}', '${appId}', '${envName}', 'issues', 1, '${TOPIC_ISSUES}', 'Issues topic ${RUN_ID}', 'seeded'),
        ('${tenantId}', '${appId}', '${envName}', 'task', 1, '${TOPIC_TASK}', 'Task topic ${RUN_ID}', 'seeded'),
        ('${tenantId}', '${appId}', '${envName}', 'steering', 1, '${TOPIC_STEERING}', 'Steering topic ${RUN_ID}', 'seeded')
    `);
    await executeClickHouse(`
      INSERT INTO trace_facets (TenantId, AppId, Environment, TraceId, Facet, ItemIndex, ExtractorVersion, Summary, Status, TopicId, MapVersion)
      VALUES
        ('${tenantId}', '${appId}', '${envName}', 'topics-trace-issues-${RUN_ID}', 'issues', 0, 1, 'issues summary', 'ok', '${TOPIC_ISSUES}', 1),
        ('${tenantId}', '${appId}', '${envName}', 'topics-trace-task-${RUN_ID}', 'task', 0, 1, 'task summary', 'ok', '${TOPIC_TASK}', 1),
        ('${tenantId}', '${appId}', '${envName}', 'topics-trace-steering-${RUN_ID}', 'steering', 0, 1, 'steering summary', 'ok', '${TOPIC_STEERING}', 1)
    `);
  }, 60_000);

  afterAll(async () => {
    for (const table of ['trace_topic_maps', 'trace_facets']) {
      await executeClickHouse(`ALTER TABLE ${table} DELETE WHERE TenantId = '${tenantId}' AND AppId = '${appId}' AND Environment = '${envName}'`);
    }
    await getSupabaseAdmin().from('billing').delete().eq('tenant_id', tenantId);
  });

  it('returns the seeded issues topic and conforms to TopicsResponseSchema', async () => {
    const res = await gatewayFetch('/v1/topics?facet=issues&limit=3');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = TopicsResponseSchema.safeParse(body);
    expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

    const topics = (body as { data: { topics: Array<{ topicId: string; name: string }> } }).data.topics;
    expect(topics.map((t) => t.topicId)).toContain(TOPIC_ISSUES);
    expect(topics.find((t) => t.topicId === TOPIC_ISSUES)?.name).toBe(`Issues topic ${RUN_ID}`);
  });

  it('facet=task returns the task topic, not the issues topic', async () => {
    const res = await gatewayFetch('/v1/topics?facet=task&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { topics: Array<{ topicId: string }> } };
    const ids = body.data.topics.map((t) => t.topicId);
    expect(ids).toContain(TOPIC_TASK);
    expect(ids).not.toContain(TOPIC_ISSUES);
  });

  it('facet=steering returns the steering topic', async () => {
    const res = await gatewayFetch('/v1/topics?facet=steering&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { topics: Array<{ topicId: string }> } };
    expect(body.data.topics.map((t) => t.topicId)).toContain(TOPIC_STEERING);
  });

  it('limit caps the number of returned topics', async () => {
    const res = await gatewayFetch('/v1/topics?facet=issues&limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { topics: unknown[] } };
    expect(body.data.topics.length).toBeLessThanOrEqual(1);
  });

  describe('topics_enabled entitlement gate', () => {
    afterAll(async () => {
      // Restore growth so later tests in this file (and this suite's own
      // afterAll cleanup) see the entitled tier again.
      await setTier(tenantId, 'growth');
    });

    it('402s with entitlement_required on a tier lacking topics_enabled (hobby)', async () => {
      await setTier(tenantId, 'hobby');
      const res = await gatewayFetch('/v1/topics?facet=issues&limit=3');
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string; entitlement: string } };
      expect(body.error.code).toBe('entitlement_required');
      expect(body.error.entitlement).toBe('topics_enabled');
    });

    it('200s on a tier that includes topics_enabled (growth)', async () => {
      await setTier(tenantId, 'growth');
      const res = await gatewayFetch('/v1/topics?facet=issues&limit=3');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toContain('data');
    });
  });
});
