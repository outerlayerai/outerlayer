/**
 * HTTP-level coverage for `GET /v1/context/changes`. The route reads
 * Postgres (`context_snapshot`), not ClickHouse, so fixtures are seeded via
 * Supabase REST the same way `response-schema-conformance.test.ts` seeds
 * `api_key` rows.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextChangesResponseSchema } from '@repo/api-schemas';
import { gatewayFetch, getTestTenantId } from './client';
import { getTestAppId } from '../../../gateway-http/setup-gateway';
import { getSupabaseAdmin } from '../../lib/test-utils';

const RUN_ID = randomUUID().slice(0, 8);

describe('GET /v1/context/changes', () => {
  const tenantId = getTestTenantId();
  const appId = getTestAppId();
  const seededIds: string[] = [];

  const OLDER_SHA = `older-${RUN_ID}`;
  const NEWER_SHA = `newer-${RUN_ID}`;

  beforeAll(async () => {
    const admin = getSupabaseAdmin();
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();

    const { data: olderRow, error: olderError } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        commit_sha: OLDER_SHA,
        classifier_version: 1,
        created_at: older,
      })
      .select('id')
      .single();
    if (olderError) throw new Error(`seed context_snapshot (older): ${olderError.message}`);
    seededIds.push(olderRow!.id as string);

    const { data: newerRow, error: newerError } = await admin
      .from('context_snapshot')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        commit_sha: NEWER_SHA,
        classifier_version: 1,
        created_at: newer,
      })
      .select('id')
      .single();
    if (newerError) throw new Error(`seed context_snapshot (newer): ${newerError.message}`);
    seededIds.push(newerRow!.id as string);
  }, 30_000);

  afterAll(async () => {
    if (seededIds.length > 0) {
      await getSupabaseAdmin().from('context_snapshot').delete().in('id', seededIds);
    }
  });

  it('conforms to ContextChangesResponseSchema and orders snapshots newest-first', async () => {
    const res = await gatewayFetch('/v1/context/changes?limit=50');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ContextChangesResponseSchema.safeParse(body);
    expect(parsed.success, `schema violation: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);

    const snapshots = (body as { data: { snapshots: Array<{ id: string; commitSha: string }> } }).data.snapshots;
    const seeded = snapshots.filter((s) => seededIds.includes(s.id));
    expect(seeded.map((s) => s.commitSha)).toEqual([NEWER_SHA, OLDER_SHA]);
  });

  it('limit + offset paginate over the seeded rows', async () => {
    const res = await gatewayFetch('/v1/context/changes?limit=1&offset=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { snapshots: Array<{ commitSha: string }>; pagination: { total: number; limit: number; offset: number } } };
    expect(body.data.snapshots).toHaveLength(1);
    expect(body.data.pagination.limit).toBe(1);
    expect(body.data.pagination.offset).toBe(0);
  });
});
