/**
 * EvalRunService.dispatch — the launch orchestration: resolve each config's
 * model key, persist a queued run, then hand it to the Fly worker or the local
 * executor and record the terminal transition on failure. The secret bridge and
 * the credential mint are true seams (mocked — each has its own MSW-backed
 * test); the run persistence runs for real through the MSW eval_run table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createMswRestClient } from "@/test-helpers/rest-client";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import { EvalSecretsError } from "@/lib/adapters/eval-secrets";
import { getEvalRunMswState, seedManagedDeploymentTablesState } from "@/test-helpers/msw-handlers";

const { mockReadSecrets } = vi.hoisted(() => ({ mockReadSecrets: vi.fn() }));
vi.mock("@/lib/adapters/eval-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/eval-secrets")>();
  return { ...actual, readEvalConfigSecrets: mockReadSecrets };
});

const { mockMintCreds } = vi.hoisted(() => ({ mockMintCreds: vi.fn() }));
vi.mock("@/lib/system/eval-worker-credentials", () => ({ mintEvalWorkerCredentials: mockMintCreds }));

import { evalsService } from "./service";

const APP_ID = "app-1";
const CONFIGS = [
  { id: "opus", launcher: "claude-code", model: "claude-opus-4-8" },
  { id: "glm", launcher: "claude-code", model: "glm-5.2" },
];

// The persistence client is built BEFORE fetch is stubbed so it captures MSW's
// fetch; the executor/Fly stub then only intercepts the direct HTTP calls, not
// the eval_run REST writes.
let db: SupabaseClient;
function ctx(): ServiceContext {
  return { db, tenantId: "tenant-1", actor: { userId: "user-1", role: "owner" } };
}

function input(over: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    environmentId: "env-1",
    repoLabel: "acme/x",
    taskCount: 5,
    trialsPerTask: 1,
    budgetUsd: 0,
    configs: CONFIGS,
    ...over,
  } as Parameters<typeof evalsService.dispatch>[1];
}

beforeEach(() => {
  db = createMswRestClient();
  vi.stubEnv("EVAL_EXECUTOR_URL", "http://executor.test");
  mockReadSecrets.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ card: { verdict: "clear" }, spentUsd: 0.5 }) })));
  // The dispatch ownership pre-check resolves `input.environmentId` against
  // `input.appId` before any of the above — seed the app's own env so the
  // existing happy-path cases keep exercising the executor/Fly paths.
  seedManagedDeploymentTablesState({ environments: [{ id: "env-1", app_id: APP_ID, is_default: true }] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("dispatch — environment ownership pre-check", () => {
  it("rejects an env that doesn't belong to the app before any secret read, credential mint, or run insert", async () => {
    seedManagedDeploymentTablesState({
      environments: [{ id: "env-1", app_id: APP_ID, is_default: true }, { id: "env-foreign", app_id: "app-2", is_default: true }],
    });

    await expect(evalsService.dispatch(ctx(), input({ environmentId: "env-foreign" }))).rejects.toThrow(
      "Environment not found for this app.",
    );

    expect(mockReadSecrets).not.toHaveBeenCalled();
    expect(mockMintCreds).not.toHaveBeenCalled();
    expect(getEvalRunMswState()).toHaveLength(0);
  });

  it("launches when the env belongs to the app — the seeded happy path is unchanged", async () => {
    const result = await evalsService.dispatch(ctx(), input());
    expect(result.status).toBe("succeeded");
  });
});

describe("dispatch — local executor path", () => {
  it("resolves a key per config, persists the run, calls the executor, and completes it", async () => {
    const result = await evalsService.dispatch(ctx(), input());

    expect(result.status).toBe("succeeded");
    expect(result.runId).toEqual(expect.any(String));
    // A key was resolved for each of the two configs.
    expect(mockReadSecrets).toHaveBeenCalledTimes(2);

    // The executor was called with the runId and the per-config secrets.
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call![0]).toBe("http://executor.test/run");
    const sent = JSON.parse((call![1] as { body: string }).body);
    expect(sent.runId).toBe(result.runId);
    expect(sent.secretsByConfig.opus).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });

    // The run was persisted and completed with the card.
    const stored = getEvalRunMswState().find((r) => r.id === result.runId);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.card).toEqual({ verdict: "clear" });
  });

  it("fails the run when the executor errors, recording the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const result = await evalsService.dispatch(ctx(), input());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("executor responded 500");
    expect(getEvalRunMswState().find((r) => r.id === result.runId)?.status).toBe("failed");
  });

  it("fails fast on a missing secret — no run row is created", async () => {
    mockReadSecrets.mockRejectedValueOnce(new EvalSecretsError("claude-code", ["ANTHROPIC_API_KEY"]));
    await expect(evalsService.dispatch(ctx(), input())).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(getEvalRunMswState()).toHaveLength(0);
  });
});

describe("dispatch — Fly worker path", () => {
  function stubFlyEnv(over: Record<string, string | undefined> = {}) {
    vi.stubEnv("FLY_API_TOKEN", "fly-tok");
    vi.stubEnv("FLY_WORKER_APP", "eval-worker");
    vi.stubEnv("FLY_WORKER_IMAGE", "registry.fly.io/eval-worker:latest");
    for (const [key, value] of Object.entries(over)) {
      vi.stubEnv(key, value === undefined ? "" : value);
    }
  }
  const machinesFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "machine-1" }),
      // FlyEvalDispatcher parses the raw text body, not .json().
      text: async () => JSON.stringify({ id: "machine-1" }),
    }));

  it("mints the run's key and hands the Machine exactly its scoped credential + gateway URL", async () => {
    stubFlyEnv({ NEXT_PUBLIC_API_URL: "https://api.example.com" });
    mockMintCreds.mockResolvedValueOnce({ key: "sk_outerlayer_eval_perrun123" });
    const fetchMock = machinesFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await evalsService.dispatch(ctx(), input());
    expect(result.status).toBe("running");

    expect(mockMintCreds).toHaveBeenCalledTimes(1);
    expect(mockMintCreds).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      appId: APP_ID,
      environmentId: "env-1",
      runId: result.runId,
    });

    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(call[0]).toBe("https://api.machines.dev/v1/apps/eval-worker/machines");
    const env = JSON.parse(call[1].body).config.env as Record<string, string>;
    // Least-privilege: the per-run key IS the worker's credential (by design),
    // and nothing god-shaped rides along.
    expect(env.EVAL_GATEWAY_KEY).toBe("sk_outerlayer_eval_perrun123");
    expect(env.EVAL_GATEWAY_URL).toBe("https://api.example.com");
    expect(JSON.stringify(env)).not.toMatch(/service_role|SUPABASE|E2B_API_KEY/);
  });

  it("fails the run and dispatches no Machine when the mint fails", async () => {
    stubFlyEnv({ NEXT_PUBLIC_API_URL: "https://api.example.com" });
    mockMintCreds.mockRejectedValueOnce(new Error("vault down"));
    const fetchMock = machinesFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await evalsService.dispatch(ctx(), input());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("vault down");
    expect(getEvalRunMswState().find((r) => r.id === result.runId)?.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to dispatch when no gateway URL is configured — the gateway is the control plane", async () => {
    stubFlyEnv({ NEXT_PUBLIC_API_URL: undefined, EVAL_GATEWAY_URL: undefined });
    const fetchMock = machinesFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await evalsService.dispatch(ctx(), input());
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/EVAL_GATEWAY_URL/);
    expect(getEvalRunMswState().find((r) => r.id === result.runId)?.status).toBe("failed");
    expect(mockMintCreds).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
