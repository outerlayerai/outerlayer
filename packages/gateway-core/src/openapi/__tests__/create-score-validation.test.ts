/**
 * Unit tests for the LIVE POST /v1/scores handler (openapi/routes/scores.ts
 * CreateScore / CreateScoresBatch) — the registered endpoints.
 *
 * Score writes are SHAPE-ONLY: validated by the Zod body schema + the dataType
 * allowlist, then stored exactly as submitted. There is no server-side score
 * config — the handler issues NO Supabase config query and accepts any
 * range/category payload verbatim. Env resolution is best-effort and degrades
 * to empty triples here (mocked CH returns no rows; the api-key fallback is
 * mocked to null).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../analytics-factory', () => ({
  getGatewayAnalyticsService: vi.fn(() => null),
}));

// Capture every ClickHouse insert so we can assert the stored row.
const insertedRows: Array<Record<string, unknown>> = [];
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    query: vi.fn(async () => ({ json: async () => [] })),
    insert: vi.fn(async (params: { values: Array<Record<string, unknown>> }) => {
      insertedRows.push(...params.values);
    }),
    close: vi.fn(async () => {}),
  })),
}));

// A spy standing in for ANY Supabase access from the score path. The shape-only
// handler must never reach for a config row, so this must stay uncalled — the
// pin that proves the score-config read is gone. Hoisted so the `vi.mock`
// factory below (itself hoisted) can close over it.
const { getScopedSupabase } = vi.hoisted(() => ({
  getScopedSupabase: vi.fn(() => {
    throw new Error('score write must not query Supabase for config');
  }),
}));
vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return { ...actual, getScopedSupabase };
});
vi.mock('../../lib/environment-resolver', () => ({
  resolveEnvironmentFromApiKey: vi.fn(async () => null),
}));
vi.mock('../../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: vi.fn(() => ({})),
}));

import type { AppContext } from '../routes/_shared';
import { CreateScore, CreateScoresBatch } from '../routes/scores';

function ctxFor(body: Record<string, unknown>): { ctx: AppContext; status: () => number; json: () => any } {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    get: (k: string) => (k === 'user'
      ? { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key-1', environmentId: undefined }
      : undefined),
    env: { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'x' },
    req: { json: async () => body, method: 'POST', path: '/v1/scores' },
    json: (b: unknown, s?: number) => {
      captured = { body: b, status: s ?? 200 };
      return new Response(JSON.stringify(b), { status: s ?? 200 });
    },
  } as unknown as AppContext;
  return { ctx, status: () => captured.status, json: () => captured.body };
}

describe('CreateScore (live POST /v1/scores)', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    vi.clearAllMocks();
  });

  it("defaults Source to 'api' when no source is provided", async () => {
    const { ctx, status } = ctxFor({ resource_id: 'trace-1', name: 'acc', score: 1 });
    await new CreateScore().handle(ctx);
    expect(status()).toBe(201);
    expect(insertedRows[0]!.Source).toBe('api');
  });

  it("rejects a legacy source='eval' at the schema boundary (400)", async () => {
    const { ctx, status } = ctxFor({ resource_id: 'trace-1', name: 'acc', score: 1, source: 'eval' });
    const res = await new CreateScore().handle(ctx);
    expect(res.status).toBe(400);
    expect(status()).toBe(400);
    expect(insertedRows).toHaveLength(0);
  });

  it('stores experiment/annotation/api sources', async () => {
    for (const source of ['experiment', 'annotation', 'api']) {
      insertedRows.length = 0;
      const { ctx } = ctxFor({ resource_id: `t-${source}`, name: 'acc', score: 1, source });
      await new CreateScore().handle(ctx);
      expect(insertedRows[0]!.Source).toBe(source);
    }
  });

  it('stores a numeric score VERBATIM and issues NO config query', async () => {
    // Any score value is accepted verbatim, regardless of range — shape-only,
    // no server-side range enforcement.
    const { ctx, status } = ctxFor({ resource_id: 'trace-1', name: 'quality', score: 5, dataType: 'numeric' });
    await new CreateScore().handle(ctx);
    expect(status()).toBe(201);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]!.Score).toBe(5);
    expect(insertedRows[0]!.DataType).toBe('numeric');
    expect(getScopedSupabase).not.toHaveBeenCalled();
  });

  it('stores a categorical label+score VERBATIM (no config remap to a category value)', async () => {
    // Shape-only storage keeps the submitted score (0), the submitted label,
    // and an empty dataType when none was sent — no server-side remap of the
    // label to a canonical value.
    const { ctx, status } = ctxFor({ resource_id: 'trace-1', name: 'sentiment', score: 0, label: 'good' });
    await new CreateScore().handle(ctx);
    expect(status()).toBe(201);
    expect(insertedRows[0]!.Score).toBe(0);
    expect(insertedRows[0]!.Label).toBe('good');
    expect(insertedRows[0]!.DataType).toBe('');
    expect(getScopedSupabase).not.toHaveBeenCalled();
  });

  it('rejects an invalid legacy dataType at the allowlist (400)', async () => {
    const { ctx, status } = ctxFor({ resource_id: 'trace-1', name: 'acc', score: 1, dataType: 'weird' });
    await new CreateScore().handle(ctx);
    expect(status()).toBe(400);
    expect(insertedRows).toHaveLength(0);
  });

  it('stores an empty label as "" when none is provided', async () => {
    const { ctx, status } = ctxFor({ resource_id: 'trace-1', name: 'acc', score: 42 });
    await new CreateScore().handle(ctx);
    expect(status()).toBe(201);
    expect(insertedRows[0]!.Score).toBe(42);
    expect(insertedRows[0]!.Label).toBe('');
  });
});

describe('CreateScoresBatch (live POST /v1/scores/batch)', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    vi.clearAllMocks();
  });

  function batchCtx(scores: Array<Record<string, unknown>>) {
    let captured: { body: any; status: number } = { body: undefined, status: 200 };
    const ctx = {
      get: (k: string) => (k === 'user'
        ? { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key-1', environmentId: undefined }
        : undefined),
      env: { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'x' },
      req: { json: async () => ({ scores }), method: 'POST', path: '/v1/scores/batch' },
      json: (b: unknown, s?: number) => {
        captured = { body: b, status: s ?? 200 };
        return new Response(JSON.stringify(b), { status: s ?? 200 });
      },
    } as unknown as AppContext;
    return { ctx, status: () => captured.status, body: () => captured.body };
  }

  it("defaults each item's Source to 'api' and inserts every valid row", async () => {
    const { ctx, status } = batchCtx([
      { resource_id: 't-1', name: 'a', score: 0.9 },
      { resource_id: 't-2', name: 'b', score: 0.8, source: 'experiment' },
    ]);
    await new CreateScoresBatch().handle(ctx);
    expect(status()).toBe(201);
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]!.Source).toBe('api');
    expect(insertedRows[1]!.Source).toBe('experiment');
  });

  it('stores every item VERBATIM and issues NO config query', async () => {
    // An out-of-range numeric and a categorical label both land unchanged;
    // the batch never reads a config row.
    const { ctx, status, body } = batchCtx([
      { resource_id: 't-1', name: 'quality', score: 9, dataType: 'numeric', client_id: 'row-1' },
      { resource_id: 't-2', name: 'sentiment', score: 0, label: 'good' },
    ]);
    await new CreateScoresBatch().handle(ctx);

    expect(status()).toBe(201);
    const results = body().data.results;
    expect(results[0].status).toBe('success');
    expect(results[0].client_id).toBe('row-1');
    expect(results[1].status).toBe('success');
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]!.Score).toBe(9);
    expect(insertedRows[0]!.DataType).toBe('numeric');
    expect(insertedRows[1]!.Score).toBe(0);
    expect(insertedRows[1]!.Label).toBe('good');
    expect(insertedRows[1]!.DataType).toBe('');
    expect(getScopedSupabase).not.toHaveBeenCalled();
  });

  it('reports a per-item error for a missing resource_id but inserts the valid sibling', async () => {
    const { ctx, status, body } = batchCtx([
      { name: 'a', score: 1, client_id: 'bad' },
      { resource_id: 't-2', name: 'b', score: 1 },
    ]);
    await new CreateScoresBatch().handle(ctx);
    expect(status()).toBe(207);
    const results = body().data.results;
    expect(results[0].status).toBe('error');
    expect(results[0].error.code).toBe('missing_required_field');
    expect(results[1].status).toBe('success');
    expect(insertedRows).toHaveLength(1);
  });
});
