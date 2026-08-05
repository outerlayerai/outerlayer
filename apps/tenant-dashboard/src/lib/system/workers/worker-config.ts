import "server-only";

import { WORKER_VOLUME_MOUNT_PATH } from "@repo/worker-core";

/**
 * Cloud-worker compute configuration, read raw from the
 * environment — mirrors the eval dispatcher's `flyDispatchFromEnv` rather than
 * the strict env.ts validation, so a dev machine with no Fly config
 * transparently falls back to local dispatch.
 *
 * When `CLOUD_WORKER_APP` + `FLY_API_TOKEN` are present the run goes to an
 * ephemeral Fly machine; otherwise it runs as a local child process
 * (apps/worker via tsx), which is how the full flow is exercised in local dev
 * and CI without any Fly credentials.
 */

export interface FlyWorkerConfig {
  flyApiToken: string;
  workerApp: string;
  workerImage?: string;
  region?: string;
}

export function flyWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): FlyWorkerConfig | null {
  const flyApiToken = env.FLY_API_TOKEN;
  const workerApp = env.CLOUD_WORKER_APP;
  if (!flyApiToken || !workerApp) return null;
  return {
    flyApiToken,
    workerApp,
    workerImage: env.CLOUD_WORKER_IMAGE,
    region: env.CLOUD_WORKER_REGION,
  };
}

/**
 * Durable paths on a persistent environment's Fly volume (mounted at
 * WORKER_VOLUME_MOUNT_PATH). The workspace and the agent's HOME (session
 * files for --resume) both live on the volume: the machine's rootfs is not
 * guaranteed across stop/start.
 */
export const FLY_WORKER_WORKSPACE_PATH = `${WORKER_VOLUME_MOUNT_PATH}/workspace`;
export const FLY_WORKER_AGENT_HOME = `${WORKER_VOLUME_MOUNT_PATH}/home`;

/** Default worker diff/log caps; overridable per-env later. */
export const WORKER_CAPS = {
  max_diff_files: 200,
  max_diff_bytes: 5 * 1024 * 1024,
  max_raw_log_chars: 200_000,
} as const;

export const DEFAULT_WALL_CLOCK_CAP_S = 1800;
