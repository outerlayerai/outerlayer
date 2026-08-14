/**
 * Unit tests for POST /v1/emitted-results (openapi/routes/emitted-results.ts,
 * EmitResult) — the check-outcome emit pipe.
 *
 * Drives the handler directly with a mocked context (the artifacts-route
 * pattern): the scoped Supabase client is replaced at the `getScopedSupabase`
 * seam with a stateful fake covering the two Postgres tables the route
 * touches. There is no blob, storage-cap, or ClickHouse surface here — an
 * emitted result is a single anchored row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Scoped-Supabase seam: a stateful fake for the two tables the route reads
// and writes. Calls are captured into plain arrays and asserted with toEqual.
type StoredEmittedResultRow = {
  id: string;
  name: string;
  result: string;
  provenance: string;
  verification: string;
  pr_number: number;
  repository: string;
};
// Consumed one entry per emitted_result select (pre-check first, then the
// post-upsert re-read); an exhausted queue reads as "no row".
let emittedSelectQueue: Array<StoredEmittedResultRow | null> = [];
let prRowExists = false;
let upsertIgnored = false;
let emittedSelectError: string | null = null;
let prSelectError: string | null = null;
let upsertError: string | null = null;
const emittedUpserts: Array<{ row: Record<string, unknown>; options: Record<string, unknown> }> = [];
const emittedLookups: Array<{ appId: string; clientEmitId: string }> = [];
const prLookups: Array<{ appId: string; prNumber: number }> = [];

function scopedDb() {
  return {
    from: (table: string) => {
      if (table === 'emitted_result') {
        return {
          select: () => ({
            eq: (_appCol: string, appId: string) => ({
              eq: (_idCol: string, clientEmitId: string) => ({
                maybeSingle: async () => {
                  emittedLookups.push({ appId, clientEmitId });
                  if (emittedSelectError) return { data: null, error: { message: emittedSelectError } };
                  const next = emittedSelectQueue.length > 0 ? emittedSelectQueue.shift()! : null;
                  return { data: next, error: null };
                },
              }),
            }),
          }),
          upsert: (row: Record<string, unknown>, options: Record<string, unknown>) => {
            emittedUpserts.push({ row, options });
            return {
              select: () => ({
                maybeSingle: async () => {
                  if (upsertError) return { data: null, error: { message: upsertError } };
                  return {
                    data: upsertIgnored
                      ? null
                      : {
                          id: 'emitted-uuid-1',
                          name: row.name,
                          result: row.result,
                          provenance: row.provenance,
                          verification: row.verification,
                          pr_number: row.pr_number,
                          repository: row.repository,
                        },
                    error: null,
                  };
                },
              }),
            };
          },
        };
      }
      if (table === 'pull_request') {
        return {
          select: () => ({
            eq: (_appCol: string, appId: string) => ({
              eq: (_prCol: string, prNumber: number) => ({
                limit: () => ({
                  maybeSingle: async () => {
                    prLookups.push({ appId, prNumber });
                    if (prSelectError) return { data: null, error: { message: prSelectError } };
                    return { data: prRowExists ? { id: 'pr-uuid-1' } : null, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

vi.mock('../routes/_shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routes/_shared')>()),
  getScopedSupabase: vi.fn(async () => scopedDb()),
}));

import type { AppContext } from '../routes/_shared';
import { EmitResult } from '../routes/emitted-results';
import { PR_COMMENT_QUEUE_DEBOUNCE_SECONDS } from '../../types/queue-messages';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function emitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    emit: {
      clientEmitId: 'emit_01HZX4T8',
      name: 'smoke.pass',
      result: 'pass',
      link: 'https://github.com/acme/api/actions/runs/123',
      emittedAt: '2026-08-14T10:00:00.000Z',
      prNumber: 512,
      repository: 'Acme/API',
      ...over,
    },
  };
}

type UserOver = Partial<{ actorMembershipId: string }>;

function ctxFor(
  body: Record<string, unknown>,
  userOver: UserOver = {},
  envOver: Record<string, unknown> = {},
): { ctx: AppContext; status: () => number; json: () => any } {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    get: (k: string) => {
      if (k === 'user') {
        return { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key_abc', ...userOver };
      }
      return undefined;
    },
    env: { ...envOver },
    req: {
      json: async () => body,
      method: 'POST',
      path: '/v1/emitted-results',
    },
    json: (b: unknown, s?: number) => {
      captured = { body: b, status: s ?? 200 };
      return new Response(JSON.stringify(b), { status: s ?? 200 });
    },
  } as unknown as AppContext;
  return { ctx, status: () => captured.status, json: () => captured.body };
}

beforeEach(() => {
  emittedSelectQueue = [];
  prRowExists = false;
  upsertIgnored = false;
  emittedSelectError = null;
  prSelectError = null;
  upsertError = null;
  emittedUpserts.length = 0;
  emittedLookups.length = 0;
  prLookups.length = 0;
});

// ---------------------------------------------------------------------------
// POST /v1/emitted-results
// ---------------------------------------------------------------------------

describe('EmitResult', () => {
  it('rejects a malformed body with 400 invalid_request_body naming the first issue path', async () => {
    const { ctx, status, json } = ctxFor({ schemaVersion: 1 });
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(400);
    const body = json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request_body');
    expect(body.error.message).toContain('Invalid emitted-result payload: emit');
    expect(emittedUpserts).toEqual([]);
  });

  it('rejects a non-http(s) link with the refine message on its path', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ link: 'ftp://ci.example/run/1' }));
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(400);
    expect((json() as { error: { message: string } }).error.message).toBe(
      'Invalid emitted-result payload: emit.link: must be an http:// or https:// URL',
    );
    expect(emittedUpserts).toEqual([]);
  });

  it('rejects a link containing whitespace — a raw newline would break out of the markdown link the comment renders', async () => {
    for (const link of [
      'https://ci.example/run\n⚠ **fake row**',
      'https://ci.example/run 1',
      'https://ci.example/run\t1',
    ]) {
      const { ctx, status, json } = ctxFor(emitBody({ link }));
      await new EmitResult({} as never).handle(ctx);
      expect(status()).toBe(400);
      expect((json() as { error: { message: string } }).error.message).toBe(
        'Invalid emitted-result payload: emit.link: must not contain whitespace — percent-encode it',
      );
    }
    expect(emittedUpserts).toEqual([]);
  });

  it('rejects an empty link, an over-cap link, and an unparseable timestamp', async () => {
    for (const [over, path] of [
      [{ link: '' }, 'emit.link'],
      [{ link: `https://${'a'.repeat(494)}` }, 'emit.link'],
      [{ emittedAt: 'not-a-time' }, 'emit.emittedAt'],
    ] as const) {
      const { ctx, status, json } = ctxFor(emitBody(over));
      await new EmitResult({} as never).handle(ctx);
      expect(status()).toBe(400);
      const body = json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('invalid_request_body');
      expect(body.error.message).toContain(path);
    }
    expect(emittedUpserts).toEqual([]);
  });

  it('rejects a name off the declaration shape and a result off the pass/fail enum', async () => {
    for (const [over, path] of [
      [{ name: 'Smoke.Pass' }, 'emit.name'],
      [{ name: '<img>' }, 'emit.name'],
      [{ result: 'skip' }, 'emit.result'],
    ] as const) {
      const { ctx, status, json } = ctxFor(emitBody(over));
      await new EmitResult({} as never).handle(ctx);
      expect(status()).toBe(400);
      expect((json() as { error: { message: string } }).error.message).toContain(path);
    }
    expect(emittedUpserts).toEqual([]);
  });

  it('requires prNumber — an emit without a PR anchor never parses', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ prNumber: undefined }));
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(400);
    const body = json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request_body');
    expect(body.error.message).toContain('emit.prNumber');
    expect(emittedUpserts).toEqual([]);

    const zero = ctxFor(emitBody({ prNumber: 0 }));
    await new EmitResult({} as never).handle(zero.ctx);
    expect(zero.status()).toBe(400);
    expect((zero.json() as { error: { message: string } }).error.message).toContain('emit.prNumber');
  });

  // proves AC-085-12
  it('stores a CI emit from a shared machine key: name, result, link, ci provenance, and the PR anchor, echoed back', async () => {
    prRowExists = true;
    // No actorMembershipId override: a shared machine key.
    const { ctx, status, json } = ctxFor(emitBody({ ci: true }));
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(prLookups).toEqual([{ appId: 'app-1', prNumber: 512 }]);
    expect(emittedUpserts).toHaveLength(1);
    expect(emittedUpserts[0]!.row).toEqual({
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      client_emit_id: 'emit_01HZX4T8',
      name: 'smoke.pass',
      result: 'pass',
      link: 'https://github.com/acme/api/actions/runs/123',
      provenance: 'ci',
      repository: 'acme/api',
      pr_number: 512,
      verification: 'confirmed',
      emitted_at: '2026-08-14T10:00:00.000Z',
    });
    expect(emittedUpserts[0]!.options).toEqual({
      onConflict: 'app_id,client_emit_id',
      ignoreDuplicates: true,
    });
    expect(json()).toEqual({
      data: {
        id: 'emitted-uuid-1',
        name: 'smoke.pass',
        result: 'pass',
        provenance: 'ci',
        verification: 'confirmed',
        prNumber: 512,
        repository: 'acme/api',
      },
    });
  });

  it('downgrades a ci claim from an actor-bound key to local', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ ci: true }), { actorMembershipId: 'membership-42' });
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(emittedUpserts[0]!.row.provenance).toBe('local');
    expect((json() as { data: { provenance: string } }).data.provenance).toBe('local');
  });

  it('derives provenance server-side even when the caller smuggles a provenance field (schema strips it)', async () => {
    const { ctx, status } = ctxFor(emitBody({ provenance: 'ci' }));
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    // No ci flag and no shared-key signal honored: the smuggled claim never
    // reaches the row — the derived value is local.
    expect(emittedUpserts[0]!.row).toEqual({
      tenant_id: 'tenant-1',
      app_id: 'app-1',
      client_emit_id: 'emit_01HZX4T8',
      name: 'smoke.pass',
      result: 'pass',
      link: 'https://github.com/acme/api/actions/runs/123',
      provenance: 'local',
      repository: 'acme/api',
      pr_number: 512,
      verification: 'pending',
      emitted_at: '2026-08-14T10:00:00.000Z',
    });
  });

  it('stores a fail outcome verbatim', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ result: 'fail' }));
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(emittedUpserts[0]!.row.result).toBe('fail');
    expect((json() as { data: { result: string } }).data.result).toBe('fail');
  });

  it('refuses an emit that resolves no repository, storing nothing', async () => {
    const { ctx, status, json } = ctxFor(emitBody({ repository: undefined }));
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(400);
    expect(json()).toEqual({
      error: { code: 'nothing_to_attach', message: 'nothing to attach this to' },
    });
    expect(prLookups).toEqual([]);
    expect(emittedUpserts).toEqual([]);
  });

  it('refuses a repository that is not a GitHub.com owner/repo — never a best-effort guess', async () => {
    const { ctx, status, json } = ctxFor(
      emitBody({ repository: undefined, gitRepo: 'git.acme-enterprise.com/acme/api' }),
    );
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(400);
    expect((json() as { error: { code: string } }).error.code).toBe('nothing_to_attach');
    expect(emittedUpserts).toEqual([]);
  });

  it('falls back to the canonicalized gitRepo when no bare repository is supplied', async () => {
    const { ctx, status } = ctxFor(emitBody({ repository: undefined, gitRepo: 'github.com/Acme/API' }));
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(emittedUpserts[0]!.row.repository).toBe('acme/api');
  });

  it('stores pending verification when no pull_request row exists yet', async () => {
    prRowExists = false;
    const { ctx, status, json } = ctxFor(emitBody());
    await new EmitResult({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(prLookups).toEqual([{ appId: 'app-1', prNumber: 512 }]);
    expect(emittedUpserts[0]!.row.verification).toBe('pending');
    expect((json() as { data: { verification: string } }).data.verification).toBe('pending');
  });

  it('returns the stored row on an idempotent retry without a second insert or anchor check', async () => {
    emittedSelectQueue.push({
      id: 'emitted-uuid-9',
      name: 'smoke.pass',
      result: 'fail',
      provenance: 'ci',
      verification: 'confirmed',
      pr_number: 512,
      repository: 'acme/api',
    });
    const { ctx, status, json } = ctxFor(emitBody());
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(json()).toEqual({
      data: {
        id: 'emitted-uuid-9',
        name: 'smoke.pass',
        result: 'fail',
        provenance: 'ci',
        verification: 'confirmed',
        prNumber: 512,
        repository: 'acme/api',
      },
    });
    expect(emittedLookups).toEqual([{ appId: 'app-1', clientEmitId: 'emit_01HZX4T8' }]);
    expect(emittedUpserts).toEqual([]);
    expect(prLookups).toEqual([]);
  });

  it('returns the winner row when a concurrent duplicate makes the upsert a no-op', async () => {
    upsertIgnored = true;
    // Pre-check misses (the duplicate lands mid-request), the post-upsert
    // re-read finds the winner.
    emittedSelectQueue = [
      null,
      {
        id: 'emitted-uuid-7',
        name: 'smoke.pass',
        result: 'pass',
        provenance: 'local',
        verification: 'pending',
        pr_number: 512,
        repository: 'acme/api',
      },
    ];
    const { ctx, status, json } = ctxFor(emitBody());
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(json()).toEqual({
      data: {
        id: 'emitted-uuid-7',
        name: 'smoke.pass',
        result: 'pass',
        provenance: 'local',
        verification: 'pending',
        prNumber: 512,
        repository: 'acme/api',
      },
    });
    expect(emittedLookups).toEqual([
      { appId: 'app-1', clientEmitId: 'emit_01HZX4T8' },
      { appId: 'app-1', clientEmitId: 'emit_01HZX4T8' },
    ]);
  });

  it('propagates a store failure as a throw (500), never deciding the emit either way', async () => {
    emittedSelectError = 'connection reset';
    await expect(new EmitResult({} as never).handle(ctxFor(emitBody()).ctx)).rejects.toThrow(
      'emitted_result lookup failed: connection reset',
    );
    expect(emittedUpserts).toEqual([]);

    emittedSelectError = null;
    prSelectError = 'connection reset';
    await expect(new EmitResult({} as never).handle(ctxFor(emitBody()).ctx)).rejects.toThrow(
      'pull_request lookup failed: connection reset',
    );
    expect(emittedUpserts).toEqual([]);

    prSelectError = null;
    upsertError = 'unique_violation something unexpected';
    await expect(new EmitResult({} as never).handle(ctxFor(emitBody()).ctx)).rejects.toThrow(
      'emitted_result insert failed: unique_violation something unexpected',
    );
  });

  it('declares the OpenAPI contract: tag, request schema, response set, and the data envelope', () => {
    const route = new EmitResult({} as never);
    const schema = route.schema as {
      tags: string[];
      request: { body: { content: Record<string, { schema?: { shape?: Record<string, unknown> } }> } };
      responses: Record<string, { content?: Record<string, { schema?: { shape?: Record<string, unknown> } }> }>;
    };

    expect(schema.tags).toEqual(['Emitted Results']);
    expect(Object.keys(schema.request.body.content)).toEqual(['application/json']);
    expect(schema.request.body.content['application/json']!.schema?.shape).toHaveProperty('emit');
    expect(Object.keys(schema.responses).sort()).toEqual(['200', '400', '401']);
    // Kills `content: {}` and `content: { 'application/json': {} }`.
    expect(schema.responses['200']!.content?.['application/json']?.schema?.shape).toHaveProperty('data');
  });
});

// ---------------------------------------------------------------------------
// PR_COMMENT_QUEUE nomination
// ---------------------------------------------------------------------------

describe('EmitResult PR_COMMENT_QUEUE nomination', () => {
  it('nominates the PR for a comment refresh with the canonical repo key and the shared debounce', async () => {
    prRowExists = true;
    const queue = { sendBatch: vi.fn(async () => {}) };
    const { ctx, status } = ctxFor(emitBody({ ci: true }), {}, { PR_COMMENT_QUEUE: queue });
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(queue.sendBatch).toHaveBeenCalledWith([
      {
        body: {
          tenantId: 'tenant-1',
          repository: 'acme/api',
          prNumber: 512,
          enqueuedAt: expect.any(Number),
        },
        delaySeconds: PR_COMMENT_QUEUE_DEBOUNCE_SECONDS,
      },
    ]);
  });

  it('does not nominate on an idempotent retry — the stored row already had its refresh', async () => {
    emittedSelectQueue.push({
      id: 'emitted-uuid-9',
      name: 'smoke.pass',
      result: 'pass',
      provenance: 'ci',
      verification: 'confirmed',
      pr_number: 512,
      repository: 'acme/api',
    });
    const queue = { sendBatch: vi.fn(async () => {}) };
    const { ctx, status } = ctxFor(emitBody(), {}, { PR_COMMENT_QUEUE: queue });
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect(queue.sendBatch).not.toHaveBeenCalled();
  });

  it('swallows a sendBatch throw without failing the emit', async () => {
    prRowExists = true;
    const queue = {
      sendBatch: vi.fn(async () => {
        throw new Error('queue unavailable');
      }),
    };
    const { ctx, status, json } = ctxFor(emitBody(), {}, { PR_COMMENT_QUEUE: queue });
    await new EmitResult({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: { prNumber: number } }).data.prNumber).toBe(512);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
  });
});
