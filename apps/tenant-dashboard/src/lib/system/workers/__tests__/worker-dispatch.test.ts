/**
 * dispatchWorkerRun — assembles a worker run's params payload and hands it to
 * the compute adapter.
 *
 * True seams mocked: the two dispatch adapters (so nothing spawns / calls Fly)
 * and collectEnvVars (its Vault+env resolution has its own tests; here we only
 * care about the map it returns). Everything else runs for real: repo
 * resolution + the worker-secret Vault staging go through MSW, and
 * `workerSecretVaultName` stays the real implementation so the staged name
 * matches what the payload carries.
 */

import { createClient } from "@supabase/supabase-js";
import {
  seedManagedDeploymentTablesState,
  seedVaultMswState,
  getVaultMswState,
} from "@/test-helpers/msw-handlers";
import { server } from "@/test-helpers/msw-server";
import { http, HttpResponse } from "msw";
import { WORKER_CAPS } from "../worker-config";

vi.mock("server-only", () => ({}));

const { mockLocalTrigger, MockLocalAdapter } = vi.hoisted(() => {
  const mockLocalTrigger = vi.fn();
  class MockLocalAdapter {
    constructor(public readonly deps: unknown) {}
    triggerWorker = mockLocalTrigger;
  }
  return { mockLocalTrigger, MockLocalAdapter };
});
vi.mock("../local-worker-adapter", () => ({ LocalWorkerAdapter: MockLocalAdapter }));

const { mockFlyTrigger, flyCtorArgs, MockFlyAdapter } = vi.hoisted(() => {
  const mockFlyTrigger = vi.fn();
  const flyCtorArgs: unknown[] = [];
  class MockFlyAdapter {
    constructor(args: unknown) {
      flyCtorArgs.push(args);
    }
    triggerWorker = mockFlyTrigger;
  }
  return { mockFlyTrigger, flyCtorArgs, MockFlyAdapter };
});
vi.mock("@repo/worker-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/worker-core")>();
  return { ...actual, FlyWorkerAdapter: MockFlyAdapter };
});

const { mockCollectAll } = vi.hoisted(() => ({ mockCollectAll: vi.fn() }));
vi.mock("@/lib/system/collect-env-vars", () => ({
  collectEnvVars: mockCollectAll,
}));

const { mockGetGithubApp } = vi.hoisted(() => ({ mockGetGithubApp: vi.fn() }));
vi.mock("@/octo-kit", () => ({ getGithubApp: mockGetGithubApp }));

import { dispatchWorkerRun, WorkerPreflightError } from "../worker-dispatch";

const SUPABASE_URL = "http://localhost:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.test";
const APP_ID = "app-1";
const TENANT_ID = "tenant-1";
const ENV_ID = "env-1";
const RUN_ID = "run-1";
const APP_URL = "https://app.example";

type Overrides = Partial<Parameters<typeof dispatchWorkerRun>[0]>;
function input(over: Overrides = {}) {
  return {
    adminSupabase: createClient(SUPABASE_URL, ANON),
    appId: APP_ID,
    tenantId: TENANT_ID,
    environmentId: ENV_ID,
    workerRunId: RUN_ID,
    agent: "claude-code",
    taskPrompt: "add tests",
    baseBranch: "feature-x",
    wallClockCapS: 1800,
    appUrl: APP_URL,
    flyConfig: null,
    ...over,
  } as Parameters<typeof dispatchWorkerRun>[0];
}

type TriggerArg = { workerRunId: string; appId: string; workerPayload: Record<string, unknown> };
function localArg(): TriggerArg {
  const call = mockLocalTrigger.mock.calls.at(-1);
  if (!call) throw new Error("LocalWorkerAdapter.triggerWorker was not called");
  return call[0] as TriggerArg;
}
function localPayload(): Record<string, unknown> {
  return localArg().workerPayload;
}
function flyArg(): TriggerArg {
  const call = mockFlyTrigger.mock.calls.at(-1);
  if (!call) throw new Error("FlyWorkerAdapter.triggerWorker was not called");
  return call[0] as TriggerArg;
}

beforeEach(() => {
  flyCtorArgs.length = 0;
  seedManagedDeploymentTablesState({
    gitConnections: [{ app_id: APP_ID, provider: "github", repository: "/tmp/repo.git", installation_id: null }],
  });
  mockCollectAll.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-test" });
  mockLocalTrigger.mockResolvedValue({ dispatchId: "d-local" });
  mockFlyTrigger.mockResolvedValue({ dispatchId: "d-fly", machineId: "m-999" });
});
afterEach(() => vi.clearAllMocks());

describe("dispatchWorkerRun — happy local dispatch", () => {
  it("stages the per-run secret in Vault and passes the full inline payload to the local adapter", async () => {
    const result = await dispatchWorkerRun(input());

    expect(result).toEqual({ dispatch: "local", machineId: null });
    expect(mockFlyTrigger).not.toHaveBeenCalled();
    expect(mockCollectAll).toHaveBeenCalledWith(APP_ID, ENV_ID);

    expect(mockLocalTrigger).toHaveBeenCalledTimes(1);
    const arg = localArg();
    expect(arg.workerRunId).toBe(RUN_ID);
    expect(arg.appId).toBe(APP_ID);

    const { worker_secret, ...rest } = arg.workerPayload as { worker_secret: string } & Record<string, unknown>;
    // The per-run bearer must be a non-empty secret and must equal the value staged in Vault.
    expect(typeof worker_secret).toBe("string");
    expect(worker_secret.length).toBeGreaterThan(0);
    expect(getVaultMswState().secrets[`worker_secret_${RUN_ID}`]).toBe(worker_secret);

    // Exact shape of everything else — kills field-rename / URL-path mutants.
    expect(rest).toEqual({
      worker_run_id: RUN_ID,
      app_id: APP_ID,
      tenant_id: TENANT_ID,
      agent: "claude-code",
      task_prompt: "add tests",
      repo_url: "/tmp/repo.git",
      repo_token: "local",
      git_provider: "local",
      base_branch: "feature-x",
      env_vars: { ANTHROPIC_API_KEY: "sk-ant-test" },
      events_url: `${APP_URL}/api/internal/worker-events`,
      callback_url: `${APP_URL}/api/internal/worker-callback`,
      transcript_url: `${APP_URL}/api/internal/worker-transcript`,
      wall_clock_cap_s: 1800,
      caps: WORKER_CAPS,
    });
    // No persistent block on a one-shot run.
    expect(rest).not.toHaveProperty("persistent");
  });

  it("carries the persistent block through to the payload for an environment turn", async () => {
    await dispatchWorkerRun(
      input({
        persistent: {
          workspacePath: "/tmp/outerlayer-worker-env/env-1",
          workBranch: "outerlayer/worker/env-abcd",
          sessionRef: "sess-prior",
          firstTurn: false,
        },
      }),
    );

    const payload = localPayload() as Record<string, unknown>;
    expect(payload.persistent).toEqual({
      workspace_path: "/tmp/outerlayer-worker-env/env-1",
      work_branch: "outerlayer/worker/env-abcd",
      session_ref: "sess-prior",
      first_turn: false,
    });
  });

  it("carries the model into the wire payload, and omits the field when unset", async () => {
    await dispatchWorkerRun(input({ model: "sonnet" }));
    expect((localPayload() as Record<string, unknown>).model).toBe("sonnet");

    vi.clearAllMocks();
    mockCollectAll.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-test" });
    mockLocalTrigger.mockResolvedValue({ dispatchId: "d-local-2" });
    await dispatchWorkerRun(input({ model: undefined }));
    expect(localPayload()).not.toHaveProperty("model");
  });

  it("carries attachments through to the wire payload, and omits the field when there are none", async () => {
    const attachments = [{ name: "mock.png", mime: "image/png", content: "aGVsbG8=" }];
    await dispatchWorkerRun(input({ attachments }));
    expect((localPayload() as Record<string, unknown>).attachments).toEqual(attachments);

    vi.clearAllMocks();
    mockCollectAll.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-test" });
    mockLocalTrigger.mockResolvedValue({ dispatchId: "d-local-2" });
    await dispatchWorkerRun(input({ attachments: [] }));
    expect(localPayload()).not.toHaveProperty("attachments");
  });

  it("resolves the branch from git_branch when no base branch is requested", async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/git_branch`, () => HttpResponse.json({ branch_name: "develop" })),
    );
    await dispatchWorkerRun(input({ baseBranch: "" }));
    const payload = localPayload() as { base_branch: string };
    expect(payload.base_branch).toBe("develop");
  });

  it("defaults the branch to main when git_branch has no row", async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/git_branch`, () =>
        HttpResponse.json({ code: "PGRST116", message: "0 rows" }, { status: 406 }),
      ),
    );
    await dispatchWorkerRun(input({ baseBranch: "" }));
    const payload = localPayload() as { base_branch: string };
    expect(payload.base_branch).toBe("main");
  });
});

describe("dispatchWorkerRun — hosted git providers", () => {
  it("obtains a GitHub installation token for a hosted github repo", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, provider: "github", repository: "https://github.com/o/r.git", installation_id: 555 },
      ],
    });
    mockGetGithubApp.mockReturnValue({
      getInstallationOctokit: vi.fn(async () => ({ auth: async () => ({ token: "ghs_installtoken" }) })),
    });

    await dispatchWorkerRun(input());
    const payload = localPayload() as { repo_token: string; git_provider: string };
    expect(payload.git_provider).toBe("github");
    expect(payload.repo_token).toBe("ghs_installtoken");
  });

  it("fails preflight with git_token_unavailable when the connection has no installation_id", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, provider: "github", repository: "https://github.com/o/r.git", installation_id: null },
      ],
    });

    await expect(dispatchWorkerRun(input())).rejects.toThrow(WorkerPreflightError);
    await expect(dispatchWorkerRun(input())).rejects.toMatchObject({
      code: "git_token_unavailable",
    });
  });
});

describe("dispatchWorkerRun — Fly dispatch", () => {
  it("constructs the FlyWorkerAdapter from the config and returns its machine id", async () => {
    const flyConfig = { flyApiToken: "fly-tok", workerApp: "worker-app", workerImage: "img:1", region: "iad" };
    const result = await dispatchWorkerRun(input({ flyConfig }));

    expect(result).toEqual({ dispatch: "fly", machineId: "m-999" });
    expect(mockLocalTrigger).not.toHaveBeenCalled();
    expect(mockFlyTrigger).toHaveBeenCalledTimes(1);
    expect(flyArg()).toEqual(
      expect.objectContaining({ workerRunId: RUN_ID, appId: APP_ID }),
    );

    expect(flyCtorArgs).toHaveLength(1);
    expect(flyCtorArgs[0]).toEqual(
      expect.objectContaining({
        flyApiToken: "fly-tok",
        workerApp: "worker-app",
        workerImage: "img:1",
        region: "iad",
        appUrl: APP_URL,
      }),
    );
  });

  it("returns machineId null when the Fly adapter reports no machine", async () => {
    mockFlyTrigger.mockResolvedValue({ dispatchId: "d-fly" });
    const result = await dispatchWorkerRun(
      input({ flyConfig: { flyApiToken: "t", workerApp: "a" } }),
    );
    expect(result).toEqual({ dispatch: "fly", machineId: null });
  });
});

describe("dispatchWorkerRun — preflight failures never reach the adapter", () => {
  it("throws no_git_connection when the app has no connected repository", async () => {
    seedManagedDeploymentTablesState({ gitConnections: [] });
    const err = await dispatchWorkerRun(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerPreflightError);
    expect((err as WorkerPreflightError).code).toBe("no_git_connection");
    expect(mockLocalTrigger).not.toHaveBeenCalled();
    expect(mockFlyTrigger).not.toHaveBeenCalled();
  });

  it("throws git_token_unavailable when a hosted github repo has no installation", async () => {
    seedManagedDeploymentTablesState({
      gitConnections: [
        { app_id: APP_ID, provider: "github", repository: "https://github.com/o/r.git", installation_id: null },
      ],
    });
    const err = await dispatchWorkerRun(input()).catch((e: unknown) => e);
    expect((err as WorkerPreflightError).code).toBe("git_token_unavailable");
  });

  it("throws unknown_agent for an agent with no credential registry entry", async () => {
    const err = await dispatchWorkerRun(input({ agent: "devin" })).catch((e: unknown) => e);
    expect((err as WorkerPreflightError).code).toBe("unknown_agent");
    expect(mockLocalTrigger).not.toHaveBeenCalled();
  });

  it("throws missing_agent_credential when none of the agent's keys are set", async () => {
    mockCollectAll.mockResolvedValue({ SOME_OTHER_VAR: "x" });
    const err = await dispatchWorkerRun(input()).catch((e: unknown) => e);
    expect((err as WorkerPreflightError).code).toBe("missing_agent_credential");
    // The secret is only staged after the credential check passes.
    expect(getVaultMswState().secrets[`worker_secret_${RUN_ID}`]).toBeUndefined();
    expect(mockLocalTrigger).not.toHaveBeenCalled();
  });

  it("throws secret_stage_failed when Vault rejects the insert", async () => {
    seedVaultMswState({ forceInsertError: { message: "vault down" } });
    const err = await dispatchWorkerRun(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerPreflightError);
    expect((err as WorkerPreflightError).code).toBe("secret_stage_failed");
    expect((err as WorkerPreflightError).message).toContain("vault down");
    expect(mockLocalTrigger).not.toHaveBeenCalled();
  });

  it("refuses local dispatch on a hosted deployment (no Fly config) instead of spawning a doomed child", async () => {
    // On Vercel there is no host to run the child; falling through to the local
    // adapter would leave the run wedged in `provisioning`. Fail preflight so
    // the caller marks the run failed with an actionable reason.
    vi.stubEnv("VERCEL", "1");
    try {
      const err = await dispatchWorkerRun(input({ flyConfig: null })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkerPreflightError);
      expect((err as WorkerPreflightError).code).toBe("cloud_worker_unconfigured");
      expect(mockLocalTrigger).not.toHaveBeenCalled();
      expect(mockFlyTrigger).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still dispatches to Fly on a hosted deployment when Fly is configured", async () => {
    vi.stubEnv("VERCEL", "1");
    try {
      const result = await dispatchWorkerRun(
        input({ flyConfig: { flyApiToken: "t", workerApp: "a" } }),
      );
      expect(result).toEqual({ dispatch: "fly", machineId: "m-999" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a subscription OAuth token as the claude-code credential (API keys only)", async () => {
    // Anthropic's credential policy: third-party services must not route
    // requests through plan (OAuth) credentials — the token must not satisfy
    // preflight even when present.
    mockCollectAll.mockResolvedValue({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz" });
    const err = await dispatchWorkerRun(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerPreflightError);
    expect((err as WorkerPreflightError).code).toBe("missing_agent_credential");
    expect((err as WorkerPreflightError).message).toContain("ANTHROPIC_API_KEY");
    expect(mockLocalTrigger).not.toHaveBeenCalled();
  });
});


describe("dispatchWorkerRun — persistent threading", () => {
  it("hands the durable-machine signal to the adapter and agent_home to the payload", async () => {
    mockCollectAll.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-x" });
    const result = await dispatchWorkerRun(
      input({
        persistent: {
          workspacePath: "/data/workspace",
          workBranch: "outerlayer/worker/env-x",
          sessionRef: "sess-9",
          firstTurn: false,
          agentHome: "/data/home",
        },
        persistentMachine: { machineRef: "m-1", envId: "env-1" },
      }),
    );
    expect(result.dispatch).toBe("local");
    expect(mockLocalTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        persistentMachine: { machineRef: "m-1", envId: "env-1" },
        workerPayload: expect.objectContaining({
          persistent: {
            workspace_path: "/data/workspace",
            work_branch: "outerlayer/worker/env-x",
            session_ref: "sess-9",
            first_turn: false,
            agent_home: "/data/home",
          },
        }),
      }),
    );
  });

  it("omits the machine signal entirely for one-shot dispatches", async () => {
    mockCollectAll.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-x" });
    await dispatchWorkerRun(input());
    const params = mockLocalTrigger.mock.calls[0]![0] as Record<string, unknown>;
    expect("persistentMachine" in params).toBe(false);
  });
});
