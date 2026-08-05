/**
 * Unit tests for POST /v1/evals/trials (openapi/routes/eval-trials.ts,
 * IngestEvalTrials) — trial-results persistence.
 *
 * Drives the handler directly with a mocked context (the agents-sync.test.ts
 * pattern): ClickHouse inserts are captured per table, blob storage is an
 * in-memory map, and the API-key env resolution is mocked at its module seam.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// Capture ClickHouse inserts per table; toggle failure per test.
const insertsByTable: Record<string, Array<Record<string, unknown>>> = {};
let clickhouseInsertError: Error | null = null;
vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    insert: vi.fn(async (params: { table: string; values: Array<Record<string, unknown>> }) => {
      if (clickhouseInsertError) throw clickhouseInsertError;
      (insertsByTable[params.table] ??= []).push(...params.values);
    }),
    query: vi.fn(async () => ({ json: async () => [] })),
    close: vi.fn(async () => {}),
  })),
}));

vi.mock('../../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: vi.fn(() => ({})),
}));

// API-key-bound env — mutated per test.
let apiKeyEnv: { name: string; pinned_version: number | null; pinned_commit_sha: string | null } | null = {
  name: 'production',
  pinned_version: 3,
  pinned_commit_sha: 'abc123',
};
let apiKeyEnvError: Error | null = null;
const resolveEnvironmentFromApiKey = vi.fn(async () => {
  if (apiKeyEnvError) throw apiKeyEnvError;
  return apiKeyEnv;
});
vi.mock('../../lib/environment-resolver', () => ({
  resolveEnvironmentFromApiKey: (...args: unknown[]) =>
    resolveEnvironmentFromApiKey(...(args as [])),
}));

// In-memory blob storage.
const blobStore = new Map<string, { bytes: Uint8Array; contentType: string }>();
let blobStorageAvailable = true;
vi.mock('../../lib/blob-storage', () => ({
  createBlobStorage: vi.fn(() => {
    if (!blobStorageAvailable) throw new Error('no R2 binding');
    return {
      put: async (key: string, bytes: Uint8Array, contentType: string) => {
        blobStore.set(key, { bytes, contentType });
      },
      get: async (key: string) => blobStore.get(key)?.bytes ?? null,
    };
  }),
}));

import type { AppContext } from '../routes/_shared';
import {
  IngestEvalTrials,
  deterministicScoreId,
  evalTrialBlobKey,
  MAX_TRIAL_BYTES,
} from '../routes/eval-trials';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RUN_ID = 'd4f7a2b1-9c3e-4f5a-8b6d-1e2f3a4b5c6d';

function trialResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: 'fix-divide',
    configId: 'opus',
    trialIndex: 0,
    status: 'graded',
    resolved: true,
    failToPass: [{ id: 'tests/test_divide.py::test_divide_edge', outcome: 'pass' }],
    passToPass: [],
    patch: '--- a/calc.py\n+++ b/calc.py\n@@ -1 +1,2 @@\n',
    patchApplyOk: true,
    trajectory: { launcher: 'claude-code', turns: 3, wallClockMs: 42000 },
    cost: { usd: 0.42, source: 'measured' },
    leak: { agentWorktreeClean: true },
    quarantinedSkipped: [],
    attempt: 1,
    timings: { agentMs: 40000, gradeMs: 15000, totalMs: 55000 },
    ...over,
  };
}

function trialItem(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, result: trialResult(over) };
}

function ctxFor(
  body: Record<string, unknown>,
): { ctx: AppContext; status: () => number; json: () => any } {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    get: (k: string) =>
      k === 'user'
        ? { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key_abc', environmentId: 'env-1' }
        : undefined,
    env: { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'x' },
    req: { json: async () => body, method: 'POST', path: '/v1/evals/trials' },
    json: (b: unknown, s?: number | { status?: number }) => {
      const status = typeof s === 'number' ? s : (s?.status ?? 200);
      captured = { body: b, status };
      return new Response(JSON.stringify(b), { status });
    },
  } as unknown as AppContext;
  return { ctx, status: () => captured.status, json: () => captured.body };
}

/** Independent recomputation of the converter's trace-id recipe — pins the
 * scores↔session join contract (sha256(sessionId) first 32 hex chars). */
function expectedTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

beforeEach(() => {
  for (const key of Object.keys(insertsByTable)) delete insertsByTable[key];
  blobStore.clear();
  blobStorageAvailable = true;
  clickhouseInsertError = null;
  apiKeyEnv = { name: 'production', pinned_version: 3, pinned_commit_sha: 'abc123' };
  apiKeyEnvError = null;
  resolveEnvironmentFromApiKey.mockClear();
});

// ---------------------------------------------------------------------------
// POST /v1/evals/trials
// ---------------------------------------------------------------------------

describe('IngestEvalTrials', () => {
  it('rejects a malformed envelope with 400 invalid_request_body', async () => {
    const { ctx, status, json } = ctxFor({ schemaVersion: 1, evalRunId: RUN_ID });
    await new IngestEvalTrials({} as never).handle(ctx);
    expect(status()).toBe(400);
    expect((json() as { error: { code: string } }).error.code).toBe('invalid_request_body');
  });

  it('rejects a non-uuid evalRunId with 400', async () => {
    const { ctx, status } = ctxFor({
      schemaVersion: 1,
      evalRunId: 'not-a-uuid',
      trials: [trialItem('eval:x:t:c:0')],
    });
    await new IngestEvalTrials({} as never).handle(ctx);
    expect(status()).toBe(400);
  });

  it('persists a trial as exactly three score rows joined to the session trace id, plus the artifact blob', async () => {
    const sessionId = `eval:${RUN_ID}:fix-divide:opus:t0`;
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [trialItem(sessionId, { error: 'flaky infra' })],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    expect(status()).toBe(200);
    expect((json() as { data: unknown }).data).toEqual({
      accepted: [sessionId],
      rejected: [],
      scoreRows: 3,
      blobsStored: 1,
    });

    const traceId = expectedTraceId(sessionId);
    const rows = insertsByTable['scores'] ?? [];
    const shared = {
      TenantId: 'tenant-1',
      AppId: 'app-1',
      ResourceId: traceId,
      Type: 'eval_trial',
      Source: 'eval-runner',
      UserId: '',
      Environment: 'production',
      EnvironmentVersion: 3,
      CommitSha: 'abc123',
      IsDeleted: 0,
      CreatedAt: expect.any(Number),
      UpdatedAt: expect.any(Number),
    };
    // Positional exact-shape match: catches drops, reorders, and field drift.
    expect(rows).toEqual([
      {
        ...shared,
        Id: deterministicScoreId(sessionId, 'eval.trial.resolved'),
        Name: 'eval.trial.resolved',
        Score: 1,
        DataType: 'boolean',
        Label: 'graded',
        Reason: 'flaky infra',
      },
      {
        ...shared,
        Id: deterministicScoreId(sessionId, 'eval.trial.cost_usd'),
        Name: 'eval.trial.cost_usd',
        Score: 0.42,
        DataType: 'numeric',
        Label: 'measured',
        Reason: '',
      },
      {
        ...shared,
        Id: deterministicScoreId(sessionId, 'eval.trial.duration_ms'),
        Name: 'eval.trial.duration_ms',
        Score: 55000,
        DataType: 'numeric',
        Label: 'graded',
        Reason: '',
      },
    ]);

    // Blob: exact key, verbatim result payload, JSON content type.
    const key = evalTrialBlobKey('tenant-1', 'app-1', RUN_ID, traceId);
    const blob = blobStore.get(key);
    expect(blob?.contentType).toBe('application/json');
    const parsed = JSON.parse(new TextDecoder().decode(blob!.bytes));
    expect(parsed).toEqual({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      sessionId,
      result: trialResult({ error: 'flaky infra' }),
    });
  });

  it('rejects a malformed trial alone without failing the batch', async () => {
    const goodId = `eval:${RUN_ID}:fix-head:opus:t1`;
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [
        { sessionId: 'eval:bad', result: { taskId: 'x' } }, // missing required fields
        trialItem(goodId),
      ],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    expect(status()).toBe(200);
    const data = (json() as { data: { accepted: string[]; rejected: Array<Record<string, unknown>>; scoreRows: number } }).data;
    expect(data.accepted).toEqual([goodId]);
    expect(data.scoreRows).toBe(3);
    expect(data.rejected).toEqual([
      { index: 0, sessionId: 'eval:bad', reason: expect.stringMatching(/^schema: /) },
    ]);
    expect((insertsByTable['scores'] ?? []).length).toBe(3);
  });

  it('rejects an oversize trial with a size reason and persists nothing for it', async () => {
    const sessionId = `eval:${RUN_ID}:fix-big:opus:t0`;
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [trialItem(sessionId, { patch: 'x'.repeat(MAX_TRIAL_BYTES) })],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    expect(status()).toBe(200);
    const data = (json() as { data: { accepted: string[]; rejected: Array<Record<string, unknown>> } }).data;
    expect(data.accepted).toEqual([]);
    expect(data.rejected).toEqual([
      { index: 0, sessionId, reason: `trial: serialized size exceeds ${MAX_TRIAL_BYTES} bytes` },
    ]);
    expect(insertsByTable['scores']).toBeUndefined();
    expect(blobStore.size).toBe(0);
  });

  it('still lands score rows when blob storage is unavailable', async () => {
    blobStorageAvailable = false;
    const sessionId = `eval:${RUN_ID}:fix-divide:opus:t0`;
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [trialItem(sessionId)],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    expect(status()).toBe(200);
    const data = (json() as { data: { accepted: string[]; blobsStored: number; scoreRows: number } }).data;
    expect(data.accepted).toEqual([sessionId]);
    expect(data.blobsStored).toBe(0);
    expect(data.scoreRows).toBe(3);
    expect((insertsByTable['scores'] ?? []).length).toBe(3);
  });

  it('stamps the empty env triple when key-env resolution fails, without blocking', async () => {
    apiKeyEnvError = new Error('supabase down');
    const sessionId = `eval:${RUN_ID}:fix-divide:opus:t0`;
    const { ctx, status } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [trialItem(sessionId)],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    expect(status()).toBe(200);
    const rows = insertsByTable['scores'] ?? [];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.Environment).toBe('');
      expect(row.EnvironmentVersion).toBe(0);
      expect(row.CommitSha).toBe('');
    }
  });

  it('does not stamp an unpinned env commit sha', async () => {
    apiKeyEnv = { name: 'dev', pinned_version: null, pinned_commit_sha: 'stale-sha' };
    const sessionId = `eval:${RUN_ID}:fix-divide:opus:t0`;
    const { ctx } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [trialItem(sessionId)],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    const rows = insertsByTable['scores'] ?? [];
    expect(rows[0]!.Environment).toBe('dev');
    expect(rows[0]!.EnvironmentVersion).toBe(0);
    // Unpinned envs never inherit a stale sha — same rule as the scores ingest.
    expect(rows[0]!.CommitSha).toBe('');
  });

  it('returns a mapped 500 when the ClickHouse insert fails', async () => {
    clickhouseInsertError = new Error('ECONNREFUSED');
    const { ctx, status, json } = ctxFor({
      schemaVersion: 1,
      evalRunId: RUN_ID,
      trials: [trialItem(`eval:${RUN_ID}:fix-divide:opus:t0`)],
    });
    await new IngestEvalTrials({} as never).handle(ctx);

    expect(status()).toBe(500);
    expect(json()).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe('deterministicScoreId', () => {
  it('is stable for the same (sessionId, name) and distinct across names and sessions', async () => {
    const a1 = deterministicScoreId('eval:r:t:c:0', 'eval.trial.resolved');
    const a2 = deterministicScoreId('eval:r:t:c:0', 'eval.trial.resolved');
    const b = deterministicScoreId('eval:r:t:c:0', 'eval.trial.cost_usd');
    const c = deterministicScoreId('eval:r:t:c:1', 'eval.trial.resolved');
    expect(a1).toBe(a2);
    expect(new Set([a1, b, c]).size).toBe(3);
  });

  it('is UUID-shaped so uuid-validating consumers keep working', async () => {
    expect(deterministicScoreId('eval:r:t:c:0', 'eval.trial.resolved')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('evalTrialBlobKey', () => {
  it('derives the key from tenant/app/run/trace so any score row addresses its blob', async () => {
    expect(evalTrialBlobKey('tenant-1', 'app-1', RUN_ID, 'deadbeef')).toBe(
      `evals/tenant-1/app-1/${RUN_ID}/deadbeef.json`,
    );
  });
});
