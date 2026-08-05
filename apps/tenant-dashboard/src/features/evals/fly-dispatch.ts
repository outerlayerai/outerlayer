import "server-only";

/**
 * Fly Machines dispatch for eval runs.
 *
 * Production executor = one ephemeral Fly Machine per run. `flyDispatchFromEnv`
 * builds the Machine config and `FlyEvalDispatcher` starts a run-once worker
 * Machine with `auto_destroy: true` and the run's coordinates in its env
 * (`EvalRunService.dispatch` in service.ts is the caller, once the queued
 * `eval_run` row exists). The worker fetches its job from the GATEWAY, runs the
 * eval on E2B, persists results, reports the terminal status, and exits — the
 * Machine self-destructs, so idle cost is $0. Mirrors the proven Fly Machines
 * Fly Machines REST conventions (Bearer auth, api.machines.dev/v1).
 *
 * Secrets: the worker holds NO database credential. Its only secret is
 * EVAL_GATEWAY_KEY — the per-run gateway key in the Machine env (scoped,
 * env-bound, 24h expiry, revoked by the gateway at terminal status). Machine
 * config is readable by FLY_API_TOKEN holders; what a reader gains is that one
 * run's self-destructing credential, never a service role. E2B creds remain
 * Fly APP secrets (`fly secrets set`).
 */

export interface FlyDispatchConfig {
  apiToken: string;
  appName: string;
  image: string;
  region?: string;
  /** Non-secret worker env: where to reach Supabase + which E2B template. */
  workerEnv?: Record<string, string>;
  baseUrl?: string;
  /** Retry attempts on transient Machines-API failures (capacity/5xx). */
  maxAttempts?: number;
}

/** Build dispatch config from env, or null when the Fly path isn't configured
 * (the caller then falls back to the local EVAL_EXECUTOR_URL executor). */
export function flyDispatchFromEnv(
  env: Record<string, string | undefined> = process.env,
): FlyDispatchConfig | null {
  const apiToken = env.FLY_API_TOKEN;
  const appName = env.FLY_WORKER_APP;
  const image = env.FLY_WORKER_IMAGE;
  if (!apiToken || !appName || !image) return null;
  return {
    apiToken,
    appName,
    image,
    region: env.FLY_WORKER_REGION,
    baseUrl: env.FLY_MACHINES_API,
    workerEnv: {
      ...(env.OUTERLAYER_E2B_TEMPLATE ? { OUTERLAYER_E2B_TEMPLATE: env.OUTERLAYER_E2B_TEMPLATE } : {}),
      // The worker's entire control plane: job read, status reporting,
      // escalations, and trial/session persistence all go through the
      // gateway — the worker holds no database credential and receives no
      // Supabase URL. Unset ⇒ the caller refuses to dispatch.
      ...(env.EVAL_GATEWAY_URL ?? env.NEXT_PUBLIC_API_URL
        ? { EVAL_GATEWAY_URL: (env.EVAL_GATEWAY_URL ?? env.NEXT_PUBLIC_API_URL)! }
        : {}),
      OUTERLAYER_E2B_ENABLED: "1",
    },
  };
}

interface FlyMachine {
  id: string;
  state?: string;
}

export class FlyEvalDispatcher {
  private readonly baseUrl: string;
  private readonly maxAttempts: number;

  constructor(private readonly cfg: FlyDispatchConfig) {
    this.baseUrl = cfg.baseUrl ?? "https://api.machines.dev/v1";
    this.maxAttempts = cfg.maxAttempts ?? 3;
  }

  /** Start a run-once worker Machine for `runId`. Returns the Machine id.
   * Retries transient Machines-API errors (capacity/5xx) with backoff.
   * `extraEnv` carries the run's own coordinates — including EVAL_GATEWAY_KEY,
   * the per-run gateway key that is the worker's ONLY credential. */
  async dispatch(
    runId: string,
    appId: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ machineId: string }> {
    const body = {
      ...(this.cfg.region ? { region: this.cfg.region } : {}),
      config: {
        image: this.cfg.image,
        auto_destroy: true,
        restart: { policy: "on-failure", max_retries: 2 },
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
        // Machine config is readable by Fly-token holders. The invariant: it
        // carries AT MOST the run's own scoped, 24h, terminal-status-revoked
        // key — never an app secret, never a service role, never a model
        // key. Those live in Fly APP secrets (E2B) or per-exec sandbox env
        // (model keys), not here.
        env: { RUN_ID: runId, EVAL_APP_ID: appId, ...(this.cfg.workerEnv ?? {}), ...extraEnv },
      },
    };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const machine = await this.request<FlyMachine>(
          "POST",
          `/apps/${this.cfg.appName}/machines`,
          body,
        );
        return { machineId: machine.id };
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === this.maxAttempts) break;
        await sleep(250 * attempt);
      }
    }
    throw new Error(
      `Fly dispatch failed after ${this.maxAttempts} attempt(s): ${message(lastErr)}`,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new FlyDispatchError(`network error: ${message(err)}`, 0);
    }
    if (!res.ok) {
      let detail: string;
      try {
        detail = ((await res.json()) as { error?: string }).error ?? res.statusText;
      } catch {
        detail = res.statusText;
      }
      throw new FlyDispatchError(`${method} ${path} → ${res.status}: ${detail}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

class FlyDispatchError extends Error {
  constructor(message: string, readonly status: number) {
    super(`Fly Machines API: ${message}`);
    this.name = "FlyDispatchError";
  }
}

/** Capacity + 5xx are worth retrying (possibly a different host/region); 4xx
 * (bad token/config) is not. Network errors (status 0) are transient. */
function isTransient(err: unknown): boolean {
  const status = err instanceof FlyDispatchError ? err.status : 0;
  return status === 0 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
