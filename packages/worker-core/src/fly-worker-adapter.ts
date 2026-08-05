/**
 * FlyWorkerAdapter — WorkerDispatchAdapter over the Fly Machines API.
 *
 * Stash the params payload in Vault behind a one-time token, then create ONE
 * auto-destroying machine from the prebuilt worker image whose config
 * carries only the token — never a secret (machine config is readable by
 * anyone holding FLY_API_TOKEN).
 *
 * Differences from the build machine, both deliberate:
 *   - guest sizing: shared-cpu-2x / 4096 MB — coding agents clone repos,
 *     install packages, and run toolchains; the 1x/1024 build sizing starves
 *     them.
 *   - restart policy "no": an agent run is never re-executed automatically —
 *     retries are a user decision, and the at-least-once contract already
 *     tolerates duplicate dispatch.
 */

import {
  WorkerDispatchError,
  workerTokenVaultName,
  type WorkerDispatchAdapter,
  type WorkerDispatchParams,
  type WorkerDispatchResult,
} from "./worker-adapter";
import type { Logger, SupabaseClientType } from "./types";

export const FLY_MACHINES_API_BASE = "https://api.machines.dev/v1";

export const WORKER_MACHINE_GUEST = {
  cpu_kind: "shared",
  cpus: 2,
  memory_mb: 4096,
} as const;

/**
 * Persistent-environment volume. The workspace, the agent's
 * HOME (session files for --resume), everything durable lives on the volume:
 * a stopped Machine's rootfs is NOT guaranteed across restarts, and the
 * design's only substrate requirements are durable disk + fast wake — no
 * memory snapshot.
 */
export const WORKER_VOLUME_MOUNT_PATH = "/data";
export const WORKER_VOLUME_SIZE_GB = 10;

/** Deterministic names so teardown can find both even with lost refs. */
export function workerEnvMachineName(envId: string): string {
  return `worker-env-${envId.slice(0, 8)}`;
}
export function workerEnvVolumeName(envId: string): string {
  return `worker_env_${envId.slice(0, 8).replace(/-/g, "")}`;
}

export interface FlyWorkerAdapterDeps {
  /** Only for insert_secret/delete_secret RPCs (HTTP — Workers-safe). */
  supabase: SupabaseClientType;
  logger: Logger;
  /** Absent → WorkerDispatchError("misconfigured") at dispatch time. */
  flyApiToken?: string;
  /** Fly app that hosts worker machines. */
  workerApp: string;
  /** Full image ref; defaults to the app's :latest registry image. */
  workerImage?: string;
  /** Where the machine fetches its params payload at boot. */
  appUrl: string;
  region?: string;
}

export class FlyWorkerAdapter implements WorkerDispatchAdapter {
  constructor(private readonly deps: FlyWorkerAdapterDeps) {}

  async triggerWorker(params: WorkerDispatchParams): Promise<WorkerDispatchResult> {
    const { workerRunId, appId, workerPayload } = params;
    const logger = this.deps.logger.withAppId(appId);

    if (!this.deps.flyApiToken) {
      // Deliberately generic: failure_code/error surface to tenants and must
      // not name missing infra env vars.
      throw new WorkerDispatchError(
        "misconfigured",
        "Worker service is not configured. Please contact support.",
        workerRunId,
      );
    }

    const workerToken = crypto.randomUUID();
    const tokenVaultName = workerTokenVaultName(workerRunId);
    const { error: vaultError } = await this.deps.supabase.rpc("insert_secret", {
      name: tokenVaultName,
      secret: JSON.stringify({ token: workerToken, payload: workerPayload }),
    });
    if (vaultError) {
      throw new WorkerDispatchError(
        "dispatch-failed",
        `Failed to stage worker params: ${vaultError.message}`,
        workerRunId,
      );
    }

    try {
      const machineId = params.persistentMachine
        ? await this.ensurePersistentTurnMachine(
            workerRunId,
            workerToken,
            params.persistentMachine,
          )
        : await this.createEphemeralWorkerMachine(workerRunId, workerToken);
      await logger.info("Dispatched worker machine", {
        workerRunId,
        machineId,
        persistent: Boolean(params.persistentMachine),
      });
      return { dispatchId: crypto.randomUUID(), machineId };
    } catch (error) {
      // The machine never launched; the staged params are unreachable garbage.
      try {
        await this.deps.supabase.rpc("delete_secret", { secret_name: tokenVaultName });
      } catch {
        // Best-effort cleanup — the dispatch error below is what matters.
      }
      throw error;
    }
  }

  /**
   * Persistent turn: reuse the environment's machine when it exists (refresh
   * the per-turn env, start), else create the durable machine + its volume.
   */
  private async ensurePersistentTurnMachine(
    workerRunId: string,
    workerToken: string,
    persistent: { machineRef: string | null; envId: string },
  ): Promise<string> {
    if (persistent.machineRef) {
      await this.refreshMachineEnv(workerRunId, persistent.machineRef, workerToken);
      await this.startMachine(workerRunId, persistent.machineRef);
      return persistent.machineRef;
    }
    return this.createPersistentWorkerMachine(workerRunId, workerToken, persistent.envId);
  }

  /** Create the environment's volume, then its machine mounted on it. */
  private async createPersistentWorkerMachine(
    workerRunId: string,
    workerToken: string,
    envId: string,
  ): Promise<string> {
    const volume = await this.flyFetch(
      workerRunId,
      "POST",
      `/apps/${this.deps.workerApp}/volumes`,
      {
        name: workerEnvVolumeName(envId),
        size_gb: WORKER_VOLUME_SIZE_GB,
        ...(this.deps.region ? { region: this.deps.region } : {}),
      },
    );
    const volumeId = (volume as { id?: string }).id;
    if (!volumeId) {
      throw new WorkerDispatchError(
        "dispatch-failed",
        "Worker volume create returned no volume id",
        workerRunId,
      );
    }

    try {
      const machine = await this.flyFetch(
        workerRunId,
        "POST",
        `/apps/${this.deps.workerApp}/machines`,
        {
          name: workerEnvMachineName(envId),
          ...(this.deps.region ? { region: this.deps.region } : {}),
          config: {
            image: this.image(),
            env: this.turnEnv(workerRunId, workerToken),
            guest: WORKER_MACHINE_GUEST,
            // The machine IS the environment's durable compute: never
            // auto-destroy, never auto-restart; the runner exits after each
            // turn and the machine stops until the next one.
            auto_destroy: false,
            restart: { policy: "no" },
            mounts: [{ volume: volumeId, path: WORKER_VOLUME_MOUNT_PATH }],
          },
        },
      );
      const machineId = (machine as { id?: string }).id;
      if (!machineId) {
        throw new WorkerDispatchError(
          "dispatch-failed",
          "Worker machine create returned no machine id",
          workerRunId,
        );
      }
      return machineId;
    } catch (error) {
      // The machine never materialized — don't leak the volume.
      try {
        await this.flyFetch(
          workerRunId,
          "DELETE",
          `/apps/${this.deps.workerApp}/volumes/${volumeId}`,
        );
      } catch {
        // Best-effort; the create error below is what matters.
      }
      throw error;
    }
  }

  /** Stopped machines keep their config — swap in this turn's one-time env. */
  private async refreshMachineEnv(
    workerRunId: string,
    machineId: string,
    workerToken: string,
  ): Promise<void> {
    const machine = (await this.flyFetch(
      workerRunId,
      "GET",
      `/apps/${this.deps.workerApp}/machines/${machineId}`,
    )) as { config?: Record<string, unknown> };
    if (!machine.config) {
      throw new WorkerDispatchError(
        "dispatch-failed",
        "Worker machine has no config to update",
        workerRunId,
      );
    }
    await this.flyFetch(
      workerRunId,
      "POST",
      `/apps/${this.deps.workerApp}/machines/${machineId}`,
      {
        config: {
          ...machine.config,
          env: {
            ...(machine.config.env as Record<string, string> | undefined),
            ...this.turnEnv(workerRunId, workerToken),
          },
        },
      },
    );
  }

  private async startMachine(workerRunId: string, machineId: string): Promise<void> {
    await this.flyFetch(
      workerRunId,
      "POST",
      `/apps/${this.deps.workerApp}/machines/${machineId}/start`,
    );
  }

  private image(): string {
    return this.deps.workerImage ?? `registry.fly.io/${this.deps.workerApp}:latest`;
  }

  private turnEnv(workerRunId: string, workerToken: string): Record<string, string> {
    // ONLY non-secret values ride in config.env.
    return {
      WORKER_TOKEN: workerToken,
      WORKER_RUN_ID: workerRunId,
      DASHBOARD_URL: this.deps.appUrl,
    };
  }

  /** Machines-API fetch with the adapter's uniform error taxonomy. */
  private async flyFetch(
    workerRunId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${FLY_MACHINES_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.deps.flyApiToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new WorkerDispatchError(
        "unavailable",
        `Worker machine API unreachable: ${error instanceof Error ? error.message : String(error)}`,
        workerRunId,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new WorkerDispatchError(
        "dispatch-failed",
        `Worker machine API ${method} ${path} failed (${response.status}): ${detail.slice(0, 500)}`,
        workerRunId,
      );
    }
    return response.json().catch(() => ({}));
  }

  private async createEphemeralWorkerMachine(
    workerRunId: string,
    workerToken: string,
  ): Promise<string> {
    const image =
      this.deps.workerImage ?? `registry.fly.io/${this.deps.workerApp}:latest`;

    let response: Response;
    try {
      response = await fetch(
        `${FLY_MACHINES_API_BASE}/apps/${this.deps.workerApp}/machines`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.deps.flyApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `worker-${workerRunId.slice(0, 8)}`,
            ...(this.deps.region ? { region: this.deps.region } : {}),
            config: {
              image,
              env: {
                // ONLY non-secret values ride in config.env.
                WORKER_TOKEN: workerToken,
                WORKER_RUN_ID: workerRunId,
                DASHBOARD_URL: this.deps.appUrl,
              },
              guest: WORKER_MACHINE_GUEST,
              auto_destroy: true,
              restart: { policy: "no" },
            },
          }),
        },
      );
    } catch (error) {
      throw new WorkerDispatchError(
        "unavailable",
        `Worker machine API unreachable: ${error instanceof Error ? error.message : String(error)}`,
        workerRunId,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new WorkerDispatchError(
        "dispatch-failed",
        `Worker machine create failed (${response.status}): ${detail.slice(0, 500)}`,
        workerRunId,
      );
    }

    const machine = (await response.json()) as { id?: string };
    if (!machine.id) {
      throw new WorkerDispatchError(
        "dispatch-failed",
        "Worker machine create returned no machine id",
        workerRunId,
      );
    }
    return machine.id;
  }
}

/**
 * Destroy a worker machine (cancel / reaper). Idempotent: 404 means it's
 * already gone (auto_destroy fired) and is treated as success.
 */
export async function destroyWorkerMachine(opts: {
  flyApiToken: string;
  workerApp: string;
  machineId: string;
  baseUrl?: string;
}): Promise<void> {
  const base = opts.baseUrl ?? FLY_MACHINES_API_BASE;
  const response = await fetch(
    `${base}/apps/${opts.workerApp}/machines/${opts.machineId}?force=true`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.flyApiToken}` },
    },
  );
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Worker machine destroy failed (${response.status}): ${detail.slice(0, 300)}`,
    );
  }
}

/**
 * Stop a persistent environment's machine (cancel mid-turn / idle suspend).
 * Idempotent: 404 (gone) and "already stopped" responses are success.
 */
export async function stopWorkerMachine(opts: {
  flyApiToken: string;
  workerApp: string;
  machineId: string;
  baseUrl?: string;
}): Promise<void> {
  const base = opts.baseUrl ?? FLY_MACHINES_API_BASE;
  const response = await fetch(
    `${base}/apps/${opts.workerApp}/machines/${opts.machineId}/stop`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.flyApiToken}` },
    },
  );
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    if (/already|stopped/i.test(detail)) return;
    throw new Error(
      `Worker machine stop failed (${response.status}): ${detail.slice(0, 300)}`,
    );
  }
}

/**
 * Tear down a persistent environment's durable compute: its machine and its
 * volume. Finds both by their deterministic env-derived names so teardown
 * works even when machine_ref was never recorded (create-failure paths).
 * Idempotent throughout — absent resources are success.
 */
export async function destroyPersistentWorkerEnvironment(opts: {
  flyApiToken: string;
  workerApp: string;
  envId: string;
  machineId?: string | null;
  baseUrl?: string;
}): Promise<void> {
  const base = opts.baseUrl ?? FLY_MACHINES_API_BASE;
  const headers = { Authorization: `Bearer ${opts.flyApiToken}` };

  // 1. The machine: by recorded ref, else by deterministic name.
  let machineId = opts.machineId ?? null;
  if (!machineId) {
    const list = await fetch(`${base}/apps/${opts.workerApp}/machines`, { headers });
    if (list.ok) {
      const machines = (await list.json().catch(() => [])) as Array<{ id: string; name?: string }>;
      machineId = machines.find((m) => m.name === workerEnvMachineName(opts.envId))?.id ?? null;
    }
  }
  if (machineId) {
    await destroyWorkerMachine({
      flyApiToken: opts.flyApiToken,
      workerApp: opts.workerApp,
      machineId,
      baseUrl: opts.baseUrl,
    });
  }

  // 2. The volume, by deterministic name. (A volume can only be deleted once
  // its machine is gone, hence the ordering.)
  const volumes = await fetch(`${base}/apps/${opts.workerApp}/volumes`, { headers });
  if (!volumes.ok) {
    if (volumes.status === 404) return;
    const detail = await volumes.text().catch(() => "");
    throw new Error(
      `Worker volume list failed (${volumes.status}): ${detail.slice(0, 300)}`,
    );
  }
  const volumeList = (await volumes.json().catch(() => [])) as Array<{ id: string; name?: string }>;
  const volume = volumeList.find((v) => v.name === workerEnvVolumeName(opts.envId));
  if (!volume) return;
  const del = await fetch(`${base}/apps/${opts.workerApp}/volumes/${volume.id}`, {
    method: "DELETE",
    headers,
  });
  if (!del.ok && del.status !== 404) {
    const detail = await del.text().catch(() => "");
    throw new Error(
      `Worker volume destroy failed (${del.status}): ${detail.slice(0, 300)}`,
    );
  }
}
