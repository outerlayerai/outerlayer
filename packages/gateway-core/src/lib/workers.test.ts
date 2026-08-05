/**
 * lib/workers — the store + dispatch layer behind /v1/workers.
 *
 * Store tests pin the query semantics the routes rely on: the single-turn
 * lock's guarded UPDATE (free + not-destroyed only), the guarded release,
 * the two-step environment init (fly volume path vs local tmpdir), and the
 * created_by NULL / status seeding on inserts.
 *
 * Dispatch tests mirror the GatewayManagedBuildService suite: what payload
 * lands at the (mocked) FlyWorkerAdapter, which preflight code each failure
 * throws, and that nothing sensitive is skipped — a missing agent credential
 * must fail BEFORE any Vault write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTriggerWorker, mockAdapterCtor, mockGetInstallationOctokit } =
  vi.hoisted(() => ({
    mockTriggerWorker: vi.fn(),
    mockAdapterCtor: vi.fn(),
    mockGetInstallationOctokit: vi.fn(),
  }));

vi.mock('@repo/worker-core', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@repo/worker-core');
  return {
    ...actual,
    FlyWorkerAdapter: vi.fn().mockImplementation(function (deps: unknown) {
      mockAdapterCtor(deps);
      return { triggerWorker: mockTriggerWorker };
    }),
  };
});

vi.mock('octokit', () => ({
  App: vi.fn().mockImplementation(function () {
    return { getInstallationOctokit: mockGetInstallationOctokit };
  }),
}));

import {
  GatewayWorkerDispatchService,
  WorkerDispatchUnavailableError,
  WorkerPreflightError,
  acquireEnvironmentTurn,
  countActiveEnvironmentsForTenant,
  createWorkerEnvironment,
  createWorkerRun,
  destroyWorkerEnvironmentRow,
  getWorkerEnvironment,
  markEnvironmentMachine,
  releaseEnvironmentTurn,
} from './workers';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Chainable Supabase stub: every method returns the chain, awaiting it yields
// the queued result, and every (method, args) call is recorded for assertions.
// ---------------------------------------------------------------------------

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data?: unknown; error?: { message: string } | null; count?: number | null }) {
  const calls: ChainCall[] = [];
  const target: Record<string, unknown> = {};
  const proxy: any = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) =>
          resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
      }
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return proxy;
      };
    },
  });
  return { chain: proxy, calls };
}

function makeDb(tables: Record<string, ReturnType<typeof makeChain>>) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  return {
    rpcCalls,
    db: {
      from: vi.fn((table: string) => {
        const entry = tables[table];
        if (!entry) throw new Error(`unexpected table ${table}`);
        return entry.chain;
      }),
      rpc: vi.fn(async (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        return { data: null, error: null };
      }),
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerWorker.mockResolvedValue({ dispatchId: 'd-1', machineId: 'm-1' });
});

// ===========================================================================
// Store
// ===========================================================================

describe('createWorkerRun', () => {
  it('inserts queued with created_by NULL (key-attributed) and the turn linkage', async () => {
    const runs = makeChain({ data: { id: 'run-1' } });
    const { db } = makeDb({ worker_run: runs });

    await createWorkerRun(db, {
      appId: 'app-1',
      tenantId: 'tenant-1',
      environmentId: 'am-env-1',
      agent: 'claude-code',
      taskPrompt: 'do it',
      baseBranch: 'main',
      dispatch: 'fly',
      wallClockCapS: 900,
      workspaceId: 'env-1',
      turnIndex: 2,
    });

    const insert = runs.calls.find((c) => c.method === 'insert')!;
    expect(insert.args[0]).toEqual({
      app_id: 'app-1',
      tenant_id: 'tenant-1',
      environment_id: 'am-env-1',
      created_by: null,
      agent: 'claude-code',
      task_prompt: 'do it',
      base_branch: 'main',
      dispatch: 'fly',
      wall_clock_cap_s: 900,
      workspace_id: 'env-1',
      turn_index: 2,
      status: 'queued',
    });
  });

  it('throws the exact error message on insert failure', async () => {
    const runs = makeChain({ error: { message: 'boom' } });
    const { db } = makeDb({ worker_run: runs });
    await expect(
      createWorkerRun(db, {
        appId: 'a',
        tenantId: 't',
        environmentId: null,
        agent: 'claude-code',
        taskPrompt: 'x',
        baseBranch: '',
        dispatch: 'fly',
        wallClockCapS: 900,
      }),
    ).rejects.toThrow('create worker_run failed: boom');
  });
});

describe('the single-turn lock', () => {
  it('acquire filters to free (current_run_id NULL) and not-destroyed rows', async () => {
    const envs = makeChain({ data: [{ id: 'env-1' }] });
    const { db } = makeDb({ worker_workspace: envs });

    const acquired = await acquireEnvironmentTurn(db, 'app-1', 'env-1', 'run-1');
    expect(acquired).toBe(true);

    const update = envs.calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toMatchObject({ current_run_id: 'run-1', status: 'active' });
    expect(envs.calls).toContainEqual({ method: 'is', args: ['current_run_id', null] });
    expect(envs.calls).toContainEqual({ method: 'neq', args: ['status', 'destroyed'] });
  });

  it('reports busy (false) when the guarded update matched no row', async () => {
    const envs = makeChain({ data: [] });
    const { db } = makeDb({ worker_workspace: envs });
    expect(await acquireEnvironmentTurn(db, 'app-1', 'env-1', 'run-1')).toBe(false);
  });

  it('release is guarded on still holding the lock', async () => {
    const envs = makeChain({ data: null });
    const { db } = makeDb({ worker_workspace: envs });
    await releaseEnvironmentTurn(db, 'env-1', 'run-1');

    const update = envs.calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toMatchObject({ current_run_id: null });
    expect(envs.calls).toContainEqual({ method: 'eq', args: ['id', 'env-1'] });
    expect(envs.calls).toContainEqual({ method: 'eq', args: ['current_run_id', 'run-1'] });
  });
});

describe('createWorkerEnvironment', () => {
  it('two-step init: placeholder insert, then the id-derived branch + fly volume workspace', async () => {
    const envs = makeChain({ data: { id: '12345678-aaaa-bbbb-cccc-dddddddddddd' } });
    const { db } = makeDb({ worker_workspace: envs });

    const env = await createWorkerEnvironment(db, {
      appId: 'app-1',
      tenantId: 'tenant-1',
      environmentId: 'am-env-1',
      agent: 'claude-code',
      baseBranch: '',
      substrate: 'fly',
    });

    expect(env.work_branch).toBe('outerlayer/worker/env-12345678');
    expect(env.workspace_ref).toBe('/data/workspace');
    const update = envs.calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toEqual({
      work_branch: 'outerlayer/worker/env-12345678',
      workspace_ref: '/data/workspace',
    });
  });

  it('local substrate derives a tmpdir workspace instead', async () => {
    const envs = makeChain({ data: { id: '87654321-aaaa-bbbb-cccc-dddddddddddd' } });
    const { db } = makeDb({ worker_workspace: envs });
    const env = await createWorkerEnvironment(db, {
      appId: 'app-1',
      tenantId: 'tenant-1',
      environmentId: null,
      agent: 'claude-code',
      baseBranch: '',
      substrate: 'local',
    });
    expect(env.workspace_ref).toBe('/tmp/outerlayer-worker-env/87654321-aaaa-bbbb-cccc-dddddddddddd');
  });
});

describe('destroyWorkerEnvironmentRow', () => {
  it('marks destroyed, clears the lock, and truncates the reason to 2000 chars', async () => {
    const envs = makeChain({ data: null });
    const { db } = makeDb({ worker_workspace: envs });
    await destroyWorkerEnvironmentRow(db, 'env-1', 'x'.repeat(3000));
    const update = envs.calls.find((c) => c.method === 'update')!;
    const patch = update.args[0] as { status: string; current_run_id: null; failure_reason: string };
    expect(patch.status).toBe('destroyed');
    expect(patch.current_run_id).toBeNull();
    expect(patch.failure_reason).toHaveLength(2000);
  });
});

// A worker_workspace db whose chain yields a different result per await, so the
// two-step createWorkerEnvironment (insert, then id-derived update) can fail on
// the SECOND step with the first succeeding.
function seqWorkspaceDb(results: Array<{ data?: unknown; error?: { message: string } | null }>) {
  let i = 0;
  const proxy: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const r = results[Math.min(i, results.length - 1)]!;
          i += 1;
          return (resolve: (v: unknown) => void) =>
            resolve({ data: r.data ?? null, error: r.error ?? null, count: null });
        }
        return () => proxy;
      },
    },
  );
  return { from: vi.fn(() => proxy), rpc: vi.fn() } as never;
}

const LOCAL_ENV_INPUT = {
  appId: 'app-1',
  tenantId: 'tenant-1',
  environmentId: null,
  agent: 'claude-code',
  baseBranch: '',
  substrate: 'local' as const,
};

describe('worker_workspace store error paths', () => {
  it('createWorkerEnvironment throws on the placeholder insert failure', async () => {
    const envs = makeChain({ error: { message: 'insb' } });
    const { db } = makeDb({ worker_workspace: envs });
    await expect(createWorkerEnvironment(db, LOCAL_ENV_INPUT)).rejects.toThrow(
      'create worker_workspace failed: insb',
    );
  });

  it('createWorkerEnvironment throws on the id-derived init update failure', async () => {
    const db = seqWorkspaceDb([
      { data: { id: 'abcdef12-aaaa-bbbb-cccc-dddddddddddd' } },
      { error: { message: 'updb' } },
    ]);
    await expect(createWorkerEnvironment(db, LOCAL_ENV_INPUT)).rejects.toThrow(
      'init worker_workspace failed: updb',
    );
  });

  it('getWorkerEnvironment returns the first row, null on empty, and throws on error', async () => {
    const found = makeChain({ data: [{ id: 'env-1', app_id: 'app-1' }] });
    expect((await getWorkerEnvironment(makeDb({ worker_workspace: found }).db, 'app-1', 'env-1'))?.id).toBe(
      'env-1',
    );

    const none = makeChain({ data: [] });
    expect(await getWorkerEnvironment(makeDb({ worker_workspace: none }).db, 'app-1', 'env-1')).toBeNull();

    const err = makeChain({ error: { message: 'getb' } });
    await expect(
      getWorkerEnvironment(makeDb({ worker_workspace: err }).db, 'app-1', 'env-1'),
    ).rejects.toThrow('get worker_workspace failed: getb');
  });

  it('countActiveEnvironmentsForTenant returns the count (0 when null) and throws on error', async () => {
    const three = makeChain({ count: 3 });
    expect(await countActiveEnvironmentsForTenant(makeDb({ worker_workspace: three }).db, 'tenant-1')).toBe(3);

    const zero = makeChain({ count: null });
    expect(await countActiveEnvironmentsForTenant(makeDb({ worker_workspace: zero }).db, 'tenant-1')).toBe(0);

    const err = makeChain({ error: { message: 'cntb' } });
    await expect(
      countActiveEnvironmentsForTenant(makeDb({ worker_workspace: err }).db, 'tenant-1'),
    ).rejects.toThrow('count worker_workspace failed: cntb');
  });

  it('acquireEnvironmentTurn throws on error', async () => {
    const err = makeChain({ error: { message: 'acqb' } });
    await expect(
      acquireEnvironmentTurn(makeDb({ worker_workspace: err }).db, 'app-1', 'env-1', 'run-1'),
    ).rejects.toThrow('acquire worker_workspace failed: acqb');
  });

  it('releaseEnvironmentTurn throws on error', async () => {
    const err = makeChain({ error: { message: 'relb' } });
    await expect(
      releaseEnvironmentTurn(makeDb({ worker_workspace: err }).db, 'env-1', 'run-1'),
    ).rejects.toThrow('release worker_workspace failed: relb');
  });

  it('markEnvironmentMachine writes machine_ref scoped to the id, and throws on error', async () => {
    const ok = makeChain({ data: null });
    await markEnvironmentMachine(makeDb({ worker_workspace: ok }).db, 'env-1', 'm-1');
    const update = ok.calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toMatchObject({ machine_ref: 'm-1' });
    expect(ok.calls).toContainEqual({ method: 'eq', args: ['id', 'env-1'] });

    const err = makeChain({ error: { message: 'mrkb' } });
    await expect(
      markEnvironmentMachine(makeDb({ worker_workspace: err }).db, 'env-1', null),
    ).rejects.toThrow('mark worker_workspace machine failed: mrkb');
  });

  it('destroyWorkerEnvironmentRow throws on error', async () => {
    const err = makeChain({ error: { message: 'dstb' } });
    await expect(
      destroyWorkerEnvironmentRow(makeDb({ worker_workspace: err }).db, 'env-1', 'reason'),
    ).rejects.toThrow('destroy worker_workspace failed: dstb');
  });
});

// ===========================================================================
// Dispatch service
// ===========================================================================

const ENV = {
  CLOUD_WORKER_APP: 'workers-app',
  CLOUD_WORKER_IMAGE: 'registry.fly.io/workers-app:v1',
  CLOUD_WORKER_REGION: 'iad',
  FLY_API_TOKEN: 'fly-t',
  DASHBOARD_BASE_URL: 'https://app.agentmark.co',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'pem',
} as unknown as Env;

function dispatchDb(opts: {
  connection?: { provider: string; repository: string; installation_id: number | null } | null;
  branch?: string | null;
  envVarRows?: Array<{ key: string; target_kind: string | null; environment_id: string | null }>;
  secrets?: Record<string, string>;
  insertSecretError?: { message: string };
}) {
  const rpcCalls: Array<{ name: string; args: { secret_name?: string; name?: string; secret?: string } }> = [];
  const db = {
    from: vi.fn((table: string) => {
      if (table === 'git_connection') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.connection ?? null }) }) }),
        };
      }
      if (table === 'git_branch') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.branch ? { branch_name: opts.branch } : null }),
            }),
          }),
        };
      }
      if (table === 'environment') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { current_version: 1, is_ephemeral: false } }),
              }),
            }),
          }),
        };
      }
      if (table === 'env_var') {
        return {
          select: () => ({
            eq: () => ({
              or: async () => ({ data: opts.envVarRows ?? [], error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc: vi.fn(async (name: string, args: { secret_name?: string; name?: string; secret?: string }) => {
      rpcCalls.push({ name, args });
      if (name === 'read_secret') {
        return { data: opts.secrets?.[args.secret_name ?? ''] ?? null, error: null };
      }
      if (name === 'insert_secret') {
        return { data: null, error: opts.insertSecretError ?? null };
      }
      return { data: null, error: null };
    }),
  };
  return { db: db as never, rpcCalls };
}

const noopLogger = { info: vi.fn(), error: vi.fn() };

function makeService(db: never) {
  return new GatewayWorkerDispatchService({ systemSupabase: db, env: ENV, logger: noopLogger });
}

const BASE_INPUT = {
  workerRunId: 'run-1',
  appId: 'app-1',
  tenantId: 'tenant-1',
  environmentId: 'am-env-1',
  agent: 'claude-code',
  agentCredentialKeys: ['ANTHROPIC_API_KEY'],
  taskPrompt: 'do it',
  baseBranch: '',
  wallClockCapS: 900,
};

describe('GatewayWorkerDispatchService', () => {
  it('throws unavailable when worker compute is unconfigured', async () => {
    const { db } = dispatchDb({});
    const service = new GatewayWorkerDispatchService({
      systemSupabase: db,
      env: { ...ENV, CLOUD_WORKER_APP: undefined } as unknown as Env,
      logger: noopLogger,
    });
    await expect(service.dispatch(BASE_INPUT)).rejects.toBeInstanceOf(WorkerDispatchUnavailableError);
  });

  it('fails preflight no_git_connection before anything else', async () => {
    const { db, rpcCalls } = dispatchDb({ connection: null });
    // The routes' 502-taxonomy catch branches on instanceof, so pin the class.
    const err = await makeService(db)
      .dispatch(BASE_INPUT)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerPreflightError);
    expect((err as WorkerPreflightError).code).toBe('no_git_connection');
    expect(rpcCalls).toEqual([]);
  });

  it('fails missing_agent_credential BEFORE staging any secret', async () => {
    const { db, rpcCalls } = dispatchDb({
      connection: { provider: 'github', repository: '/local/bare.git', installation_id: null },
      envVarRows: [],
    });
    await expect(makeService(db).dispatch(BASE_INPUT)).rejects.toMatchObject({
      code: 'missing_agent_credential',
    });
    expect(rpcCalls.filter((r) => r.name === 'insert_secret')).toEqual([]);
  });

  it('fails secret_stage_failed when the Vault write errors', async () => {
    const { db } = dispatchDb({
      connection: { provider: 'github', repository: '/local/bare.git', installation_id: null },
      envVarRows: [{ key: 'ANTHROPIC_API_KEY', target_kind: null, environment_id: 'am-env-1' }],
      secrets: { 'env_app-1_am-env-1_ANTHROPIC_API_KEY': 'sk-ant-x' },
      insertSecretError: { message: 'vault down' },
    });
    await expect(makeService(db).dispatch(BASE_INPUT)).rejects.toMatchObject({
      code: 'secret_stage_failed',
    });
  });

  it('assembles the full payload for a local-path repo and dispatches via the Fly adapter', async () => {
    const { db } = dispatchDb({
      connection: { provider: 'github', repository: '/local/bare.git', installation_id: null },
      branch: 'trunk',
      envVarRows: [{ key: 'ANTHROPIC_API_KEY', target_kind: null, environment_id: 'am-env-1' }],
      secrets: { 'env_app-1_am-env-1_ANTHROPIC_API_KEY': 'sk-ant-x' },
    });

    const result = await makeService(db).dispatch({
      ...BASE_INPUT,
      persistent: {
        workspacePath: '/data/workspace',
        workBranch: 'outerlayer/worker/env-x',
        sessionRef: 'sess-1',
        firstTurn: false,
        agentHome: '/data/home',
      },
      persistentMachine: { machineRef: 'm-7', envId: 'env-x' },
    });
    expect(result).toEqual({ machineId: 'm-1' });

    expect(mockAdapterCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        flyApiToken: 'fly-t',
        workerApp: 'workers-app',
        workerImage: 'registry.fly.io/workers-app:v1',
        region: 'iad',
        appUrl: 'https://app.agentmark.co',
      }),
    );
    const call = mockTriggerWorker.mock.calls[0]![0] as {
      workerPayload: Record<string, unknown>;
      persistentMachine: unknown;
    };
    expect(call.persistentMachine).toEqual({ machineRef: 'm-7', envId: 'env-x' });
    expect(call.workerPayload).toMatchObject({
      worker_run_id: 'run-1',
      agent: 'claude-code',
      repo_url: '/local/bare.git',
      repo_token: 'local',
      git_provider: 'local',
      base_branch: 'trunk',
      env_vars: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      events_url: 'https://app.agentmark.co/api/internal/worker-events',
      callback_url: 'https://app.agentmark.co/api/internal/worker-callback',
      persistent: {
        workspace_path: '/data/workspace',
        work_branch: 'outerlayer/worker/env-x',
        session_ref: 'sess-1',
        first_turn: false,
        agent_home: '/data/home',
      },
    });
    expect(typeof call.workerPayload.worker_secret).toBe('string');
  });

  it('resolves env vars for the machine payload off the env_var table, with kind-row and legacy-secret fallback (EV-14)', async () => {
    // Two winners after resolveEnvVarRows: a specific-env row whose env-scoped
    // vault name misses and falls back to the pre-055 app-scoped legacy name,
    // and a kind row (the app has no specific-env row for this key, so the
    // kind row wins) resolved directly off its kind-scoped vault name. This
    // pins the highest-blast-radius consumer of the table — a rename here
    // must be made in lockstep with the dashboard's write path.
    const { db } = dispatchDb({
      connection: { provider: 'github', repository: '/local/bare.git', installation_id: null },
      branch: 'trunk',
      envVarRows: [
        { key: 'ANTHROPIC_API_KEY', target_kind: null, environment_id: 'am-env-1' },
        { key: 'KIND_KEY', target_kind: 'promoted', environment_id: null },
      ],
      secrets: {
        'env_app-1_ANTHROPIC_API_KEY': 'legacy-value',
        'env_app-1_kind_promoted_KIND_KEY': 'kind-value',
      },
    });

    const result = await makeService(db).dispatch(BASE_INPUT);
    expect(result).toEqual({ machineId: 'm-1' });

    expect(db.from).toHaveBeenCalledWith('env_var');
    const call = mockTriggerWorker.mock.calls[0]![0] as {
      workerPayload: Record<string, unknown>;
    };
    expect(call.workerPayload).toMatchObject({
      env_vars: { ANTHROPIC_API_KEY: 'legacy-value', KIND_KEY: 'kind-value' },
    });
  });

  it('mints a GitHub installation token for hosted repos', async () => {
    mockGetInstallationOctokit.mockResolvedValue({
      auth: async () => ({ token: 'ghs_installation' }),
    });
    const { db } = dispatchDb({
      connection: { provider: 'github', repository: 'acme/repo', installation_id: 42 },
      branch: 'main',
      envVarRows: [{ key: 'ANTHROPIC_API_KEY', target_kind: null, environment_id: 'am-env-1' }],
      secrets: { 'env_app-1_am-env-1_ANTHROPIC_API_KEY': 'sk-ant-x' },
    });
    await makeService(db).dispatch(BASE_INPUT);
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith(42);
    const payload = (mockTriggerWorker.mock.calls[0]![0] as { workerPayload: Record<string, unknown> })
      .workerPayload;
    expect(payload.repo_token).toBe('ghs_installation');
    expect(payload.git_provider).toBe('github');
  });

  it('fails git_token_unavailable when the connection has no installation_id', async () => {
    const { db } = dispatchDb({
      connection: { provider: 'github', repository: 'acme/repo', installation_id: null },
      envVarRows: [{ key: 'ANTHROPIC_API_KEY', target_kind: null, environment_id: 'am-env-1' }],
      secrets: { 'env_app-1_am-env-1_ANTHROPIC_API_KEY': 'sk-ant-x' },
    });
    await expect(makeService(db).dispatch(BASE_INPUT)).rejects.toMatchObject({
      code: 'git_token_unavailable',
    });
  });
});
