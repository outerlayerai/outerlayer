/**
 * Unit tests for the eval-run worker endpoints (openapi/routes/eval-runs.ts):
 * GET /v1/evals/runs/:runId/job, POST /v1/evals/runs/:runId/status,
 * POST /v1/evals/escalations — the least-privilege worker control plane.
 *
 * Drives the handlers directly with a mocked context; the system Supabase
 * client is a scriptable table fake that records writes (the agents-sync
 * pattern: mock the module seam, not HTTP).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Scriptable system-client fake
// ---------------------------------------------------------------------------

const RUN_ID = 'd4f7a2b1-9c3e-4f5a-8b6d-1e2f3a4b5c6d';

interface FakeState {
  apiKeyRow: { id: string; name: string } | null;
  evalRunRow: Record<string, unknown> | null;
  updates: Array<{ table: string; patch: Record<string, unknown>; eq: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  deletes: Array<{ table: string; eq: Record<string, unknown> }>;
  updateError: { message: string } | null;
  insertError: { message: string } | null;
}

const state: FakeState = {
  apiKeyRow: null,
  evalRunRow: null,
  updates: [],
  inserts: [],
  deletes: [],
  updateError: null,
  insertError: null,
};

function fakeSupabase() {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return chain;
        },
        single: async () => {
          if (table === 'api_key') return { data: state.apiKeyRow, error: null };
          if (table === 'eval_run') return { data: state.evalRunRow, error: null };
          return { data: null, error: null };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (col: string, val: unknown) => {
            state.updates.push({ table, patch, eq: { [col]: val } });
            return { error: state.updateError };
          },
        }),
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { error: state.insertError };
        },
        delete: () => ({
          eq: async (col: string, val: unknown) => {
            state.deletes.push({ table, eq: { [col]: val } });
            return { error: null };
          },
        }),
      };
      return chain;
    },
  };
}

vi.mock('../../lib/system-client', () => ({
  asServiceClient: (client: unknown) => client,
  createSystemAdminClient: vi.fn(() => fakeSupabase()),
}));

import type { AppContext } from '../routes/_shared';
import {
  GetEvalRunJob,
  ReportEvalRunStatus,
  CreateEvalEscalation,
  evalRunKeyName,
} from '../routes/eval-runs';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function runRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    tenant_id: 'tenant-1',
    app_id: 'app-1',
    environment_id: 'env-1',
    status: 'queued',
    repo_label: 'acme/calc',
    request: { taskCount: 5, trialsPerTask: 3, configs: [] },
    ...over,
  };
}

type UserOver = Partial<{ apiKeyId: string | undefined }>;

function ctxFor(
  body: Record<string, unknown> | null,
  params: Record<string, string>,
  userOver: UserOver = {},
): { ctx: AppContext; status: () => number; json: () => any } {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const user = { appId: 'app-1', tenantId: 'tenant-1', apiKeyId: 'key_abc', environmentId: 'env-1', ...userOver };
  const ctx = {
    get: (k: string) => (k === 'user' ? user : undefined),
    env: {},
    req: {
      json: async () => body,
      param: () => params,
      method: 'POST',
      path: '/v1/evals/runs',
    },
    json: (b: unknown, s?: number | { status?: number }) => {
      const status = typeof s === 'number' ? s : (s?.status ?? 200);
      captured = { body: b, status };
      return new Response(JSON.stringify(b), { status });
    },
  } as unknown as AppContext;
  return { ctx, status: () => captured.status, json: () => captured.body };
}

beforeEach(() => {
  state.apiKeyRow = { id: 'key-row-9', name: evalRunKeyName(RUN_ID) };
  state.evalRunRow = runRow();
  state.updates = [];
  state.inserts = [];
  state.deletes = [];
  state.updateError = null;
  state.insertError = null;
});

// ---------------------------------------------------------------------------
// GET /v1/evals/runs/:runId/job
// ---------------------------------------------------------------------------

describe('GetEvalRunJob', () => {
  it('returns the job spec for the run the key is bound to', async () => {
    const { ctx, status, json } = ctxFor(null, { runId: RUN_ID });
    await new GetEvalRunJob({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect((json() as { data: unknown }).data).toEqual({
      id: RUN_ID,
      appId: 'app-1',
      environmentId: 'env-1',
      repoLabel: 'acme/calc',
      status: 'queued',
      request: { taskCount: 5, trialsPerTask: 3, configs: [] },
    });
  });

  it('404s (no oracle) when the key name is not bound to this run', async () => {
    state.apiKeyRow = { id: 'key-row-9', name: 'eval-run:another-run' };
    const { ctx, status, json } = ctxFor(null, { runId: RUN_ID });
    await new GetEvalRunJob({} as never).handle(ctx);
    expect(status()).toBe(404);
    expect((json() as { error: { code: string } }).error.code).toBe('eval_run_not_found');
  });

  it('404s for a bearer session (no api key binding)', async () => {
    const { ctx, status } = ctxFor(null, { runId: RUN_ID }, { apiKeyId: undefined });
    await new GetEvalRunJob({} as never).handle(ctx);
    expect(status()).toBe(404);
  });

  it('404s when the run is not in the key tenant/app', async () => {
    state.evalRunRow = null; // the tenant/app-scoped read found nothing
    const { ctx, status } = ctxFor(null, { runId: RUN_ID });
    await new GetEvalRunJob({} as never).handle(ctx);
    expect(status()).toBe(404);
  });

  it('400s on a non-uuid runId', async () => {
    const { ctx, status } = ctxFor(null, { runId: 'nope' });
    await new GetEvalRunJob({} as never).handle(ctx);
    expect(status()).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/evals/runs/:runId/status
// ---------------------------------------------------------------------------

describe('ReportEvalRunStatus', () => {
  it('claims a queued run (running) without touching the key', async () => {
    const { ctx, status, json } = ctxFor({ status: 'running' }, { runId: RUN_ID });
    await new ReportEvalRunStatus({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect((json() as { data: unknown }).data).toEqual({ id: RUN_ID, status: 'running' });
    expect(state.updates).toEqual([
      {
        table: 'eval_run',
        patch: { status: 'running', updated_at: expect.any(String) },
        eq: { id: RUN_ID },
      },
    ]);
    expect(state.deletes).toEqual([]);
  });

  it('running -> running is idempotent (Fly restart retry)', async () => {
    state.evalRunRow = runRow({ status: 'running' });
    const { ctx, status } = ctxFor({ status: 'running' }, { runId: RUN_ID });
    await new ReportEvalRunStatus({} as never).handle(ctx);
    expect(status()).toBe(200);
  });

  it('completes a run with the card AND revokes the key', async () => {
    state.evalRunRow = runRow({ status: 'running' });
    const { ctx, status } = ctxFor(
      { status: 'succeeded', card: { verdict: 'clear' }, costUsd: 0.42 },
      { runId: RUN_ID },
    );
    await new ReportEvalRunStatus({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(state.updates).toEqual([
      {
        table: 'eval_run',
        patch: {
          status: 'succeeded',
          card: { verdict: 'clear' },
          cost_usd: 0.42,
          updated_at: expect.any(String),
        },
        eq: { id: RUN_ID },
      },
    ]);
    // The credential dies with the run.
    expect(state.deletes).toEqual([{ table: 'api_key', eq: { id: 'key-row-9' } }]);
  });

  it('fails a run with the error AND revokes the key', async () => {
    state.evalRunRow = runRow({ status: 'running' });
    const { ctx, status } = ctxFor({ status: 'failed', error: 'E2B down' }, { runId: RUN_ID });
    await new ReportEvalRunStatus({} as never).handle(ctx);
    expect(status()).toBe(200);
    expect(state.updates[0]!.patch).toEqual({
      status: 'failed',
      error: 'E2B down',
      updated_at: expect.any(String),
    });
    expect(state.deletes).toEqual([{ table: 'api_key', eq: { id: 'key-row-9' } }]);
  });

  it('409s on a transition out of a terminal status (zombie machine)', async () => {
    state.evalRunRow = runRow({ status: 'succeeded' });
    const { ctx, status, json } = ctxFor({ status: 'failed', error: 'late crash' }, { runId: RUN_ID });
    await new ReportEvalRunStatus({} as never).handle(ctx);
    expect(status()).toBe(409);
    expect((json() as { error: { code: string } }).error.code).toBe('eval_run_conflict');
    expect(state.updates).toEqual([]);
    expect(state.deletes).toEqual([]);
  });

  it('400s succeeded-without-card and failed-without-error', async () => {
    const a = ctxFor({ status: 'succeeded' }, { runId: RUN_ID });
    await new ReportEvalRunStatus({} as never).handle(a.ctx);
    expect(a.status()).toBe(400);

    const b = ctxFor({ status: 'failed' }, { runId: RUN_ID });
    await new ReportEvalRunStatus({} as never).handle(b.ctx);
    expect(b.status()).toBe(400);
  });

  it('500s (and does not revoke) when the status write fails', async () => {
    state.evalRunRow = runRow({ status: 'running' });
    state.updateError = { message: 'db down' };
    const { ctx, status } = ctxFor(
      { status: 'succeeded', card: { verdict: 'clear' } },
      { runId: RUN_ID },
    );
    await new ReportEvalRunStatus({} as never).handle(ctx);
    expect(status()).toBe(500);
    expect(state.deletes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/evals/escalations
// ---------------------------------------------------------------------------

const ESCALATION = {
  repo: 'github.com/acme/calc',
  base_commit: 'abc123',
  task_ids: ['fix-divide'],
  last_errors: [{ stage: 'setup', excerpt: 'pip failed' }],
  attempts: 3,
  cost_usd: 0.9,
  suggested_next_steps: 'pin python 3.12',
};

describe('CreateEvalEscalation', () => {
  it('stamps tenant/app/eval_run_id from the key binding, never the body', async () => {
    const { ctx, status } = ctxFor(
      { ...ESCALATION, tenant_id: 'attacker-tenant', eval_run_id: 'attacker-run' },
      {},
    );
    await new CreateEvalEscalation({} as never).handle(ctx);
    expect(status()).toBe(201);
    expect(state.inserts).toEqual([
      {
        table: 'env_escalation',
        row: {
          ...ESCALATION,
          tenant_id: 'tenant-1',
          app_id: 'app-1',
          eval_run_id: RUN_ID,
        },
      },
    ]);
  });

  it('404s for a key that is not an eval-run key', async () => {
    state.apiKeyRow = { id: 'k', name: 'CLI Dev Key' };
    const { ctx, status } = ctxFor({ ...ESCALATION }, {});
    await new CreateEvalEscalation({} as never).handle(ctx);
    expect(status()).toBe(404);
    expect(state.inserts).toEqual([]);
  });

  it('400s a malformed body', async () => {
    const { ctx, status } = ctxFor({ repo: '' }, {});
    await new CreateEvalEscalation({} as never).handle(ctx);
    expect(status()).toBe(400);
  });
});
