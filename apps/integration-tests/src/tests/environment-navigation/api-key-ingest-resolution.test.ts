/**
 * Request-time env-selection authorization — exercises the REAL gateway
 * resolvers (`resolveIngestEnvironment` / `resolveEnvironmentForSelector`)
 * against a real Supabase, not a re-implemented mirror. This is the security
 * boundary that makes "one CI key for every preview env" safe: a kind-scoped
 * key may select an env (by name or PR number) ONLY within its allowed kinds;
 * a cross-kind selection must resolve to NO env, never leak across kinds.
 *
 * `api-key-env-kinds.test.ts` proves the *schema* + a mirror of the logic; this
 * proves the actual shipped functions behave correctly on real rows — so the
 * two can't silently drift.
 *
 * Test boundary: real Supabase (admin client), real gateway code. The functions
 * take a SupabaseClient + plain params, so they run unchanged in node.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  resolveIngestEnvironment,
  resolveEnvironmentForSelector,
  __clearEnvironmentResolverCache,
} from '@repo/gateway-core/lib/environment-resolver';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { setupEnvNavFixture, type EnvNavFixture } from './helpers';

const PR_NUMBER = 4242;

describe('gateway env-selection authorization (real resolvers, real DB)', () => {
  let admin: SupabaseClient;
  let fx: EnvNavFixture;
  let previewEnv: { id: string; name: string };
  let promotedEnv: { id: string; name: string };

  beforeAll(async () => {
    admin = createSupabaseAdminClient() as unknown as SupabaseClient;
    fx = await setupEnvNavFixture();

    // Preview env: ephemeral + bound to a PR → classifies as `preview`.
    const previewName = `pr-${PR_NUMBER}`;
    const { data: prev, error: prevErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fx.tenantId,
        app_id: fx.appId,
        name: previewName,
        is_default: false,
        is_ephemeral: true,
        source_pr_number: PR_NUMBER,
        source_branch: `pr-${PR_NUMBER}-branch`,
        current_version: 1,
        created_by: fx.ownerUser.id,
      })
      .select('id, name')
      .single();
    if (prevErr || !prev) throw new Error(`preview env: ${prevErr?.message}`);
    previewEnv = { id: prev.id as string, name: prev.name as string };

    // Promoted env: non-ephemeral, pinned (current_version > 0) → `promoted`.
    const { data: prod, error: prodErr } = await admin
      .from('environment')
      .insert({
        tenant_id: fx.tenantId,
        app_id: fx.appId,
        name: `promoted-${randomUUID().slice(0, 8)}`,
        is_default: false,
        is_ephemeral: false,
        current_version: 7,
        created_by: fx.ownerUser.id,
      })
      .select('id, name')
      .single();
    if (prodErr || !prod) throw new Error(`promoted env: ${prodErr?.message}`);
    promotedEnv = { id: prod.id as string, name: prod.name as string };
  });

  afterAll(async () => {
    await fx?.cleanup();
  });

  beforeEach(() => {
    __clearEnvironmentResolverCache();
  });

  // ── resolveEnvironmentForSelector ──────────────────────────────────────────
  it('authorizes a preview-scoped key selecting its preview env by NAME', async () => {
    const res = await resolveEnvironmentForSelector({
      supabase: admin,
      appId: fx.appId,
      tenantId: fx.tenantId,
      selector: { envName: previewEnv.name },
      allowedEnvKinds: ['preview'],
    });
    expect(res.authorized).toBe(true);
    expect(res.env?.id).toBe(previewEnv.id);
    expect(res.env?.targetKind).toBe('preview');
  });

  it('authorizes a preview-scoped key selecting its preview env by PR NUMBER', async () => {
    const res = await resolveEnvironmentForSelector({
      supabase: admin,
      appId: fx.appId,
      tenantId: fx.tenantId,
      selector: { prNumber: PR_NUMBER },
      allowedEnvKinds: ['preview'],
    });
    expect(res.authorized).toBe(true);
    expect(res.env?.id).toBe(previewEnv.id);
  });

  it('REJECTS a preview-scoped key selecting a promoted env (cross-kind)', async () => {
    const res = await resolveEnvironmentForSelector({
      supabase: admin,
      appId: fx.appId,
      tenantId: fx.tenantId,
      selector: { envName: promotedEnv.name },
      allowedEnvKinds: ['preview'],
    });
    // The env resolves, but authorization fails — kind mismatch.
    expect(res.env?.targetKind).toBe('promoted');
    expect(res.authorized).toBe(false);
  });

  it('a key with no allowed kinds is never authorized for any selector', async () => {
    const res = await resolveEnvironmentForSelector({
      supabase: admin,
      appId: fx.appId,
      tenantId: fx.tenantId,
      selector: { envName: previewEnv.name },
      allowedEnvKinds: [],
    });
    expect(res.authorized).toBe(false);
    expect(res.env).toBeNull();
  });

  // ── resolveIngestEnvironment (the trace-ingest entrypoint) ──────────────────
  it('stamps the preview env when a preview key sends X-Outerlayer-Environment', async () => {
    const env = await resolveIngestEnvironment({
      supabase: admin,
      user: { appId: fx.appId, tenantId: fx.tenantId, allowedEnvKinds: ['preview'] },
      envNameHeader: previewEnv.name,
    });
    expect(env?.id).toBe(previewEnv.id);
    expect(env?.targetKind).toBe('preview');
  });

  it('stamps the preview env from X-Outerlayer-Pr-Number', async () => {
    const env = await resolveIngestEnvironment({
      supabase: admin,
      user: { appId: fx.appId, tenantId: fx.tenantId, allowedEnvKinds: ['preview'] },
      prNumberHeader: String(PR_NUMBER),
    });
    expect(env?.id).toBe(previewEnv.id);
  });

  it('SECURITY: a preview key selecting the promoted env stamps NO env (no cross-kind leak)', async () => {
    const env = await resolveIngestEnvironment({
      supabase: admin,
      user: { appId: fx.appId, tenantId: fx.tenantId, allowedEnvKinds: ['preview'] },
      envNameHeader: promotedEnv.name,
    });
    expect(env).toBeNull();
  });

  it('SECURITY: a promoted key cannot ride the PR-number selector into a preview env', async () => {
    const env = await resolveIngestEnvironment({
      supabase: admin,
      user: { appId: fx.appId, tenantId: fx.tenantId, allowedEnvKinds: ['promoted'] },
      prNumberHeader: String(PR_NUMBER),
    });
    expect(env).toBeNull();
  });

  it('a pinned key (no allowed kinds) IGNORES the selection headers entirely', async () => {
    // No allowedEnvKinds → falls through to the pinned path; with no apiKeyId
    // that resolves to null. The point: the promoted-env header is NOT honored,
    // so a non-kind key can never select an env it was not bound to.
    const env = await resolveIngestEnvironment({
      supabase: admin,
      user: { appId: fx.appId, tenantId: fx.tenantId },
      envNameHeader: promotedEnv.name,
      prNumberHeader: String(PR_NUMBER),
    });
    expect(env).toBeNull();
  });
});
