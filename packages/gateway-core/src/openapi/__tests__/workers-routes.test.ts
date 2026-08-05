/**
 * /v1/workers route handlers.
 *
 * The store + dispatch layer is the mocked seam (its own queries are plain
 * supabase calls exercised elsewhere); these tests pin the route contracts:
 * envelope shapes, the entitlement 402s with limit/current, the dispatch
 * failure taxonomy (run failed + 502, lock released, orphan env destroyed),
 * the busy 409 / destroyed 410, and that the dispatch service receives the
 * agent's credential keys.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorkerRun: vi.fn(),
  getWorkerRun: vi.fn(),
  listEnvironmentTurns: vi.fn(),
  countActiveRunsForTenant: vi.fn(),
  sumRunDurationMsSince: vi.fn(),
  markWorkerRunProvisioning: vi.fn(),
  failWorkerRun: vi.fn(),
  createWorkerEnvironment: vi.fn(),
  getWorkerEnvironment: vi.fn(),
  acquireEnvironmentTurn: vi.fn(),
  releaseEnvironmentTurn: vi.fn(),
  markEnvironmentMachine: vi.fn(),
  destroyWorkerEnvironmentRow: vi.fn(),
  workerDispatchConfigured: vi.fn(),
  dispatch: vi.fn(),
  resolveNumericLimit: vi.fn(),
}));

vi.mock('../../lib/workers', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../lib/workers');
  return {
    ...actual,
    createWorkerRun: mocks.createWorkerRun,
    getWorkerRun: mocks.getWorkerRun,
    listEnvironmentTurns: mocks.listEnvironmentTurns,
    countActiveRunsForTenant: mocks.countActiveRunsForTenant,
    sumRunDurationMsSince: mocks.sumRunDurationMsSince,
    markWorkerRunProvisioning: mocks.markWorkerRunProvisioning,
    failWorkerRun: mocks.failWorkerRun,
    createWorkerEnvironment: mocks.createWorkerEnvironment,
    getWorkerEnvironment: mocks.getWorkerEnvironment,
    acquireEnvironmentTurn: mocks.acquireEnvironmentTurn,
    releaseEnvironmentTurn: mocks.releaseEnvironmentTurn,
    markEnvironmentMachine: mocks.markEnvironmentMachine,
    destroyWorkerEnvironmentRow: mocks.destroyWorkerEnvironmentRow,
    workerDispatchConfigured: mocks.workerDispatchConfigured,
    GatewayWorkerDispatchService: vi.fn().mockImplementation(function () {
      return { dispatch: mocks.dispatch };
    }),
  };
});

vi.mock('../../lib/entitlements', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../lib/entitlements');
  return { ...actual, resolveNumericLimit: mocks.resolveNumericLimit };
});

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return { ...actual, getScopedSupabase: vi.fn(() => Promise.resolve({})) };
});

// Deep-link lookups ride the system client; a minimal chainable stub returns
// the org/app/env names so the URL shape is pinned in one place.
vi.mock('../../lib/system-client', () => ({
  createSystemAdminClient: vi.fn(() => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, _v: string) => ({
          maybeSingle: async () =>
            table === 'app'
              ? { data: { name: 'demo-app', tenant: { organization_name: 'acme' } } }
              : { data: { id: 'am-env-1', name: 'dev' } },
          eq: () => ({
            maybeSingle: async () => ({ data: { id: 'am-env-1', name: 'dev' } }),
          }),
        }),
      }),
    }),
  })),
  asServiceClient: (x: unknown) => x,
}));

import type { AppContext } from '../routes/_shared';
import {
  ContinueWorkerSession,
  CreateWorkerSession,
  GetWorkerRun,
  GetWorkerSession,
  LaunchWorkerRun,
} from '../routes/workers';

interface CapturedResponse {
  body: any;
  status: number;
}

function makeContext(over: { param?: Record<string, string>; body?: unknown } = {}) {
  let captured: CapturedResponse = { body: undefined, status: 200 };
  const ctx = {
    get: vi.fn((k: string) => {
      if (k === 'user')
        return { appId: 'app-1', tenantId: 'tenant-1', environmentId: 'am-env-1' };
      if (k === 'gtx')
        return { logger: { createLogger: () => ({ info: vi.fn(), error: vi.fn() }) } };
      return undefined;
    }),
    env: {
      CLOUD_WORKER_APP: 'workers-app',
      FLY_API_TOKEN: 'fly-t',
      DASHBOARD_BASE_URL: 'https://app.agentmark.co',
    },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: {
      method: 'POST',
      path: '/v1/workers/runs',
      param: () => over.param ?? {},
      json: async () => over.body ?? {},
    },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function makeRoute<T>(Cls: new (...args: any[]) => T, validatedData?: Record<string, unknown>): T {
  const instance = new Cls({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  });
  (instance as { getValidatedData?: unknown }).getValidatedData = vi
    .fn()
    .mockResolvedValue(validatedData ?? {});
  return instance;
}

const RUN = {
  id: 'run-1',
  app_id: 'app-1',
  tenant_id: 'tenant-1',
  environment_id: 'am-env-1',
  agent: 'claude-code',
  task_prompt: 'do it',
  base_branch: '',
  status: 'completed',
  outcome: 'changes',
  branch_name: 'outerlayer/worker/x',
  pr_url: 'https://github.com/o/r/pull/2',
  pr_number: 2,
  failure_code: null,
  error_message: null,
  duration_ms: 12_000,
  workspace_id: null,
  turn_index: 0,
  created_at: '2026-07-12T00:00:00Z',
};

const ENV = {
  id: 'env-1',
  app_id: 'app-1',
  tenant_id: 'tenant-1',
  environment_id: 'am-env-1',
  agent: 'claude-code',
  base_branch: '',
  work_branch: 'outerlayer/worker/env-1',
  substrate: 'fly',
  machine_ref: 'm-1',
  workspace_ref: '/data/workspace',
  session_ref: 'sess-1',
  status: 'active',
  current_run_id: null,
  last_active_at: null,
  created_at: '2026-07-12T00:00:00Z',
};

const RUN_URL = 'https://app.agentmark.co/orgs/acme/apps/demo-app/env/dev/workers?run=run-1';
const SESSION_URL = 'https://app.agentmark.co/orgs/acme/apps/demo-app/env/dev/workers?session=env-1';

// The continue handler validates the raw :envId path param as a UUID before
// touching the store, so its tests must send a syntactically valid one.
const ENV_ID_PARAM = '3e1f2a45-1111-4222-8333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workerDispatchConfigured.mockReturnValue(true);
  mocks.resolveNumericLimit.mockResolvedValue(-1);
  mocks.countActiveRunsForTenant.mockResolvedValue(0);
  mocks.sumRunDurationMsSince.mockResolvedValue(0);
  mocks.createWorkerRun.mockResolvedValue({ ...RUN, status: 'queued' });
  mocks.dispatch.mockResolvedValue({ machineId: 'm-9' });
  mocks.listEnvironmentTurns.mockResolvedValue([]);
  mocks.acquireEnvironmentTurn.mockResolvedValue(true);
});

describe('POST /v1/workers/runs', () => {
  it('dispatches with the agent credential keys and returns the enveloped deep link', async () => {
    const route = makeRoute(LaunchWorkerRun);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'do it' } });
    await (route as LaunchWorkerRun).handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect(body).toEqual({ data: { run_id: 'run-1', status: 'provisioning', url: RUN_URL } });
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workerRunId: 'run-1',
        appId: 'app-1',
        tenantId: 'tenant-1',
        environmentId: 'am-env-1',
        agent: 'claude-code',
        agentCredentialKeys: ['ANTHROPIC_API_KEY'],
        taskPrompt: 'do it',
      }),
    );
    expect(mocks.markWorkerRunProvisioning).toHaveBeenCalledWith({}, 'app-1', 'run-1', 'm-9');
  });

  it('400s an unknown agent without touching the store', async () => {
    const route = makeRoute(LaunchWorkerRun);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'x', agent: 'hal9000' } });
    await (route as LaunchWorkerRun).handle(ctx);
    expect(captured().status).toBe(400);
    expect(captured().body.error.code).toBe('unknown_worker_agent');
    expect(mocks.createWorkerRun).not.toHaveBeenCalled();
  });

  it('503s when worker compute is not configured', async () => {
    mocks.workerDispatchConfigured.mockReturnValue(false);
    const route = makeRoute(LaunchWorkerRun);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'x' } });
    await (route as LaunchWorkerRun).handle(ctx);
    expect(captured().status).toBe(503);
    expect(captured().body.error.code).toBe('worker_dispatch_unconfigured');
  });

  it('402s with limit/current when concurrency is exhausted', async () => {
    mocks.countActiveRunsForTenant.mockResolvedValue(3);
    mocks.resolveNumericLimit.mockImplementation(async (_env, _t, key: string) =>
      key === 'max_concurrent_worker_runs' ? 3 : -1,
    );
    const route = makeRoute(LaunchWorkerRun);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'x' } });
    await (route as LaunchWorkerRun).handle(ctx);
    expect(captured().status).toBe(402);
    expect(captured().body.error).toEqual({
      code: 'entitlement_required',
      message: 'Concurrent worker-run limit reached.',
      entitlement: 'max_concurrent_worker_runs',
      limit: 3,
      current: 3,
    });
    expect(mocks.createWorkerRun).not.toHaveBeenCalled();
  });

  it('402s on the monthly-minutes quota', async () => {
    mocks.sumRunDurationMsSince.mockResolvedValue(300 * 60_000);
    mocks.resolveNumericLimit.mockImplementation(async (_env, _t, key: string) =>
      key === 'max_worker_minutes_per_month' ? 300 : -1,
    );
    const route = makeRoute(LaunchWorkerRun);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'x' } });
    await (route as LaunchWorkerRun).handle(ctx);
    expect(captured().status).toBe(402);
    expect(captured().body.error.entitlement).toBe('max_worker_minutes_per_month');
  });

  it('fails the run and 502s when dispatch throws (preflight code preserved)', async () => {
    const { WorkerPreflightError } = await import('../../lib/workers');
    mocks.dispatch.mockRejectedValue(new WorkerPreflightError('no_git_connection', 'no repo'));
    const route = makeRoute(LaunchWorkerRun);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'x' } });
    await (route as LaunchWorkerRun).handle(ctx);
    expect(captured().status).toBe(502);
    expect(mocks.failWorkerRun).toHaveBeenCalledWith({}, 'app-1', 'run-1', 'no_git_connection', 'no repo');
  });
});

describe('GET /v1/workers/runs/:runId', () => {
  it('returns the enveloped run + deep link, exposing workspace_id under the published environment_ref key', async () => {
    // A session turn: workspace_id is set and distinct from environment_id, so
    // the assertion below pins the published contract key `environment_ref` to
    // the renamed DB column and would fail on either a null-out or a swap to
    // `environment_id`.
    mocks.getWorkerRun.mockResolvedValue({ ...RUN, workspace_id: 'ws-42' });
    const route = makeRoute(GetWorkerRun, { params: { runId: 'run-1' } });
    const { ctx, captured } = makeContext();
    await (route as GetWorkerRun).handle(ctx);
    const { body, status } = captured();
    expect(status).toBe(200);
    expect(body.data.run).toMatchObject({ id: 'run-1', status: 'completed', pr_number: 2 });
    expect(body.data.run.environment_ref).toEqual('ws-42');
    expect(body.data.url).toBe(RUN_URL);
  });

  it('404s an unknown run', async () => {
    mocks.getWorkerRun.mockResolvedValue(null);
    const route = makeRoute(GetWorkerRun, { params: { runId: 'ghost' } });
    const { ctx, captured } = makeContext();
    await (route as GetWorkerRun).handle(ctx);
    expect(captured().status).toBe(404);
    expect(captured().body.error.code).toBe('worker_run_not_found');
  });
});

describe('POST /v1/workers/environments', () => {
  it('creates the session, dispatches turn 0 persistent-first-turn, records the machine', async () => {
    mocks.createWorkerEnvironment.mockResolvedValue({ ...ENV, machine_ref: null, session_ref: null });
    const route = makeRoute(CreateWorkerSession);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'start' } });
    await (route as CreateWorkerSession).handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect(body).toEqual({
      data: { environment_id: 'env-1', run_id: 'run-1', status: 'active', url: SESSION_URL },
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: expect.objectContaining({
          firstTurn: true,
          workspacePath: '/data/workspace',
          agentHome: '/data/home',
        }),
        persistentMachine: { machineRef: null, envId: 'env-1' },
      }),
    );
    expect(mocks.markEnvironmentMachine).toHaveBeenCalledWith({}, 'env-1', 'm-9');
  });

  it('destroys the orphan environment and 502s when the first turn fails', async () => {
    mocks.createWorkerEnvironment.mockResolvedValue({ ...ENV, machine_ref: null });
    mocks.dispatch.mockRejectedValue(new Error('fly down'));
    const route = makeRoute(CreateWorkerSession);
    const { ctx, captured } = makeContext({ body: { task_prompt: 'start' } });
    await (route as CreateWorkerSession).handle(ctx);
    expect(captured().status).toBe(502);
    expect(mocks.destroyWorkerEnvironmentRow).toHaveBeenCalledWith(
      {},
      'env-1',
      'First turn failed to dispatch.',
    );
    // The failed turn released the single-turn lock before the env teardown.
    expect(mocks.releaseEnvironmentTurn).toHaveBeenCalledWith({}, 'env-1', 'run-1');
  });
});

describe('POST /v1/workers/environments/:envId/turns', () => {
  it('continues with the resumed session and an incremented turn index', async () => {
    mocks.getWorkerEnvironment.mockResolvedValue(ENV);
    mocks.listEnvironmentTurns.mockResolvedValue([{ id: 't0' }]);
    mocks.createWorkerRun.mockResolvedValue({ ...RUN, id: 'run-2' });
    const route = makeRoute(ContinueWorkerSession);
    const { ctx, captured } = makeContext({
      param: { envId: ENV_ID_PARAM },
      body: { task_prompt: 'again' },
    });
    await (route as ContinueWorkerSession).handle(ctx);

    const { body, status } = captured();
    expect(status).toBe(200);
    expect(body).toEqual({ data: { run_id: 'run-2', turn_index: 1, url: SESSION_URL } });
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: expect.objectContaining({ firstTurn: false, sessionRef: 'sess-1' }),
        persistentMachine: { machineRef: 'm-1', envId: 'env-1' },
      }),
    );
  });

  it('409s environment_busy when the lock is held, failing the created run', async () => {
    mocks.getWorkerEnvironment.mockResolvedValue(ENV);
    mocks.acquireEnvironmentTurn.mockResolvedValue(false);
    const route = makeRoute(ContinueWorkerSession);
    const { ctx, captured } = makeContext({
      param: { envId: ENV_ID_PARAM },
      body: { task_prompt: 'again' },
    });
    await (route as ContinueWorkerSession).handle(ctx);
    expect(captured().status).toBe(409);
    expect(captured().body.error.code).toBe('worker_environment_busy');
    expect(mocks.failWorkerRun).toHaveBeenCalledWith(
      {},
      'app-1',
      'run-1',
      'environment_busy',
      'Environment was busy with another turn.',
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('404s unknown and 410s destroyed sessions', async () => {
    mocks.getWorkerEnvironment.mockResolvedValue(null);
    let route = makeRoute(ContinueWorkerSession);
    let { ctx, captured } = makeContext({
      param: { envId: ENV_ID_PARAM },
      body: { task_prompt: 'x' },
    });
    await (route as ContinueWorkerSession).handle(ctx);
    expect(captured().status).toBe(404);

    mocks.getWorkerEnvironment.mockResolvedValue({ ...ENV, status: 'destroyed' });
    route = makeRoute(ContinueWorkerSession);
    ({ ctx, captured } = makeContext({ param: { envId: ENV_ID_PARAM }, body: { task_prompt: 'x' } }));
    await (route as ContinueWorkerSession).handle(ctx);
    expect(captured().status).toBe(410);
    expect(captured().body.error.code).toBe('worker_session_destroyed');
  });

  it('400s a non-UUID envId before touching the store', async () => {
    const route = makeRoute(ContinueWorkerSession);
    const { ctx, captured } = makeContext({ param: { envId: '0' }, body: { task_prompt: 'x' } });
    await (route as ContinueWorkerSession).handle(ctx);
    expect(captured().status).toBe(400);
    expect(captured().body.error.code).toBe('invalid_request_body');
    expect(mocks.getWorkerEnvironment).not.toHaveBeenCalled();
  });

  it('402s with limit/current when the concurrency quota is exhausted', async () => {
    mocks.getWorkerEnvironment.mockResolvedValue(ENV);
    mocks.countActiveRunsForTenant.mockResolvedValue(3);
    mocks.resolveNumericLimit.mockImplementation(async (_e, _t, key: string) =>
      key === 'max_concurrent_worker_runs' ? 3 : -1,
    );
    const route = makeRoute(ContinueWorkerSession);
    const { ctx, captured } = makeContext({
      param: { envId: ENV_ID_PARAM },
      body: { task_prompt: 'again' },
    });
    await (route as ContinueWorkerSession).handle(ctx);
    expect(captured().status).toBe(402);
    expect(captured().body.error).toMatchObject({
      code: 'entitlement_required',
      entitlement: 'max_concurrent_worker_runs',
      limit: 3,
      current: 3,
    });
    expect(mocks.createWorkerRun).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe('GET /v1/workers/environments/:envId', () => {
  it('returns the enveloped session, ordered turns, and deep link', async () => {
    mocks.getWorkerEnvironment.mockResolvedValue(ENV);
    mocks.listEnvironmentTurns.mockResolvedValue([
      { ...RUN, id: 't0', turn_index: 0, workspace_id: 'env-1' },
      { ...RUN, id: 't1', turn_index: 1, workspace_id: 'env-1' },
    ]);
    const route = makeRoute(GetWorkerSession, { params: { envId: 'env-1' } });
    const { ctx, captured } = makeContext();
    await (route as GetWorkerSession).handle(ctx);
    const { body, status } = captured();
    expect(status).toBe(200);
    expect(body.data.environment).toMatchObject({ id: 'env-1', status: 'active' });
    expect(body.data.turns.map((t: { id: string }) => t.id)).toEqual(['t0', 't1']);
    expect(body.data.url).toBe(SESSION_URL);
  });

  it('404s an unknown session', async () => {
    mocks.getWorkerEnvironment.mockResolvedValue(null);
    const route = makeRoute(GetWorkerSession, { params: { envId: 'ghost' } });
    const { ctx, captured } = makeContext();
    await (route as GetWorkerSession).handle(ctx);
    expect(captured().status).toBe(404);
    expect(captured().body.error.code).toBe('worker_session_not_found');
  });
});
