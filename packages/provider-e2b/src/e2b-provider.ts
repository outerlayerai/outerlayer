// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * E2BProvider — a SandboxProvider backed by E2B's official SDK
 * (`import { Sandbox } from 'e2b'`, v2.x), Firecracker microVM isolation.
 * Satisfies the SandboxProvider seam so the harness (checkout → agent → grade) runs
 * unchanged on a managed vendor.
 *
 * Env model — the point of E2B 2.x: `prepareEnv` runs the build ONCE in a
 * scratch sandbox and `createSnapshot()`s the result into a persistent image;
 * `create` boots N independent sandboxes from that snapshot. This is the native
 * equivalent of LocalDocker's `container.commit()`, so the built dependencies
 * live in the image and are present even in OFFLINE grade sandboxes — no
 * install-time network needed. Snapshots are stored images (storage quota), so
 * they're deleted via `cleanupEnvImage` when the env is retired.
 *
 * SDK realities, handled honestly:
 *  - `commands.run` THROWS `CommandExitError` on nonzero exit; our contract says
 *    the exit code is DATA, so we catch it. Timeouts we own with a race (code
 *    124) rather than depending on the SDK's error type.
 *  - No per-`create` cpu/mem/pid knob: cpu/mem are template-level (no-ops here);
 *    `pidsLimit` is enforced via `ulimit -u` at exec time.
 *  - `network:'none'` ⇒ `allowInternetAccess:false` (verified offline, grade
 *    phase). `'default'` ⇒ open egress (agent phase). Fine-grained host
 *    allowlisting is a documented follow-up, not faked.
 *
 * Secrets ride ONLY per-exec `ExecOpts.env` (→ `commands.run` `envs`), never
 * sandbox metadata or create config, so they never survive into `list`/inspect
 * or the snapshot image.
 */

import { Sandbox, CommandExitError } from "e2b";
import {
  SANDBOX_LABELS,
  SandboxProviderError,
  type EnvRef,
  type EnvSpec,
  type ExecOpts,
  type ExecResult,
  type FileMap,
  type Sandbox as OlSandbox,
  type SandboxInfo,
  type SandboxOpts,
  type SandboxProvider,
} from "@outerlayer/runner-core";

const DEFAULT_MAX_OUTPUT = 1024 * 1024; // 1 MiB per stream
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The slice of the E2B SDK the provider uses, narrowed to an injectable seam so
 * the adapter logic is unit-testable without a live account. The default binds
 * the real `Sandbox` statics (v2.x).
 */
export interface E2BSandboxHandle {
  readonly sandboxId: string;
  readonly commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; user?: string; envs?: Record<string, string>; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  readonly files: {
    write(path: string, data: string | ArrayBuffer, opts?: { user?: string }): Promise<unknown>;
    read(path: string, opts?: { format?: "text" | "bytes" }): Promise<string | Uint8Array>;
    makeDir(path: string, opts?: { user?: string }): Promise<unknown>;
  };
  createSnapshot(opts?: { name?: string }): Promise<{ snapshotId: string }>;
  kill(): Promise<unknown>;
}

export interface E2BListedSandbox {
  sandboxId: string;
  metadata?: Record<string, string>;
  startedAt?: Date | string;
}

export interface E2BApi {
  create(template: string, opts: E2BCreateOpts): Promise<E2BSandboxHandle>;
  /** Drained to a flat array by the caller; the real impl walks the paginator. */
  list(opts?: { apiKey?: string; metadata?: Record<string, string> }): Promise<E2BListedSandbox[]>;
  kill(sandboxId: string, opts?: { apiKey?: string }): Promise<boolean>;
  deleteSnapshot(snapshotId: string, opts?: { apiKey?: string }): Promise<boolean>;
}

export interface E2BCreateOpts {
  apiKey: string;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  allowInternetAccess?: boolean;
}

export interface E2BProviderOptions {
  apiKey: string;
  /** E2B template every env snapshots FROM (default `base`). For real evals,
   * a custom toolchain template (python/pytest/git/node/claude/codex). */
  template?: string;
  /** Sandbox TTL; also the ceiling for a single trial (default 300 s). */
  defaultTimeoutMs?: number;
  /** User every command runs as — root for LocalDocker parity. */
  defaultUser?: string;
  /** Injection seam for tests; defaults to the real `e2b` SDK statics. */
  api?: E2BApi;
}

const realApi: E2BApi = {
  create: (template, opts) =>
    Sandbox.create(template, opts) as unknown as Promise<E2BSandboxHandle>,
  list: async (opts) => {
    const paginator = Sandbox.list({
      apiKey: opts?.apiKey,
      ...(opts?.metadata ? { query: { metadata: opts.metadata } } : {}),
    } as never);
    const out: E2BListedSandbox[] = [];
    while (paginator.hasNext) out.push(...((await paginator.nextItems()) as unknown as E2BListedSandbox[]));
    return out;
  },
  kill: (sandboxId, opts) => Sandbox.kill(sandboxId, opts),
  deleteSnapshot: (snapshotId, opts) => Sandbox.deleteSnapshot(snapshotId, opts),
};

export class E2BProvider implements SandboxProvider {
  readonly id = "e2b";
  private readonly template: string;
  private readonly timeoutMs: number;
  private readonly user: string;
  private readonly api: E2BApi;
  /** env key → imageRef (snapshot id, or a template name for no-build envs). */
  private readonly envSnapshots = new Map<string, string>();
  /** imageRefs we CREATED via createSnapshot — the only ones safe to delete. */
  private readonly ownedSnapshots = new Set<string>();
  /** Live handles by sandbox id, so `exec`/`destroy` reach the real object. */
  private readonly handles = new Map<string, E2BSandboxHandle>();
  /** Per-sandbox create opts, for `pidsLimit` enforcement at exec time. */
  private readonly sandboxOpts = new Map<string, SandboxOpts>();

  constructor(private readonly options: E2BProviderOptions) {
    if (!options.apiKey) throw new Error("E2BProvider requires an apiKey (E2B_API_KEY)");
    this.template = options.template ?? "base";
    this.timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.user = options.defaultUser ?? "root";
    this.api = options.api ?? realApi;
  }

  /**
   * Build the env ONCE in a scratch sandbox and snapshot it under `spec.key`.
   * A cache hit (key already snapshotted) skips the build. When there's no
   * build recipe, the env IS the base template (nothing to snapshot).
   */
  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    const cached = this.envSnapshots.get(spec.key);
    if (cached) return this.envRef(spec.key, cached, false);
    if (!spec.build) {
      // No build: mark the key seen so a repeat reports built:false, and boot
      // the base template directly.
      const base = spec.baseImage || this.template;
      this.envSnapshots.set(spec.key, base);
      return this.envRef(spec.key, base, true);
    }

    const buildSandbox = await this.boot(spec.baseImage || this.template, spec.key, spec.buildOpts ?? {});
    let snapshotId: string;
    try {
      await spec.build(this.olSandbox(buildSandbox.sandboxId, spec.key), this);
      const snap = await buildSandbox.createSnapshot();
      snapshotId = snap.snapshotId;
    } finally {
      await this.killHandle(buildSandbox);
    }
    this.envSnapshots.set(spec.key, snapshotId);
    this.ownedSnapshots.add(snapshotId);
    return this.envRef(spec.key, snapshotId, true);
  }

  async create(env: EnvRef, opts: SandboxOpts = {}): Promise<OlSandbox> {
    // env.imageRef is a snapshot id (built env) or a template name (no build).
    const handle = await this.boot(env.imageRef || this.template, env.key, opts);
    return this.olSandbox(handle.sandboxId, env.key);
  }

  private async boot(templateOrSnapshot: string, envKey: string, opts: SandboxOpts): Promise<E2BSandboxHandle> {
    let handle: E2BSandboxHandle;
    try {
      handle = await this.api.create(templateOrSnapshot, {
        apiKey: this.options.apiKey,
        // Secrets NEVER go here — only ownership/routing labels.
        metadata: {
          [SANDBOX_LABELS.owner]: "1",
          [SANDBOX_LABELS.envKey]: envKey,
          [SANDBOX_LABELS.createdAt]: new Date().toISOString(),
          ...(opts.labels ?? {}),
        },
        timeoutMs: this.timeoutMs,
        // network:'none' ⇒ fully offline (grade phase); 'default' ⇒ open egress.
        allowInternetAccess: (opts.network ?? "default") !== "none",
      });
    } catch (err) {
      throw new SandboxProviderError(`create failed for ${templateOrSnapshot}`, this.id, err);
    }
    this.handles.set(handle.sandboxId, handle);
    this.sandboxOpts.set(handle.sandboxId, opts);
    return handle;
  }

  async exec(sandbox: OlSandbox, cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const handle = this.handle(sandbox);
    const started = Date.now();
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

    // pidsLimit is not an E2B create knob; enforce it inside the shell so the
    // fork-bomb containment contract holds (ulimit caps this process tree).
    const pids = this.sandboxOpts.get(sandbox.id)?.pidsLimit;
    const wrapped = pids ? `ulimit -u ${pids} 2>/dev/null; ${cmd}` : cmd;

    // We own the timeout: race the run against a timer so a hang deterministically
    // yields code 124 + timedOut. The command may keep running — callers destroy.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = opts.timeoutMs
      ? new Promise<"__timeout__">((resolve) => {
          timer = setTimeout(() => resolve("__timeout__"), opts.timeoutMs);
        })
      : null;

    const run = handle.commands
      .run(wrapped, { cwd: opts.cwd, user: this.user, envs: opts.env })
      .then((r) => ({ ok: true as const, r }))
      .catch((err: unknown) => {
        if (err instanceof CommandExitError) return { ok: true as const, r: err };
        return { ok: false as const, err };
      });

    try {
      const outcome = timeout ? await Promise.race([run, timeout]) : await run;
      if (outcome === "__timeout__") {
        return { code: 124, stdout: "", stderr: "[exec timed out]", ms: Date.now() - started, truncated: false, timedOut: true };
      }
      if (!outcome.ok) throw new SandboxProviderError(`exec failed`, this.id, outcome.err);
      const [stdout, outTrunc] = bound(outcome.r.stdout ?? "", maxBytes);
      const [stderr, errTrunc] = bound(outcome.r.stderr ?? "", maxBytes);
      return {
        code: outcome.r.exitCode ?? 0,
        stdout,
        stderr,
        ms: Date.now() - started,
        truncated: outTrunc || errTrunc,
        timedOut: false,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async putFiles(sandbox: OlSandbox, files: FileMap): Promise<void> {
    const handle = this.handle(sandbox);
    try {
      // Write as the same user `exec` runs as (root), so files are owned
      // consistently — otherwise root git/test commands reject user-owned files
      // ("detected dubious ownership").
      const owner = { user: this.user };
      for (const [path, content] of Object.entries(files)) {
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir) await handle.files.makeDir(dir, owner).catch(() => {}); // parents (idempotent)
        const data: string | ArrayBuffer =
          typeof content === "string" ? content : toArrayBuffer(content);
        await handle.files.write(path, data, owner);
      }
    } catch (err) {
      throw new SandboxProviderError(`putFiles failed`, this.id, err);
    }
  }

  async getFile(sandbox: OlSandbox, path: string): Promise<Buffer> {
    try {
      const bytes = (await this.handle(sandbox).files.read(path, { format: "bytes" })) as Uint8Array;
      return Buffer.from(bytes);
    } catch (err) {
      throw new SandboxProviderError(`getFile failed for ${path}`, this.id, err);
    }
  }

  async destroy(sandbox: OlSandbox): Promise<void> {
    const handle = this.handles.get(sandbox.id);
    this.handles.delete(sandbox.id);
    this.sandboxOpts.delete(sandbox.id);
    try {
      if (handle) await handle.kill();
      else await this.api.kill(sandbox.id, { apiKey: this.options.apiKey });
    } catch (err) {
      if (isNotFound(err)) return; // idempotent
      throw new SandboxProviderError(`destroy failed for ${sandbox.id}`, this.id, err);
    }
  }

  async list(): Promise<SandboxInfo[]> {
    const running = await this.api.list({
      apiKey: this.options.apiKey,
      metadata: { [SANDBOX_LABELS.owner]: "1" },
    });
    const now = Date.now();
    return running
      .filter((s) => s.metadata?.[SANDBOX_LABELS.owner] === "1")
      .map((s) => {
        const createdAt = s.startedAt
          ? new Date(s.startedAt).toISOString()
          : (s.metadata?.[SANDBOX_LABELS.createdAt] ?? new Date(0).toISOString());
        return {
          id: s.sandboxId,
          providerId: this.id,
          envKey: s.metadata?.[SANDBOX_LABELS.envKey] ?? "",
          createdAt,
          ageMs: Math.max(0, now - Date.parse(createdAt)),
        };
      });
  }

  /** Retire an env: delete its snapshot image so it stops counting against the
   * storage quota. No-op for no-build envs (imageRef is a shared template). */
  async cleanupEnvImage(key: string): Promise<void> {
    const ref = this.envSnapshots.get(key);
    this.envSnapshots.delete(key);
    if (!ref || !this.ownedSnapshots.has(ref)) return; // shared template — not ours to delete
    this.ownedSnapshots.delete(ref);
    await this.api.deleteSnapshot(ref, { apiKey: this.options.apiKey }).catch((err) => {
      if (!isNotFound(err)) throw new SandboxProviderError(`deleteSnapshot failed for ${key}`, this.id, err);
    });
  }

  /** Retire ALL env snapshots this provider created — call at end of a run so
   * snapshots don't accumulate against the storage quota. */
  async dispose(): Promise<void> {
    for (const key of [...this.envSnapshots.keys()]) {
      await this.cleanupEnvImage(key).catch(() => {});
    }
  }

  /** Conformance leak hook: metadata is the E2B "sandbox config" surface — a
   * secret must never appear here (they ride per-exec env only). */
  async inspectConfigEnv(sandbox: OlSandbox): Promise<string[]> {
    const found = (await this.api.list({ apiKey: this.options.apiKey })).find(
      (s) => s.sandboxId === sandbox.id,
    );
    return Object.entries(found?.metadata ?? {}).map(([k, v]) => `${k}=${v}`);
  }

  private envRef(key: string, imageRef: string, built: boolean): EnvRef {
    return { key, imageRef, providerId: this.id, createdAt: new Date().toISOString(), built };
  }

  private olSandbox(id: string, envKey: string): OlSandbox {
    return { id, providerId: this.id, envKey, createdAt: new Date().toISOString() };
  }

  private async killHandle(handle: E2BSandboxHandle): Promise<void> {
    this.handles.delete(handle.sandboxId);
    this.sandboxOpts.delete(handle.sandboxId);
    await handle.kill().catch(() => {});
  }

  private handle(sandbox: OlSandbox): E2BSandboxHandle {
    const handle = this.handles.get(sandbox.id);
    if (!handle) throw new SandboxProviderError(`unknown sandbox ${sandbox.id} (not created here)`, this.id);
    return handle;
  }
}

function bound(text: string, maxBytes: number): [string, boolean] {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return [text, false];
  return [buffer.subarray(0, maxBytes).toString("utf8"), true];
}

function toArrayBuffer(content: Buffer | Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(content); // exact-length fresh copy (offset 0)
  return copy.buffer;
}

interface E2BishError {
  statusCode?: number;
  code?: number;
  message?: string;
}
function isNotFound(err: unknown): boolean {
  const e = err as E2BishError;
  return e?.statusCode === 404 || e?.code === 404 || /not\s*found|404/i.test(e?.message ?? "");
}
