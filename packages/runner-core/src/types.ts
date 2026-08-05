// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The SandboxProvider seam.
 *
 * The harness (checkout → agent → grade) is written ONCE against this
 * interface; local Docker, Fly Machines, and managed microVM vendors
 * are config choices. Every provider must pass the conformance suite in
 * `conformance.ts` — that suite, not this comment, is the contract's teeth.
 *
 * Semantics (normative):
 * - `prepareEnv` is idempotent, keyed by the CALLER-supplied `spec.key`
 *   (the caller computes content hashes; providers never guess). A cache hit must
 *   not re-run `build`.
 * - `exec` NEVER throws on nonzero exit — the exit code is data. It throws
 *   only on provider/transport failure. Output capture is bounded; the
 *   `truncated` flag says so. A timeout yields `code: 124, timedOut: true`
 *   and may leave the process running — trials always `destroy` after.
 * - Secrets travel ONLY via per-exec `ExecOpts.env`. Nothing secret may be
 *   baked into `EnvSpec`, image layers, or sandbox-level config, where it
 *   would survive into snapshots and `inspect` surfaces (leak-tested).
 * - `destroy` is idempotent — always safe to call twice, or on a sandbox
 *   that died. `list` returns only THIS provider's outerlayer-labeled
 *   sandboxes; it is the reaper's view of the world.
 * - `network: 'none'` must block ALL egress (grade phase). `'default'` is
 *   the provider's standard egress (agent phase). True allowlisting is a
 *   Fly-egress follow-up — the gap is documented, not faked.
 */
export interface SandboxProvider {
  /** Stable provider id (`local-docker`, `fly`, …) — appears in EnvRef,
   * Sandbox, and telemetry. */
  readonly id: string;
  prepareEnv(spec: EnvSpec): Promise<EnvRef>;
  create(env: EnvRef, opts?: SandboxOpts): Promise<Sandbox>;
  exec(sandbox: Sandbox, cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  putFiles(sandbox: Sandbox, files: FileMap): Promise<void>;
  /** Binary-safe read; callers `toString()` when they know it's text. */
  getFile(sandbox: Sandbox, path: string): Promise<Buffer>;
  destroy(sandbox: Sandbox): Promise<void>;
  list(): Promise<SandboxInfo[]>;
  /** Resolve an image reference to a stable content digest, when the
   * provider can. Optional capability: the task-format gate records it into the task's
   * `determinism` block; absence just means the digest goes unrecorded. */
  resolveImageDigest?(imageRef: string): Promise<string | undefined>;
}

/** Environment build request. `build` runs caller logic (clone, checkout,
 * setup, health probe) inside a scratch sandbox booted from `baseImage`;
 * the provider snapshots the result under `key`. */
export interface EnvSpec {
  /** Content hash from the caller — e.g. hash(repo, commit, setup, image). */
  key: string;
  /** Provider-pullable image reference (e.g. `alpine:3.20`). */
  baseImage: string;
  build?: (sandbox: Sandbox, provider: SandboxProvider) => Promise<void>;
  /** Resources for the build sandbox (not inherited by trial sandboxes). */
  buildOpts?: SandboxOpts;
}

export interface EnvRef {
  key: string;
  /** Provider-resolvable image reference for `create`. */
  imageRef: string;
  providerId: string;
  createdAt: string;
  /** True when this call built the env; false on cache hit. */
  built: boolean;
}

export interface Sandbox {
  id: string;
  providerId: string;
  envKey: string;
  createdAt: string;
}

export interface SandboxInfo extends Sandbox {
  ageMs: number;
}

export type NetworkMode = "none" | "default";

export interface SandboxOpts {
  cpus?: number;
  memMb?: number;
  /** Fork-bomb containment; providers must enforce, not advise. */
  pidsLimit?: number;
  network?: NetworkMode;
  /** Extra labels; providers add their own ownership + created-at labels. */
  labels?: Record<string, string>;
}

export interface ExecOpts {
  timeoutMs?: number;
  cwd?: string;
  /** Per-exec environment — the ONLY sanctioned secrets path. */
  env?: Record<string, string>;
  /** Per-stream capture bound in bytes (default 1 MiB). */
  maxOutputBytes?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  truncated: boolean;
  timedOut: boolean;
}

/** Absolute in-sandbox path → contents. Parent directories are created. */
export type FileMap = Record<string, string | Buffer>;

/** Ownership labels shared by all providers (the reaper keys off these). */
export const SANDBOX_LABELS = {
  owner: "outerlayer-trial",
  createdAt: "outerlayer-created-at",
  envKey: "outerlayer-env-key",
} as const;

export class SandboxProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`);
    this.name = "SandboxProviderError";
  }
}
