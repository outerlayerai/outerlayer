// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path/posix";
import {
  SANDBOX_LABELS,
  SandboxProviderError,
  type EnvRef,
  type EnvSpec,
  type ExecOpts,
  type ExecResult,
  type FileMap,
  type Sandbox,
  type SandboxInfo,
  type SandboxOpts,
  type SandboxProvider,
} from "./types.js";
import { LocalDockerProvider } from "./local-docker.js";
import { NOOP_SINK, safeSink, type EventSink } from "./events.js";

const execFileP = promisify(execFileCb);

/**
 * execFile with an optional stdin body, so a credential can be handed to a
 * child process without ever appearing in its argv.
 */
async function execFileWithStdin(
  cmd: string,
  args: string[],
  opts?: { stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  if (opts?.stdin === undefined) return execFileP(cmd, args);
  return new Promise((resolve, reject) => {
    const child = execFileCb(cmd, args, (err, stdout, stderr) =>
      err ? reject(err) : resolve({ stdout, stderr }),
    );
    child.stdin?.on("error", () => {
      // The child can exit before draining stdin; the exec callback above
      // reports that failure. Swallowing EPIPE here keeps it from surfacing as
      // an unhandled error event instead.
    });
    child.stdin?.end(opts.stdin);
  });
}
const PROVIDER_ID = "fly";
const DEFAULT_MAX_OUTPUT = 1024 * 1024;
/** Fly's machine-exec endpoint is designed for bounded commands. */
const EXEC_HARD_CAP_S = 60;
/** Raw bytes per putFiles exec chunk (base64 inflates ~4/3). */
const PUT_CHUNK_BYTES = 128 * 1024;

export interface FlyProviderOptions {
  apiToken: string;
  orgSlug: string;
  /** Sandbox app name prefix (default `ol-trial`). Each sandbox gets its own
   * Fly app created with `network = app name` → per-trial 6PN isolation. */
  appPrefix?: string;
  /** App whose registry namespace holds env images (default `<prefix>-envs`). */
  envsApp?: string;
  region?: string;
  baseUrl?: string;
  eventSink?: EventSink;
  /** Local Docker used to build env images before push (prepareEnv). */
  localDocker?: LocalDockerProvider;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  execFileImpl?: (
    cmd: string,
    args: string[],
    opts?: { stdin?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  createWaitTimeoutS?: number;
}

interface FlyMachine {
  id: string;
  state?: string;
  created_at?: string;
  config?: { metadata?: Record<string, string> };
}

/**
 * Fly Machines provider. Topology: one Fly *app per sandbox*,
 * created with `network = app_name`, so no two trials ever share a private
 * network (the 6PN isolation pattern, implemented here self-contained — the
 * OSS tree cannot import private monorepo code).
 *
 * prepareEnv builds via local Docker then pushes to `registry.fly.io/<envsApp>`
 * — the control plane needs a Docker daemon + this token (documented in the
 * README). exec rides Fly's machine-exec endpoint and is therefore suited to
 * bounded commands (≤60s per call); the long-running agent phase on Fly
 * belongs to the trial harness (machine main-process + callback pattern),
 * not to exec.
 */
export class FlyProvider implements SandboxProvider {
  readonly id = PROVIDER_ID;
  private readonly opts: Required<
    Pick<FlyProviderOptions, "apiToken" | "orgSlug" | "appPrefix" | "envsApp" | "region" | "baseUrl">
  >;
  private readonly sink: EventSink;
  private readonly fetchImpl: typeof fetch;
  private readonly execFileImpl: (
    cmd: string,
    args: string[],
    opts?: { stdin?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  private readonly localDocker: LocalDockerProvider;
  private readonly createWaitTimeoutS: number;

  constructor(options: FlyProviderOptions) {
    const appPrefix = options.appPrefix ?? "ol-trial";
    this.opts = {
      apiToken: options.apiToken,
      orgSlug: options.orgSlug,
      appPrefix,
      envsApp: options.envsApp ?? `${appPrefix}-envs`,
      region: options.region ?? "iad",
      baseUrl: options.baseUrl ?? "https://api.machines.dev/v1",
    };
    this.sink = safeSink(options.eventSink ?? NOOP_SINK);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.execFileImpl = options.execFileImpl ?? execFileWithStdin;
    this.localDocker = options.localDocker ?? new LocalDockerProvider();
    this.createWaitTimeoutS = options.createWaitTimeoutS ?? 60;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<{ status: number; data: T | undefined }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.apiToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new SandboxProviderError(`network error: ${method} ${path}`, this.id, err);
    }
    if (!response.ok && !okStatuses.includes(response.status)) {
      let detail = response.statusText;
      try {
        const parsed = (await response.json()) as { error?: string };
        detail = parsed.error ?? detail;
      } catch {
        // keep statusText
      }
      throw new SandboxProviderError(
        `${method} ${path} → ${response.status} ${detail}`,
        this.id,
      );
    }
    const text = await response.text();
    return { status: response.status, data: text ? (JSON.parse(text) as T) : undefined };
  }

  registryImageRef(key: string): string {
    return `registry.fly.io/${this.opts.envsApp}:${key}`;
  }

  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    const started = Date.now();
    const imageRef = this.registryImageRef(spec.key);

    // Idempotence on the building host: the pushed tag exists locally iff a
    // prior prepareEnv completed (tag applied only after successful push
    // would race; we tag first and re-push on doubt — layer pushes dedupe).
    if (await this.localImageExists(imageRef)) {
      return {
        key: spec.key,
        imageRef,
        providerId: this.id,
        createdAt: new Date().toISOString(),
        built: false,
      };
    }

    const local = await this.localDocker.prepareEnv(spec);
    await this.ensureApp(this.opts.envsApp);
    await this.execFileImpl("docker", ["tag", local.imageRef, imageRef]);
    await this.dockerLoginAndPush(imageRef);

    this.sink.emit({
      type: "env_prepared",
      providerId: this.id,
      ts: new Date().toISOString(),
      envKey: spec.key,
      durationMs: Date.now() - started,
    });
    return {
      key: spec.key,
      imageRef,
      providerId: this.id,
      createdAt: new Date().toISOString(),
      built: true,
    };
  }

  private async dockerLoginAndPush(imageRef: string): Promise<void> {
    // `--password-stdin`, never `-p <token>`: argv is visible to other
    // processes on the host and is echoed by shell history and CI logs, so a
    // credential is passed on stdin instead.
    await this.execFileImpl("docker", ["login", "registry.fly.io", "-u", "x", "--password-stdin"], {
      stdin: this.opts.apiToken,
    });
    await this.execFileImpl("docker", ["push", imageRef]);
  }

  private async localImageExists(ref: string): Promise<boolean> {
    try {
      await this.execFileImpl("docker", ["image", "inspect", ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureApp(appName: string): Promise<void> {
    const { status } = await this.request<unknown>("GET", `/apps/${appName}`, undefined, [404]);
    if (status === 404) {
      await this.request("POST", "/apps", {
        app_name: appName,
        org_slug: this.opts.orgSlug,
        network: appName, // per-app 6PN isolation
      });
    }
  }

  async create(env: EnvRef, opts: SandboxOpts = {}): Promise<Sandbox> {
    const createdAt = new Date().toISOString();
    const appName = `${this.opts.appPrefix}-${env.key.slice(0, 8)}-${randomBytes(3).toString("hex")}`
      .toLowerCase()
      .slice(0, 30);
    await this.request("POST", "/apps", {
      app_name: appName,
      org_slug: this.opts.orgSlug,
      network: appName,
    });
    const { data: machine } = await this.request<FlyMachine>(
      "POST",
      `/apps/${appName}/machines`,
      {
        name: "sbx",
        region: this.opts.region,
        config: {
          image: env.imageRef,
          guest: {
            cpu_kind: "shared",
            cpus: opts.cpus ?? 1,
            memory_mb: opts.memMb ?? 1024,
          },
          init: { cmd: ["/bin/sh", "-c", "while true; do sleep 3600; done"] },
          restart: { policy: "no" },
          auto_destroy: false,
          metadata: {
            [SANDBOX_LABELS.owner]: "1",
            [SANDBOX_LABELS.createdAt]: createdAt,
            [SANDBOX_LABELS.envKey]: env.key,
            ...(opts.network === "none" ? { "outerlayer-network": "none" } : {}),
            ...opts.labels,
          },
        },
      },
    );
    if (!machine?.id) {
      throw new SandboxProviderError(`machine create returned no id (app ${appName})`, this.id);
    }
    await this.request(
      "GET",
      `/apps/${appName}/machines/${machine.id}/wait?state=started&timeout=${this.createWaitTimeoutS}`,
    );
    const sandbox: Sandbox = {
      id: `${appName}/${machine.id}`,
      providerId: this.id,
      envKey: env.key,
      createdAt,
    };
    if (opts.network === "none") {
      // Fly machines have outbound NAT by default and no per-machine
      // "no network" flag. We're root inside the Firecracker VM: dropping
      // the default routes kills all egress for the machine's lifetime
      // (grade phase). Verified by the conformance egress test.
      const cut = await this.exec(
        sandbox,
        "ip route del default 2>/dev/null; ip -6 route del default 2>/dev/null; true",
      );
      if (cut.code !== 0) {
        await this.destroy(sandbox);
        throw new SandboxProviderError("failed to enforce network:none", this.id);
      }
    }
    this.sink.emit({
      type: "sandbox_created",
      providerId: this.id,
      ts: createdAt,
      sandboxId: sandbox.id,
      envKey: env.key,
    });
    return sandbox;
  }

  private split(sandbox: Sandbox): { app: string; machine: string } {
    const [app, machine] = sandbox.id.split("/");
    if (!app || !machine) {
      throw new SandboxProviderError(`malformed sandbox id ${sandbox.id}`, this.id);
    }
    return { app, machine };
  }

  async exec(sandbox: Sandbox, cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const started = Date.now();
    const { app, machine } = this.split(sandbox);
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const timeoutS = Math.min(
      Math.ceil((opts.timeoutMs ?? EXEC_HARD_CAP_S * 1000) / 1000),
      EXEC_HARD_CAP_S,
    );

    const envPrefix = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shq(v)}; `)
      .join("");
    const cwdPrefix = opts.cwd ? `cd ${shq(opts.cwd)} && ` : "";
    const script = `${envPrefix}${cwdPrefix}${cmd}`;

    let data:
      | { exit_code?: number; stdout?: string; stderr?: string }
      | undefined;
    let timedOut = false;
    try {
      ({ data } = await this.request<{ exit_code?: number; stdout?: string; stderr?: string }>(
        "POST",
        `/apps/${app}/machines/${machine}/exec`,
        { cmd: ["/bin/sh", "-lc", script], timeout: timeoutS },
      ));
    } catch (err) {
      if (err instanceof SandboxProviderError && /→ (408|504)/.test(err.message)) {
        timedOut = true;
      } else {
        throw err;
      }
    }

    const bound = (s: string | undefined) => {
      const text = s ?? "";
      return {
        text: text.length > maxBytes ? text.slice(0, maxBytes) : text,
        truncated: text.length > maxBytes,
      };
    };
    const so = bound(data?.stdout);
    const se = bound(data?.stderr);
    const result: ExecResult = {
      code: timedOut ? 124 : (data?.exit_code ?? 0),
      stdout: so.text,
      stderr: timedOut ? `${se.text}\n[exec timed out]` : se.text,
      ms: Date.now() - started,
      truncated: so.truncated || se.truncated,
      timedOut,
    };
    this.sink.emit({
      type: "exec_completed",
      providerId: this.id,
      ts: new Date().toISOString(),
      sandboxId: sandbox.id,
      envKey: sandbox.envKey,
      durationMs: result.ms,
      meta: { code: result.code, timedOut: result.timedOut, truncated: result.truncated },
    });
    return result;
  }

  async putFiles(sandbox: Sandbox, files: FileMap): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      const mkdir = await this.exec(sandbox, `mkdir -p ${shq(dirname(path))}`);
      if (mkdir.code !== 0) {
        throw new SandboxProviderError(`mkdir failed for ${path}: ${mkdir.stderr}`, this.id);
      }
      for (let offset = 0; offset < buffer.length || offset === 0; offset += PUT_CHUNK_BYTES) {
        const chunk = buffer.subarray(offset, offset + PUT_CHUNK_BYTES).toString("base64");
        const redirect = offset === 0 ? ">" : ">>";
        const write = await this.exec(
          sandbox,
          `printf %s ${shq(chunk)} | base64 -d ${redirect} ${shq(path)}`,
        );
        if (write.code !== 0) {
          throw new SandboxProviderError(`write failed for ${path}: ${write.stderr}`, this.id);
        }
        if (buffer.length === 0) break;
      }
    }
  }

  async getFile(sandbox: Sandbox, path: string): Promise<Buffer> {
    const result = await this.exec(sandbox, `base64 < ${shq(path)}`, {
      maxOutputBytes: 32 * 1024 * 1024,
    });
    if (result.code !== 0) {
      throw new SandboxProviderError(`getFile failed for ${path}: ${result.stderr}`, this.id);
    }
    if (result.truncated) {
      throw new SandboxProviderError(
        `getFile truncated for ${path} — refusing to return corrupt bytes`,
        this.id,
      );
    }
    return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    const { app, machine } = this.split(sandbox);
    await this.request("DELETE", `/apps/${app}/machines/${machine}?force=true`, undefined, [404]);
    await this.request("DELETE", `/apps/${app}`, undefined, [404]);
    this.sink.emit({
      type: "sandbox_destroyed",
      providerId: this.id,
      ts: new Date().toISOString(),
      sandboxId: sandbox.id,
      envKey: sandbox.envKey,
    });
  }

  async list(): Promise<SandboxInfo[]> {
    const { data } = await this.request<{ apps?: { name: string }[] }>(
      "GET",
      `/apps?org_slug=${encodeURIComponent(this.opts.orgSlug)}`,
    );
    const apps = (data?.apps ?? [])
      .map((a) => a.name)
      .filter((name) => name.startsWith(`${this.opts.appPrefix}-`) && name !== this.opts.envsApp);
    const now = Date.now();
    const out: SandboxInfo[] = [];
    for (const app of apps) {
      const { data: machines } = await this.request<FlyMachine[]>(
        "GET",
        `/apps/${app}/machines`,
        undefined,
        [404],
      );
      for (const m of machines ?? []) {
        const meta = m.config?.metadata ?? {};
        if (meta[SANDBOX_LABELS.owner] !== "1") continue;
        const createdAt = meta[SANDBOX_LABELS.createdAt] ?? m.created_at ?? new Date(0).toISOString();
        out.push({
          id: `${app}/${m.id}`,
          providerId: this.id,
          envKey: meta[SANDBOX_LABELS.envKey] ?? "",
          createdAt,
          ageMs: now - Date.parse(createdAt),
        });
      }
    }
    return out;
  }
}

/** POSIX single-quote escaping. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
