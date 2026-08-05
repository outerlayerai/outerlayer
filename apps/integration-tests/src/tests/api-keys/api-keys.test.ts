/**
 * HTTP-level integration tests for /v1/api-keys.
 *
 * Coverage:
 *   1. List endpoint is registered, returns a valid envelope, and only
 *      returns keys for the caller's tenant (cross-tenant isolation via a
 *      foreign-tenant row seeded directly in Postgres with the admin
 *      client).
 *   2. Create endpoint returns `data.plaintext_key` exactly once on 201
 *      and never echoes plaintext on subsequent List/Delete calls.
 *   3. Delete endpoint removes the metadata row — the production reject
 *      signal — and returns 204; second delete returns 404.
 *   4. Cross-tenant isolation: a row seeded under another tenant_id is
 *      not surfaced to the caller, and revoking it returns 404.
 *   5. Plaintext NEVER appears in non-creation responses (deep string
 *      scan of every body returned).
 *   6. Real-key auth round-trips against the live verify path: a freshly
 *      minted key authenticates (200 — the pepper-parity canary); a
 *      revoked key (row deleted) is rejected 401 on next use; an expired
 *      key (expires_at in the past) is rejected 401.
 *
 * Verify path (real key-store, no bypass):
 *   The gateway-http harness boots `wrangler dev` with no auth bypass, so
 *   every API-key request runs the real Postgres key-store path:
 *   `verify_api_key` looks up the peppered
 *   HMAC digest of the presented key. That's why the round-trips below are
 *   meaningful — a wrong pepper, a deleted row, or a past `expires_at` each
 *   make the digest fail to resolve → 401. Keys are minted via `mintTestApiKey`
 *   (the same `@repo/api-key-service` mint used by the seed script) with the
 *   pepper the gateway boots with.
 *
 * Gateway-RLS dependency:
 *   The `gateway` Postgres role needs SELECT/INSERT/DELETE grants +
 *   tenant-scoped RLS policies on `public.api_key`. Added in
 *   `supabase/schemas/95-gateway-rls.sql` and migration
 *   `20260505000003_grant_gateway_api_key.sql`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey } from '@repo/api-key-service';
import { gatewayFetch, mintTestApiKey } from '../gateway-http/client';
import { GATEWAY_URL, getTestAppId, getTestTenantId } from '../../../gateway-http/setup-gateway';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { resolvePepper } from '../../lib/mint-test-key';
import {
  ensureDefaultEnvironment,
  resolveDefaultEnvironmentId,
} from '../../lib/environment-test-utils';

const RUN_ID = `t034-${Date.now().toString(36)}`;
const admin = createSupabaseAdminClient();

type ApiKey = {
  id: string;
  name: string;
  app_id: string;
  permissions: string[];
  key_prefix: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
};

type ListBody = {
  data: ApiKey[];
  pagination: { total: number; limit: number; offset: number };
};

type CreateBody = {
  data: ApiKey & { plaintext_key: string };
};

type ErrorBody = {
  error: { code: string; message: string };
};

/** True if any string field anywhere in `value` matches the plaintext token. */
function deepIncludesPlaintext(value: unknown, plaintext: string): boolean {
  if (typeof value === 'string') return value.includes(plaintext);
  if (Array.isArray(value)) return value.some((v) => deepIncludesPlaintext(v, plaintext));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      deepIncludesPlaintext(v, plaintext),
    );
  }
  return false;
}

async function listKeys(): Promise<{ status: number; body: ListBody }> {
  const res = await gatewayFetch('/v1/api-keys?limit=100&offset=0');
  const body = (await res.json()) as ListBody;
  return { status: res.status, body };
}

async function createKey(name: string, permissions: string[] = []): Promise<{
  status: number;
  body: CreateBody | ErrorBody;
}> {
  const res = await gatewayFetch('/v1/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name, permissions }),
  });
  return { status: res.status, body: (await res.json()) as CreateBody | ErrorBody };
}

async function revokeKey(id: string): Promise<Response> {
  return gatewayFetch(`/v1/api-keys/${id}`, { method: 'DELETE' });
}

function isCreated(b: CreateBody | ErrorBody): b is CreateBody {
  return (b as CreateBody).data !== undefined && typeof (b as CreateBody).data?.id === 'string';
}

describe('GET /v1/api-keys — list endpoint', () => {
  it('returns 200 with a valid pagination envelope', async () => {
    const { status, body } = await listKeys();
    expect(status).toBe(200);
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
    expect(body.pagination).toMatchObject({ limit: 100, offset: 0 });
    expect(body.data).toBeInstanceOf(Array);
  });

  it('never includes a field literally named plaintext_key on any row', async () => {
    const { body } = await listKeys();
    for (const row of body.data) {
      expect((row as unknown as Record<string, unknown>).plaintext_key).toBeUndefined();
    }
  });

  it('every returned row has app_id matching the caller’s app', async () => {
    const { body } = await listKeys();
    const callerAppId = getTestAppId();
    for (const row of body.data) {
      expect(row.app_id).toBe(callerAppId);
    }
  });
});

describe('POST /v1/api-keys — create', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    if (createdIds.length > 0) {
      await admin.from('api_key').delete().in('id', createdIds);
    }
  });

  it('rejects unknown permissions with 400', async () => {
    const res = await gatewayFetch('/v1/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        name: `${RUN_ID}-bad-perms`,
        permissions: ['definitely.not.a.real.permission'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it(
    'returns 201 with plaintext_key exactly once',
    async () => {
      const { status, body } = await createKey(`${RUN_ID}-create-1`);
      expect(status).toBe(201);
      if (!isCreated(body)) throw new Error('expected created body');
      expect(body.data.id).toBeTypeOf('string');
      expect(body.data.id.length).toBeGreaterThan(0);
      expect(body.data.name).toBe(`${RUN_ID}-create-1`);
      expect(body.data.plaintext_key).toBeTypeOf('string');
      expect(body.data.plaintext_key.length).toBeGreaterThan(0);
      createdIds.push(body.data.id);
    },
  );

  it(
    'plaintext returned by POST does not appear in subsequent list/delete bodies',
    async () => {
      const { body: created } = await createKey(`${RUN_ID}-leak`);
      if (!isCreated(created)) throw new Error('expected created body');
      const plaintext = created.data.plaintext_key;
      const id = created.data.id;
      createdIds.push(id);

      // List
      const list = await gatewayFetch('/v1/api-keys');
      const listText = await list.text();
      expect(listText.includes(plaintext)).toBe(false);

      // Delete (204 — no body, but still scan response text)
      const del = await gatewayFetch(`/v1/api-keys/${id}`, { method: 'DELETE' });
      const delText = await del.text();
      expect(delText.includes(plaintext)).toBe(false);

      // List again post-delete
      const list2 = await gatewayFetch('/v1/api-keys');
      const list2Text = await list2.text();
      expect(list2Text.includes(plaintext)).toBe(false);

      // Confirm no row literally contains plaintext anywhere in the JSON tree.
      const list2Body = JSON.parse(list2Text) as ListBody;
      expect(deepIncludesPlaintext(list2Body, plaintext)).toBe(false);
    },
  );
});

describe('DELETE /v1/api-keys/:id — revoke', () => {
  it('returns 404 for a UUID that does not match any key', async () => {
    const res = await revokeKey('00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it(
    'returns 204 and the key is no longer listable',
    async () => {
      const { body: created } = await createKey(`${RUN_ID}-revoke`);
      if (!isCreated(created)) throw new Error('expected created body');
      const id = created.data.id;

      const before = await listKeys();
      expect(before.body.data.some((k) => k.id === id)).toBe(true);

      const res = await revokeKey(id);
      expect(res.status).toBe(204);

      const after = await listKeys();
      expect(after.body.data.some((k) => k.id === id)).toBe(false);
    },
  );

  it(
    'removes the metadata row from the database (production reject signal)',
    async () => {
      // Revocation deletes the `api_key` row; ON DELETE CASCADE drops its
      // `api_key_secret` digest. This test pins that reject signal at the
      // data layer — the row is gone after DELETE, so `verify_api_key` can
      // no longer resolve the digest to a tenant and the next verify → 401.
      // (The end-to-end "revoked plaintext as Bearer → 401" replay lives in
      // the real-key round-trips block below.)
      const { body: created } = await createKey(`${RUN_ID}-row-gone`);
      if (!isCreated(created)) throw new Error('expected created body');
      const id = created.data.id;

      const res = await revokeKey(id);
      expect(res.status).toBe(204);

      const { data: rows } = await admin.from('api_key').select('id').eq('id', id);
      expect(rows ?? []).toEqual([]);
    },
  );
});

describe('cross-tenant isolation', () => {
  let foreignTenantId: string | null = null;
  let foreignAppId: string | null = null;
  let foreignKeyRowId: string | null = null;

  beforeAll(async () => {
    // Build a parallel tenant + app the caller does NOT belong to and seed
    // an api_key row under it. The list endpoint scopes by `app_id =
    // user.appId` AND tenant-RLS — both filters should exclude this row.
    // Schema: tenant has organization_name + company_name (UNIQUE).
    const { data: tenant, error: tErr } = await admin
      .from('tenant')
      .insert({
        organization_name: `t034-${RUN_ID}`,
        company_name: `t034 cross tenant ${RUN_ID}`,
      })
      .select('tenant_id')
      .single();
    if (tErr || !tenant) throw tErr ?? new Error('tenant insert failed');
    foreignTenantId = tenant.tenant_id;

    const { data: app, error: aErr } = await admin
      .from('app')
      .insert({ name: `t034-cross-app-${RUN_ID}`, tenant_id: foreignTenantId })
      .select('id')
      .single();
    if (aErr || !app) throw aErr ?? new Error('app insert failed');
    foreignAppId = app.id;

    // Every app has a default `dev` env (api_key.environment_id is NOT NULL).
    // It is auto-seeded by the `on_create_seed_default_env` trigger on app
    // insert; resolve its id via the fetch-or-create helper rather than
    // inserting a colliding duplicate.
    const foreignEnvId = await ensureDefaultEnvironment(
      foreignAppId,
      foreignTenantId,
    );

    const { data: row, error: kErr } = await admin
      .from('api_key')
      .insert({
        name: `${RUN_ID}-foreign-key`,
        api_key_id: `key_foreign_${RUN_ID}`,
        app_id: foreignAppId,
        tenant_id: foreignTenantId,
        environment_id: foreignEnvId,
      })
      .select('id')
      .single();
    if (kErr || !row) throw kErr ?? new Error('api_key insert failed');
    foreignKeyRowId = row.id;
  });

  afterAll(async () => {
    if (foreignKeyRowId) {
      await admin.from('api_key').delete().eq('id', foreignKeyRowId);
    }
    if (foreignAppId) {
      await admin.from('environment').delete().eq('app_id', foreignAppId);
      await admin.from('app').delete().eq('id', foreignAppId);
    }
    if (foreignTenantId) {
      await admin.from('tenant').delete().eq('tenant_id', foreignTenantId);
    }
  });

  it('does not list api_keys belonging to a different tenant', async () => {
    const { body } = await listKeys();
    expect(body.data.some((k) => k.id === foreignKeyRowId)).toBe(false);
  });

  it('returns 404 when revoking another tenant’s key by id', async () => {
    expect(foreignKeyRowId).not.toBeNull();
    const res = await revokeKey(foreignKeyRowId!);
    expect(res.status).toBe(404);

    // Defense in depth: confirm the foreign row was NOT deleted by our
    // caller — guards against the lookup path silently dropping the
    // wrong row.
    const { data: stillThere } = await admin
      .from('api_key')
      .select('id')
      .eq('id', foreignKeyRowId!);
    expect(stillThere ?? []).toHaveLength(1);
  });
});

describe('real-key auth round-trips — live verify path', () => {
  // The harness boots wrangler with no auth bypass, so these send a REAL
  // minted key as Bearer and observe the verify_api_key outcome
  // directly (no stub, no cache masking — each key below is a fresh, distinct
  // digest). Keys are minted directly against the seeded app so the appId
  // cross-check passes and only the key's live/expiry state decides the result.
  let seedEnvId: string;
  const mintedNames: string[] = [];

  beforeAll(async () => {
    seedEnvId = await resolveDefaultEnvironmentId(getTestAppId());
  });

  afterAll(async () => {
    if (mintedNames.length > 0) {
      await admin
        .from('api_key')
        .delete()
        .in('name', mintedNames)
        .eq('app_id', getTestAppId());
    }
  });

  async function mintSeedAppKey(opts: {
    name: string;
    permissions: string[];
    expiresAt?: string | null;
  }): Promise<string> {
    mintedNames.push(opts.name);
    return mintTestApiKey({
      tenantId: getTestTenantId(),
      appId: getTestAppId(),
      environmentId: seedEnvId,
      permissions: opts.permissions,
      name: opts.name,
      expiresAt: opts.expiresAt ?? null,
    });
  }

  /** Call an authed endpoint with an arbitrary Bearer key against the seeded app. */
  async function callWithKey(path: string, key: string): Promise<Response> {
    return fetch(`${GATEWAY_URL}${path}`, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-outerlayer-app-id': getTestAppId(),
      },
    });
  }

  it('a freshly minted key authenticates (200) — pepper-parity canary', async () => {
    const key = await mintSeedAppKey({
      name: `${RUN_ID}-fresh`,
      permissions: ['environment.read'],
    });
    const res = await callWithKey('/v1/environments', key);
    // verify_api_key resolves the digest, appId matches, environment.read is
    // granted → 200. Had the seeder's pepper differed from the gateway's, the
    // digest wouldn't resolve → 401. So a 200 here pins pepper parity.
    expect(res.status).toBe(200);
  });

  it('verify_api_key returns the UserMeta payload with NO costMap field', async () => {
    // Direct-RPC pin: the key-store function resolves the full identity
    // payload every API request depends on, without deriving a `costMap` —
    // cost data comes from the trace-cost registry, not a config table.
    const key = await mintSeedAppKey({
      name: `${RUN_ID}-usermeta`,
      permissions: ['environment.read'],
    });
    const digest = await hashApiKey(key, resolvePepper());
    const { data, error } = await admin.rpc('verify_api_key', {
      p_key_digest: digest,
    });
    expect(error).toBeNull();
    const payload = data as Record<string, unknown>;
    expect(payload.appId).toBe(getTestAppId());
    expect(payload.tenantId).toBe(getTestTenantId());
    expect(payload.permissions).toEqual(['environment.read']);
    // The accepted change: costMap is gone from the payload entirely.
    expect('costMap' in payload).toBe(false);
  });

  it('a revoked key (row deleted before first use) is rejected 401', async () => {
    const name = `${RUN_ID}-revoked`;
    const key = await mintSeedAppKey({ name, permissions: ['environment.read'] });
    // Delete the row BEFORE the key is ever used, so no cached userMeta can
    // mask the revocation — the very first verify sees no live digest.
    const { error } = await admin
      .from('api_key')
      .delete()
      .eq('name', name)
      .eq('app_id', getTestAppId());
    expect(error).toBeNull();

    const res = await callWithKey('/v1/environments', key);
    // No live digest matches → 401 (the production reject signal for every route).
    expect(res.status).toBe(401);
  });

  it('an expired key (expires_at in the past) is rejected 401', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const key = await mintSeedAppKey({
      name: `${RUN_ID}-expired`,
      permissions: ['environment.read'],
      expiresAt: past,
    });
    const res = await callWithKey('/v1/environments', key);
    // verify_api_key gates on expires_at (NULL or > now()); a past value → no
    // match → 401.
    expect(res.status).toBe(401);
  });

  it('the create→revoke lifecycle leaves no metadata row (production reject pre-condition)', async () => {
    const { body: created } = await createKey(`${RUN_ID}-revoke-lifecycle`);
    if (!isCreated(created)) throw new Error('expected created body');
    const id = created.data.id;

    const res = await revokeKey(id);
    expect(res.status).toBe(204);

    const { data: rows } = await admin.from('api_key').select('id').eq('id', id);
    expect(rows ?? []).toEqual([]);
  });
});
