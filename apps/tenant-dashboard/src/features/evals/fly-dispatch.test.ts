import { afterEach, describe, expect, it, vi } from "vitest";
import { flyDispatchFromEnv, FlyEvalDispatcher, type FlyDispatchConfig } from "./fly-dispatch";

const CFG: FlyDispatchConfig = {
  apiToken: "fly_test_token",
  appName: "outerlayer-eval-worker",
  image: "registry.fly.io/outerlayer-eval-worker:latest",
  region: "iad",
  workerEnv: { EVAL_GATEWAY_URL: "https://api.example.com", OUTERLAYER_E2B_ENABLED: "1" },
  maxAttempts: 3,
};

/** Scripted fetch: each call returns the next queued response, recording requests. */
function stubFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `status ${r.status}`,
      json: async () => r.body ?? {},
      text: async () => (r.body ? JSON.stringify(r.body) : ""),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("FlyEvalDispatcher.dispatch", () => {
  it("POSTs an auto-destroy worker Machine with the runId in env, Bearer auth", async () => {
    const { calls } = stubFetch([{ status: 200, body: { id: "machine_abc", state: "created" } }]);
    const out = await new FlyEvalDispatcher(CFG).dispatch("run-123", "app-9");

    expect(out.machineId).toBe("machine_abc");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.machines.dev/v1/apps/outerlayer-eval-worker/machines");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fly_test_token");

    const body = JSON.parse(init.body as string);
    expect(body.region).toBe("iad");
    expect(body.config.image).toBe(CFG.image);
    expect(body.config.auto_destroy).toBe(true);
    expect(body.config.restart).toEqual({ policy: "on-failure", max_retries: 2 });
    expect(body.config.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
    expect(body.config.env.RUN_ID).toBe("run-123");
    expect(body.config.env.EVAL_APP_ID).toBe("app-9");
    expect(body.config.env.EVAL_GATEWAY_URL).toBe("https://api.example.com");
  });

  it("Machine env carries at most the run's own scoped key — no app secret, no service role", async () => {
    const { calls } = stubFetch([{ status: 200, body: { id: "m1" } }]);
    await new FlyEvalDispatcher(CFG).dispatch("run-1", "app-1", {
      EVAL_GATEWAY_KEY: "sk_outerlayer_eval_perrun123",
    });
    const env = JSON.parse(calls[0]!.init.body as string).config.env as Record<string, string>;
    expect(env).toEqual({
      RUN_ID: "run-1",
      EVAL_APP_ID: "app-1",
      EVAL_GATEWAY_URL: "https://api.example.com",
      OUTERLAYER_E2B_ENABLED: "1",
      EVAL_GATEWAY_KEY: "sk_outerlayer_eval_perrun123",
    });
    // No broadly-scoped credential rides here: no Supabase material, no E2B key,
    // no model keys — only the run's self-destructing gateway key.
    expect(JSON.stringify(env)).not.toMatch(/service_role|SERVICE_ROLE|SUPABASE|E2B_API_KEY|ANTHROPIC|OPENAI/);
  });

  it("retries transient failures (5xx) then succeeds", async () => {
    const { calls } = stubFetch([
      { status: 503, body: { error: "no capacity" } },
      { status: 200, body: { id: "m_after_retry" } },
    ]);
    const out = await new FlyEvalDispatcher({ ...CFG, maxAttempts: 3 }).dispatch("r", "a");
    expect(out.machineId).toBe("m_after_retry");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 4xx (bad token/config) and surfaces the error", async () => {
    const { calls } = stubFetch([{ status: 401, body: { error: "unauthorized" } }]);
    await expect(new FlyEvalDispatcher(CFG).dispatch("r", "a")).rejects.toThrow(/401|unauthorized/);
    expect(calls).toHaveLength(1); // no retry
  });
});

describe("flyDispatchFromEnv", () => {
  it("returns null unless FLY_API_TOKEN + FLY_WORKER_APP + FLY_WORKER_IMAGE are all set", () => {
    expect(flyDispatchFromEnv({})).toBeNull();
    expect(flyDispatchFromEnv({ FLY_API_TOKEN: "t" })).toBeNull();
    expect(flyDispatchFromEnv({ FLY_API_TOKEN: "t", FLY_WORKER_APP: "a" })).toBeNull();
    const cfg = flyDispatchFromEnv({
      FLY_API_TOKEN: "t",
      FLY_WORKER_APP: "a",
      FLY_WORKER_IMAGE: "img",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.co",
    });
    expect(cfg?.appName).toBe("a");
    // Least-privilege: the worker gets no Supabase coordinates at all.
    expect(cfg?.workerEnv).not.toHaveProperty("SUPABASE_URL");
    expect(cfg?.workerEnv?.OUTERLAYER_E2B_ENABLED).toBe("1");
  });

  it("resolves the worker's gateway URL: explicit EVAL_GATEWAY_URL wins, else the public API URL, else absent", () => {
    const base = { FLY_API_TOKEN: "t", FLY_WORKER_APP: "a", FLY_WORKER_IMAGE: "img" };
    expect(
      flyDispatchFromEnv({ ...base, EVAL_GATEWAY_URL: "https://gw.example.com", NEXT_PUBLIC_API_URL: "https://api.example.com" })
        ?.workerEnv?.EVAL_GATEWAY_URL,
    ).toBe("https://gw.example.com");
    expect(
      flyDispatchFromEnv({ ...base, NEXT_PUBLIC_API_URL: "https://api.example.com" })?.workerEnv?.EVAL_GATEWAY_URL,
    ).toBe("https://api.example.com");
    expect(flyDispatchFromEnv(base)?.workerEnv).not.toHaveProperty("EVAL_GATEWAY_URL");
  });
});
