/**
 * runWorker orchestration. These are integration-flavoured: the
 * ONLY seam mocked is the adapter registry (so we can inject a controllable
 * "agent" that is a real `node` child writing real files); clone, diff
 * collection, work-branch checkout/commit/push, and the Reporter all run for
 * real against temp git repos. `fetch` is stubbed so we can assert the exact
 * terminal callback payload the dashboard would receive.
 *
 * The fake agent is a tiny .cjs script driven by a JSON "plan" passed through
 * the adapter's env: which files to write, which JSONL protocol lines to emit,
 * the exit code, and an optional hang (for the wall-clock path).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorker, slugFromTask } from '../worker-runner.js';
import type { NormalizedEvent, WorkerAgentAdapter } from '../agents/types.js';
import type { WorkerCallbackPayload, WorkerParamsPayload } from '../lib/schemas.js';

const execFileAsync = promisify(execFile);

// --- the registry is the only mocked module -------------------------------
const registryState = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../agents/registry.js', () => ({
  getAgentAdapter: () => registryState.adapter,
  listAgentAdapters: () => (registryState.adapter ? [registryState.adapter] : []),
}));

describe('slugFromTask', () => {
  it('produces a git-safe branch slug from a natural-language task', () => {
    expect(slugFromTask('Implement feature X: add a /version endpoint!')).toBe(
      'implement-feature-x-add-a-version-endpoint',
    );
  });

  it('collapses runs of unsafe characters and trims leading/trailing separators', () => {
    expect(slugFromTask('  ***hello***  world  ')).toBe('hello-world');
  });

  it('caps length and never leaves a trailing hyphen', () => {
    const slug = slugFromTask('a'.repeat(80));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to "task" when the prompt has no slug-able characters', () => {
    expect(slugFromTask('!!! @@@ ###')).toBe('task');
    expect(slugFromTask('')).toBe('task');
  });
});

// --- fake-agent fixture ----------------------------------------------------
const FIXTURE_SRC = `
const fs = require('node:fs');
const path = require('node:path');
const plan = JSON.parse(process.env.FAKE_AGENT_PLAN || '{}');
if (plan.dumpEnvTo) fs.writeFileSync(plan.dumpEnvTo, JSON.stringify({ HOME: process.env.HOME }));
for (const [rel, content] of Object.entries(plan.write || {})) {
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  fs.writeFileSync(rel, content);
}
for (const [from, to] of Object.entries(plan.copy || {})) {
  fs.mkdirSync(path.dirname(to) || '.', { recursive: true });
  fs.copyFileSync(from, to);
}
for (const line of plan.emit || []) {
  process.stdout.write(JSON.stringify(line) + '\\n');
}
const finish = () => process.exit(typeof plan.exit === 'number' ? plan.exit : 0);
if (plan.sleepMs) { setTimeout(finish, plan.sleepMs); } else { finish(); }
`;

interface Plan {
  write?: Record<string, string>;
  /** { fromRelPath: toRelPath } — the fake agent "reads" an attachment. */
  copy?: Record<string, string>;
  emit?: unknown[];
  exit?: number;
  sleepMs?: number;
  /** Absolute path the fixture dumps its env snapshot ({ HOME }) to. */
  dumpEnvTo?: string;
}

let fixturePath: string;
let fixtureRoot: string;

// --- protocol the fake adapter understands (mirrors the real ones) --------
function parseLine(line: string): NormalizedEvent[] {
  const t = line.trim();
  if (!t) return [];
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (m.type === 'session') {
    return [{ event_type: 'status', payload: { phase: 'agent-launched', session_id: m.id } }];
  }
  if (m.type === 'result') {
    return [
      {
        event_type: 'result',
        payload: {
          result: m.result ?? '',
          is_error: m.is_error === true,
          cost_usd: m.cost_usd,
          num_turns: m.num_turns,
        },
      },
    ];
  }
  return [];
}

function baseAdapter(): WorkerAgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    credentialKeys: { anyOf: ['X'] },
    supportsResume: false,
    command: () => ({ argv: [process.execPath, fixturePath], env: {} }),
    parseLine,
    extractResult(events) {
      const r = [...events].reverse().find((e) => e.event_type === 'result');
      if (!r) return null;
      return {
        costUsd: typeof r.payload.cost_usd === 'number' ? r.payload.cost_usd : undefined,
        numTurns: typeof r.payload.num_turns === 'number' ? r.payload.num_turns : undefined,
        isError: r.payload.is_error === true,
      };
    },
    captureSessionRef(events) {
      for (const e of events) {
        if (e.event_type === 'status' && typeof e.payload.session_id === 'string') return e.payload.session_id;
      }
      return null;
    },
  };
}

function agentWith(commandPlan: Plan): WorkerAgentAdapter {
  const a = baseAdapter();
  a.command = () => ({ argv: [process.execPath, fixturePath], env: { FAKE_AGENT_PLAN: JSON.stringify(commandPlan) } });
  return a;
}

// --- fetch stub ------------------------------------------------------------
const EVENTS_URL = 'http://cb.local/events';
const CALLBACK_URL = 'http://cb.local/callback';
let fetchMock: ReturnType<typeof vi.fn>;

function okResponse() {
  return { ok: true, status: 200, text: async () => '' };
}

function callbackBody(): WorkerCallbackPayload {
  const call = [...fetchMock.mock.calls].reverse().find((c) => c[0] === CALLBACK_URL);
  if (!call) throw new Error('no terminal callback POST was captured');
  return JSON.parse((call[1] as RequestInit).body as string) as WorkerCallbackPayload;
}

const taskPrompt = 'Add a version endpoint';
const roots: string[] = [];

async function makeOrigin(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-origin-'));
  roots.push(root);
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  await execFileAsync('git', ['init', '-q', '--bare', bare]);
  await execFileAsync('git', ['clone', '-q', bare, seed]);
  const g = (a: string[]) => execFileAsync('git', a, { cwd: seed });
  await g(['config', 'user.email', 's@l']);
  await g(['config', 'user.name', 's']);
  await fs.writeFile(path.join(seed, 'README.md'), '# seed\n');
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
  await g(['branch', '-M', 'main']);
  await g(['push', '-q', 'origin', 'main']);
  return bare;
}

async function cloneWorkspace(bare: string): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-ws-'));
  roots.push(ws);
  await execFileAsync('git', ['clone', '-q', '--branch', 'main', bare, ws]);
  return ws;
}

function makeParams(over: Record<string, unknown>): WorkerParamsPayload {
  return {
    worker_run_id: 'run-1',
    app_id: 'app-1',
    tenant_id: 'tenant-1',
    agent: 'fake',
    task_prompt: taskPrompt,
    repo_token: 'unused',
    git_provider: 'local',
    base_branch: 'main',
    env_vars: {},
    events_url: EVENTS_URL,
    callback_url: CALLBACK_URL,
    worker_secret: 'secret-1',
    wall_clock_cap_s: 60,
    caps: { max_diff_files: 50, max_diff_bytes: 1_000_000, max_raw_log_chars: 100_000 },
    ...over,
  } as WorkerParamsPayload;
}

function run(params: WorkerParamsPayload | Record<string, unknown>, extra: Record<string, string> = {}): Promise<void> {
  return runWorker({
    WORKER_PARAMS: JSON.stringify(params),
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...extra,
  } as NodeJS.ProcessEnv);
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-fixture-'));
  fixturePath = path.join(fixtureRoot, 'fake-agent.cjs');
  await fs.writeFile(fixturePath, FIXTURE_SRC);
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  registryState.adapter = null;
  fetchMock = vi.fn(async () => okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }).catch(() => undefined)));
});

// --- param loading + preflight --------------------------------------------
describe('runWorker param loading + preflight', () => {
  it('rejects (with no callback attempted) when neither WORKER_PARAMS nor WORKER_TOKEN is set', async () => {
    await expect(runWorker({} as NodeJS.ProcessEnv)).rejects.toThrow(
      /requires WORKER_PARAMS \/ WORKER_PARAMS_FILE \(local\) or WORKER_TOKEN \(ephemeral\)/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads params from WORKER_PARAMS_FILE and deletes the file after reading it', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({ emit: [{ type: 'result', is_error: false }] });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-params-'));
    roots.push(dir);
    const paramsFile = path.join(dir, 'params.json');
    await fs.writeFile(paramsFile, JSON.stringify(makeParams({ repo_url: bare })));

    await runWorker({
      WORKER_PARAMS_FILE: paramsFile,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    } as NodeJS.ProcessEnv);

    expect(callbackBody().status).toBe('succeeded');
    // Single-use handoff: the file must be consumed.
    await expect(fs.access(paramsFile)).rejects.toThrow();
  });

  it('sends a preflight_failed bare callback and throws when params fail schema validation', async () => {
    // Missing task_prompt (invalid) but the four callback fields are present.
    const raw = {
      worker_run_id: 'run-9',
      app_id: 'app-9',
      worker_secret: 'secret-9',
      callback_url: CALLBACK_URL,
    };
    await expect(run(raw)).rejects.toThrow('invalid worker params');

    const body = callbackBody();
    expect(body).toMatchObject({
      worker_run_id: 'run-9',
      app_id: 'app-9',
      status: 'failed',
      failure_code: 'preflight_failed',
    });
    const [, init] = fetchMock.mock.calls.find((c) => c[0] === CALLBACK_URL)!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-9' });
  });

  it('throws WITHOUT any callback when invalid params also lack the callback coordinates', async () => {
    await expect(run({ nonsense: true })).rejects.toThrow('invalid worker params');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with preflight_failed (and does not throw) when the agent adapter is unknown', async () => {
    registryState.adapter = null; // getAgentAdapter -> null
    const bare = await makeOrigin();
    await expect(run(makeParams({ repo_url: bare, agent: 'ghost' }))).resolves.toBeUndefined();
    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'preflight_failed' });
    expect(callbackBody().error).toContain('ghost');
  });

  it('loads params via the WORKER_TOKEN one-time handshake when WORKER_PARAMS is absent', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({ emit: [{ type: 'result', is_error: false }] });
    const params = makeParams({ repo_url: bare });
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/worker-params')) {
        return { ok: true, status: 200, json: async () => params };
      }
      return okResponse();
    });

    await runWorker({
      WORKER_TOKEN: 'boot-tok',
      WORKER_RUN_ID: 'run-1',
      DASHBOARD_URL: 'http://dash.local',
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    } as NodeJS.ProcessEnv);

    const getCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/worker-params'))!;
    expect(getCall[0]).toBe('http://dash.local/api/internal/worker-params?worker_run_id=run-1');
    expect((getCall[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer boot-tok' });
    expect(callbackBody().status).toBe('succeeded');
  });
});

// --- one-shot mode ---------------------------------------------------------
describe('runWorker one-shot mode', () => {
  it('clones, runs the agent, and reports the produced diff as a succeeded/changes callback', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({
      write: { 'src/version.ts': 'export const VERSION = 1;\n' },
      emit: [
        { type: 'session', id: 'sess-A' },
        { type: 'result', is_error: false, cost_usd: 0.42, num_turns: 3 },
      ],
    });

    await run(makeParams({ repo_url: bare }));

    const body = callbackBody();
    expect(body).toMatchObject({
      worker_run_id: 'run-1',
      app_id: 'app-1',
      status: 'succeeded',
      outcome: 'changes',
      branch_slug: 'add-a-version-endpoint',
      cost_usd: 0.42,
      num_turns: 3,
    });
    expect(body.changes).toEqual([
      { path: 'src/version.ts', operation: 'write', content: 'export const VERSION = 1;\n', encoding: 'utf8' },
    ]);
    expect(body.raw_log).toContain('"type":"result"');
    expect(typeof body.duration_ms).toBe('number');
  });

  it('reports succeeded/no_changes with no changes array or branch when the agent edited nothing', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({ emit: [{ type: 'result', is_error: false }] });

    await run(makeParams({ repo_url: bare }));

    const body = callbackBody();
    expect(body.status).toBe('succeeded');
    expect(body.outcome).toBe('no_changes');
    expect(body.changes).toBeUndefined();
    expect(body.branch_slug).toBeUndefined();
  });

  it('materializes attachments for the agent, tells it where they are, and keeps them out of the diff', async () => {
    const bare = await makeOrigin();
    const imageBytes = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]); // binary, PNG-ish
    // run-1 → per-run dir "run-1". The fake agent copies the attachment into
    // the repo, proving the bytes were readable at the advertised path.
    const attachmentPath = '.outerlayer-attachments/run-1/design.png';
    const adapter = baseAdapter();
    const commandSpy = vi.fn((_task: string) => ({
      argv: [process.execPath, fixturePath],
      env: {
        FAKE_AGENT_PLAN: JSON.stringify({
          copy: { [attachmentPath]: 'assets/design.png' },
          emit: [{ type: 'result', is_error: false }],
        } satisfies Plan),
      },
    }));
    adapter.command = commandSpy;
    registryState.adapter = adapter;

    await run(
      makeParams({
        repo_url: bare,
        attachments: [
          { name: 'design.png', mime: 'image/png', content: imageBytes.toString('base64') },
        ],
      }),
    );

    // The agent's prompt names the materialized path.
    const taskSeen = commandSpy.mock.calls[0]![0];
    expect(taskSeen).toContain(taskPrompt);
    expect(taskSeen).toContain(`- ${attachmentPath} (image/png, 8 B)`);

    // The diff contains ONLY the agent's copy — the attachment itself never
    // leaks into the change set (and so never into a branch or PR).
    const body = callbackBody();
    expect(body).toMatchObject({ status: 'succeeded', outcome: 'changes' });
    expect(body.changes).toEqual([
      {
        path: 'assets/design.png',
        operation: 'write',
        content: imageBytes.toString('base64'),
        encoding: 'base64',
      },
    ]);
  });

  it('reports clone_failed when the repo cannot be cloned', async () => {
    registryState.adapter = agentWith({});
    await run(makeParams({ repo_url: '/no/such/repo-xyz.git' }));
    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'clone_failed' });
  });

  it('reports agent_error on a non-zero agent exit code, echoing the code', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({ emit: [{ type: 'result', is_error: false }], exit: 2 });

    await run(makeParams({ repo_url: bare }));

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'agent_error', error: 'agent exited with code 2' });
  });

  it('reports agent_error when the agent exits 0 but its result event is flagged is_error', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({ emit: [{ type: 'result', is_error: true }], exit: 0 });

    await run(makeParams({ repo_url: bare }));

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'agent_error' });
  });

  it('reports diff_too_large when the change set exceeds the file-count cap', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({
      write: { 'a.ts': 'a\n', 'b.ts': 'b\n' },
      emit: [{ type: 'result', is_error: false }],
    });

    await run(makeParams({ repo_url: bare, caps: { max_diff_files: 1, max_diff_bytes: 1_000_000, max_raw_log_chars: 100_000 } }));

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'diff_too_large' });
  });

  it('reports timed_out/wall_clock_exceeded when the agent runs past the cap', async () => {
    const bare = await makeOrigin();
    registryState.adapter = agentWith({ emit: [{ type: 'session', id: 's' }], sleepMs: 5000 });

    await run(makeParams({ repo_url: bare, wall_clock_cap_s: 1 }));

    expect(callbackBody()).toMatchObject({ status: 'timed_out', failure_code: 'wall_clock_exceeded' });
  });
});

// --- persistent-environment turns -----------------------------------------
describe('runWorker persistent turns', () => {
  it('first turn: clones into the durable workspace, commits + pushes the work branch, reports it + the new session', async () => {
    const bare = await makeOrigin();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-persist-'));
    roots.push(root);
    const workspace = path.join(root, 'ws');
    registryState.adapter = agentWith({
      write: { 'turn1.ts': 'one\n' },
      emit: [
        { type: 'session', id: 'sess-new' },
        { type: 'result', is_error: false, cost_usd: 0.1 },
      ],
    });

    await run(
      makeParams({
        repo_url: bare,
        persistent: { workspace_path: workspace, work_branch: 'outerlayer/worker/feat', first_turn: true },
      }),
    );

    const body = callbackBody();
    expect(body).toMatchObject({
      status: 'succeeded',
      outcome: 'changes',
      work_branch: 'outerlayer/worker/feat',
      session_ref: 'sess-new',
      cost_usd: 0.1,
    });
    // The change must be present as a real commit pushed to origin.
    const originBranches = (await execFileAsync('git', ['branch'], { cwd: bare })).stdout;
    expect(originBranches).toContain('outerlayer/worker/feat');
    expect(await fs.readFile(path.join(workspace, 'turn1.ts'), 'utf8')).toBe('one\n');
  });

  it('follow-up turn: resumes the prior session (not a fresh command) and preserves the session ref', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);

    const resumeCommand = vi.fn(() => ({
      argv: [process.execPath, fixturePath],
      env: { FAKE_AGENT_PLAN: JSON.stringify({ write: { 'resumed.ts': 'R\n' }, emit: [{ type: 'result', is_error: false }] }) },
    }));
    const adapter = baseAdapter();
    adapter.supportsResume = true;
    adapter.resumeCommand = resumeCommand;
    // command (one-shot) would write a DIFFERENT marker — proves it was not used.
    adapter.command = () => ({
      argv: [process.execPath, fixturePath],
      env: { FAKE_AGENT_PLAN: JSON.stringify({ write: { 'oneshot.ts': 'O\n' }, emit: [] }) },
    });
    registryState.adapter = adapter;

    await run(
      makeParams({
        repo_url: bare,
        persistent: {
          workspace_path: workspace,
          work_branch: 'outerlayer/worker/cont',
          session_ref: 'prior-session',
          first_turn: false,
        },
      }),
    );

    expect(resumeCommand).toHaveBeenCalledWith('prior-session', taskPrompt, { workspace, wallClockCapS: 60 });
    // The resume plan ran, the one-shot plan did not.
    await expect(fs.access(path.join(workspace, 'resumed.ts'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, 'oneshot.ts'))).rejects.toThrow();

    const body = callbackBody();
    expect(body).toMatchObject({ status: 'succeeded', outcome: 'changes', work_branch: 'outerlayer/worker/cont', session_ref: 'prior-session' });
  });

  it('persistent turn: attachments reach the workspace and the resumed agent, but never the pushed commit', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    const resumeCommand = vi.fn((_sessionRef: string, _task: string) => ({
      argv: [process.execPath, fixturePath],
      env: {
        FAKE_AGENT_PLAN: JSON.stringify({
          write: { 'from-attachment.ts': 'seen\n' },
          emit: [{ type: 'result', is_error: false }],
        } satisfies Plan),
      },
    }));
    const adapter = baseAdapter();
    adapter.supportsResume = true;
    adapter.resumeCommand = resumeCommand;
    registryState.adapter = adapter;

    await run(
      makeParams({
        repo_url: bare,
        attachments: [{ name: 'notes.md', mime: 'text/markdown', content: Buffer.from('# ctx\n').toString('base64') }],
        persistent: {
          workspace_path: workspace,
          work_branch: 'outerlayer/worker/att',
          session_ref: 'sess-att',
          first_turn: false,
        },
      }),
    );

    // The resume invocation carries the augmented task (manifest included).
    const resumedTask = resumeCommand.mock.calls[0]![1];
    expect(resumedTask).toContain(taskPrompt);
    expect(resumedTask).toContain('.outerlayer-attachments/run-1/notes.md (text/markdown, 6 B)');
    // Materialized in the durable workspace...
    expect(await fs.readFile(path.join(workspace, '.outerlayer-attachments/run-1/notes.md'), 'utf8')).toBe('# ctx\n');
    expect(callbackBody()).toMatchObject({ status: 'succeeded', outcome: 'changes', work_branch: 'outerlayer/worker/att' });

    // ...but absent from the checkpoint commit pushed to origin.
    const pushedFiles = (
      await execFileAsync('git', ['ls-tree', '-r', '--name-only', 'outerlayer/worker/att'], { cwd: bare })
    ).stdout;
    expect(pushedFiles).toContain('from-attachment.ts');
    expect(pushedFiles).not.toContain('.outerlayer-attachments');
  });

  it('follow-up turn with a resume-less adapter uses the one-shot command in the warm workspace', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    const adapter = agentWith({ write: { 'fresh.ts': 'F\n' }, emit: [{ type: 'result', is_error: false }] });
    adapter.supportsResume = false; // canResume must be false even with a session_ref
    registryState.adapter = adapter;

    await run(
      makeParams({
        repo_url: bare,
        persistent: {
          workspace_path: workspace,
          work_branch: 'outerlayer/worker/nr',
          session_ref: 'ignored-session',
          first_turn: false,
        },
      }),
    );

    await expect(fs.access(path.join(workspace, 'fresh.ts'))).resolves.toBeUndefined();
    expect(callbackBody()).toMatchObject({ status: 'succeeded', outcome: 'changes', work_branch: 'outerlayer/worker/nr' });
  });

  it('follow-up turn with no edits reports no_changes, no work branch, and keeps the prior session ref', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    registryState.adapter = agentWith({ emit: [{ type: 'result', is_error: false }] });

    await run(
      makeParams({
        repo_url: bare,
        persistent: {
          workspace_path: workspace,
          work_branch: 'outerlayer/worker/empty',
          session_ref: 'keep-me',
          first_turn: false,
        },
      }),
    );

    const body = callbackBody();
    expect(body.status).toBe('succeeded');
    expect(body.outcome).toBe('no_changes');
    expect(body.work_branch).toBeUndefined();
    expect(body.session_ref).toBe('keep-me');
  });

  it('persistent unknown adapter fails preflight_failed before touching the workspace', async () => {
    registryState.adapter = null;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-persist-nb-'));
    roots.push(root);
    await run(
      makeParams({
        repo_url: '/unused',
        agent: 'ghost',
        persistent: { workspace_path: path.join(root, 'ws'), work_branch: 'wb', first_turn: true },
      }),
    );
    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'preflight_failed' });
  });

  it('persistent first-turn clone failure reports clone_failed', async () => {
    registryState.adapter = agentWith({});
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-persist-cf-'));
    roots.push(root);
    await run(
      makeParams({
        repo_url: '/no/such/persist-repo.git',
        persistent: { workspace_path: path.join(root, 'ws'), work_branch: 'wb', first_turn: true },
      }),
    );
    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'clone_failed' });
  });

  it('persistent push failure (unreachable origin) reports push_failed', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    registryState.adapter = agentWith({ write: { 'change.ts': 'c\n' }, emit: [{ type: 'result', is_error: false }] });
    // Destroy the origin after the workspace exists: local commit succeeds, push cannot.
    await fs.rm(bare, { recursive: true, force: true });

    await run(
      makeParams({
        repo_url: bare,
        persistent: {
          workspace_path: workspace,
          work_branch: 'outerlayer/worker/pf',
          session_ref: 's',
          first_turn: false,
        },
      }),
    );

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'push_failed' });
  });

  it('persistent agent error reports agent_error and skips the push', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    registryState.adapter = agentWith({ write: { 'x.ts': 'x\n' }, emit: [{ type: 'result', is_error: false }], exit: 1 });

    await run(
      makeParams({
        repo_url: bare,
        persistent: { workspace_path: workspace, work_branch: 'outerlayer/worker/ae', first_turn: false },
      }),
    );

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'agent_error' });
  });

  it('persistent turn reports agent_error when the agent exits 0 but flags is_error', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    registryState.adapter = agentWith({ write: { 'y.ts': 'y\n' }, emit: [{ type: 'result', is_error: true }], exit: 0 });

    await run(
      makeParams({
        repo_url: bare,
        persistent: { workspace_path: workspace, work_branch: 'outerlayer/worker/ie', first_turn: false },
      }),
    );

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'agent_error' });
  });

  it('persistent wall-clock timeout reports wall_clock_exceeded', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    registryState.adapter = agentWith({ sleepMs: 5000 });

    await run(
      makeParams({
        repo_url: bare,
        wall_clock_cap_s: 1,
        persistent: { workspace_path: workspace, work_branch: 'outerlayer/worker/to', first_turn: false },
      }),
    );

    expect(callbackBody()).toMatchObject({ status: 'failed', failure_code: 'wall_clock_exceeded' });
  });
});


describe('runWorker persistent agent HOME (durable substrates)', () => {
  it('points the agent HOME at agent_home and creates the directory', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    const root = path.dirname(workspace);
    const agentHome = path.join(root, 'vol-home');
    const dump = path.join(root, 'env-dump.json');
    registryState.adapter = agentWith({
      dumpEnvTo: dump,
      emit: [{ type: 'result', is_error: false }],
    });

    await run(
      makeParams({
        repo_url: bare,
        persistent: {
          workspace_path: workspace,
          work_branch: 'outerlayer/worker/home',
          first_turn: false,
          agent_home: agentHome,
        },
      }),
    );

    const snapshot = JSON.parse(await fs.readFile(dump, 'utf8')) as { HOME: string };
    expect(snapshot.HOME).toBe(agentHome);
    // The runner created the volume-backed HOME before launching the agent.
    expect((await fs.stat(agentHome)).isDirectory()).toBe(true);
  });

  it('keeps the host HOME when agent_home is absent (local substrate)', async () => {
    const bare = await makeOrigin();
    const workspace = await cloneWorkspace(bare);
    const dump = path.join(path.dirname(workspace), 'env-dump-local.json');
    registryState.adapter = agentWith({
      dumpEnvTo: dump,
      emit: [{ type: 'result', is_error: false }],
    });

    await run(
      makeParams({
        repo_url: bare,
        persistent: { workspace_path: workspace, work_branch: 'outerlayer/worker/home2', first_turn: false },
      }),
    );

    const snapshot = JSON.parse(await fs.readFile(dump, 'utf8')) as { HOME: string };
    expect(snapshot.HOME).toBe(process.env.HOME);
  });
});
