// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import Docker from "dockerode";
import * as tar from "tar-stream";
import { Writable } from "node:stream";
import { dirname } from "node:path/posix";
import {
  SANDBOX_LABELS,
  SandboxProviderError,
  type EnvRef,
  type EnvSpec,
  type ExecOpts,
  type ExecResult,
  type FileMap,
  type NetworkMode,
  type Sandbox,
  type SandboxInfo,
  type SandboxOpts,
  type SandboxProvider,
} from "./types.js";
import { NOOP_SINK, safeSink, type EventSink } from "./events.js";

const PROVIDER_ID = "local-docker";
const ENV_REPO = "ol-env";
const DEFAULT_MAX_OUTPUT = 1024 * 1024; // 1 MiB per stream
const MB = 1024 * 1024;

export interface LocalDockerProviderOptions {
  docker?: Docker;
  eventSink?: EventSink;
  /** Image repo for env snapshots (default `ol-env`). */
  envRepo?: string;
}

export class LocalDockerProvider implements SandboxProvider {
  readonly id = PROVIDER_ID;
  private readonly docker: Docker;
  private readonly sink: EventSink;
  private readonly envRepo: string;

  constructor(options: LocalDockerProviderOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.sink = safeSink(options.eventSink ?? NOOP_SINK);
    this.envRepo = options.envRepo ?? ENV_REPO;
  }

  private envImageRef(key: string): string {
    return `${this.envRepo}:${key}`;
  }

  async prepareEnv(spec: EnvSpec): Promise<EnvRef> {
    const started = Date.now();
    const imageRef = this.envImageRef(spec.key);

    if (await this.imageExists(imageRef)) {
      return {
        key: spec.key,
        imageRef,
        providerId: this.id,
        createdAt: new Date().toISOString(),
        built: false,
      };
    }

    await this.ensureImage(spec.baseImage);

    // Build in a scratch sandbox from the base image, then snapshot.
    const buildSandbox = await this.createFromImage(spec.baseImage, spec.key, {
      network: "default",
      ...spec.buildOpts,
    });
    try {
      if (spec.build) {
        await spec.build(buildSandbox, this);
      }
      const container = this.docker.getContainer(buildSandbox.id);
      await container.commit({
        repo: this.envRepo,
        tag: spec.key,
        pause: true,
        Labels: { [SANDBOX_LABELS.envKey]: spec.key, "outerlayer-env": "1" },
      });
    } finally {
      await this.destroy(buildSandbox);
    }

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

  async create(env: EnvRef, opts: SandboxOpts = {}): Promise<Sandbox> {
    const sandbox = await this.createFromImage(env.imageRef, env.key, opts);
    this.sink.emit({
      type: "sandbox_created",
      providerId: this.id,
      ts: new Date().toISOString(),
      sandboxId: sandbox.id,
      envKey: env.key,
    });
    return sandbox;
  }

  private async createFromImage(
    imageRef: string,
    envKey: string,
    opts: SandboxOpts,
  ): Promise<Sandbox> {
    const createdAt = new Date().toISOString();
    const networkMode: NetworkMode = opts.network ?? "default";
    try {
      const container = await this.docker.createContainer({
        Image: imageRef,
        // survives images whose default entrypoint exits; sh is required by
        // the exec contract anyway
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: ["while true; do sleep 3600; done"],
        Labels: {
          [SANDBOX_LABELS.owner]: "1",
          [SANDBOX_LABELS.createdAt]: createdAt,
          [SANDBOX_LABELS.envKey]: envKey,
          ...opts.labels,
        },
        HostConfig: {
          NetworkMode: networkMode === "none" ? "none" : "bridge",
          ...(opts.cpus ? { NanoCpus: Math.round(opts.cpus * 1e9) } : {}),
          ...(opts.memMb ? { Memory: opts.memMb * MB, MemorySwap: opts.memMb * MB } : {}),
          PidsLimit: opts.pidsLimit ?? 512,
          Tmpfs: { "/scratch": "rw,size=512m" },
        },
      });
      await container.start();
      return { id: container.id, providerId: this.id, envKey, createdAt };
    } catch (err) {
      throw new SandboxProviderError(`create failed for image ${imageRef}`, this.id, err);
    }
  }

  async exec(sandbox: Sandbox, cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const started = Date.now();
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const container = this.docker.getContainer(sandbox.id);

    let exec;
    try {
      exec = await container.exec({
        Cmd: ["/bin/sh", "-lc", cmd],
        AttachStdout: true,
        AttachStderr: true,
        ...(opts.cwd ? { WorkingDir: opts.cwd } : {}),
        ...(opts.env ? { Env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) } : {}),
      });
    } catch (err) {
      throw new SandboxProviderError(`exec setup failed`, this.id, err);
    }

    const stdout = new BoundedCollector(maxBytes);
    const stderr = new BoundedCollector(maxBytes);
    const stream = await exec.start({ hijack: true });

    let timedOut = false;
    const finished = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });
    this.docker.modem.demuxStream(stream, stdout.writable(), stderr.writable());

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        // abandon the stream; the process may keep running — callers destroy
        stream.destroy();
      }, opts.timeoutMs);
    }
    try {
      await finished.catch((err) => {
        if (!timedOut) throw new SandboxProviderError(`exec stream failed`, this.id, err);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    let code = 124;
    if (!timedOut) {
      const inspect = await exec.inspect();
      code = inspect.ExitCode ?? 0;
    }
    const result: ExecResult = {
      code,
      stdout: stdout.text(),
      stderr: timedOut ? stderr.text() + "\n[exec timed out]" : stderr.text(),
      ms: Date.now() - started,
      truncated: stdout.truncated || stderr.truncated,
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
    const pack = tar.pack();
    const dirs = new Set<string>();
    for (const path of Object.keys(files)) {
      let dir = dirname(path);
      while (dir !== "/" && dir !== "." && !dirs.has(dir)) {
        dirs.add(dir);
        dir = dirname(dir);
      }
    }
    for (const dir of [...dirs].sort()) {
      pack.entry({ name: dir.replace(/^\//, ""), type: "directory" });
    }
    for (const [path, content] of Object.entries(files)) {
      pack.entry(
        { name: path.replace(/^\//, "") },
        typeof content === "string" ? Buffer.from(content, "utf8") : content,
      );
    }
    pack.finalize();
    try {
      await this.docker.getContainer(sandbox.id).putArchive(pack as never, { path: "/" });
    } catch (err) {
      throw new SandboxProviderError(`putFiles failed`, this.id, err);
    }
  }

  async getFile(sandbox: Sandbox, path: string): Promise<Buffer> {
    const container = this.docker.getContainer(sandbox.id);
    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.getArchive({ path });
    } catch (err) {
      throw new SandboxProviderError(`getFile failed for ${path}`, this.id, err);
    }
    return new Promise<Buffer>((resolve, reject) => {
      const extract = tar.extract();
      const chunks: Buffer[] = [];
      let found = false;
      extract.on("entry", (header, entryStream, next) => {
        if (header.type === "file" && !found) {
          found = true;
          entryStream.on("data", (c: Buffer) => chunks.push(c));
          entryStream.on("end", next);
        } else {
          entryStream.resume();
          entryStream.on("end", next);
        }
      });
      extract.on("finish", () => {
        if (found) resolve(Buffer.concat(chunks));
        else reject(new SandboxProviderError(`no file entry in archive for ${path}`, this.id));
      });
      extract.on("error", reject);
      stream.pipe(extract);
    });
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    try {
      await this.docker.getContainer(sandbox.id).remove({ force: true });
      this.sink.emit({
        type: "sandbox_destroyed",
        providerId: this.id,
        ts: new Date().toISOString(),
        sandboxId: sandbox.id,
        envKey: sandbox.envKey,
      });
    } catch (err) {
      if (isNotFound(err) || isRemovalInProgress(err)) return; // idempotent
      throw new SandboxProviderError(`destroy failed for ${sandbox.id}`, this.id, err);
    }
  }

  async list(): Promise<SandboxInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${SANDBOX_LABELS.owner}=1`] },
    });
    const now = Date.now();
    return containers.map((c) => {
      const createdAt =
        c.Labels?.[SANDBOX_LABELS.createdAt] ?? new Date(c.Created * 1000).toISOString();
      return {
        id: c.Id,
        providerId: this.id,
        envKey: c.Labels?.[SANDBOX_LABELS.envKey] ?? "",
        createdAt,
        ageMs: now - Date.parse(createdAt),
      };
    });
  }

  /** Registry digest when the image was pulled/pushed; local image id (also
   * content-addressed) for images that only exist locally. */
  async resolveImageDigest(imageRef: string): Promise<string | undefined> {
    try {
      const info = await this.docker.getImage(imageRef).inspect();
      const repoDigest = info.RepoDigests?.[0];
      if (repoDigest) return repoDigest.split("@")[1] ?? repoDigest;
      return info.Id || undefined;
    } catch {
      return undefined;
    }
  }

  // --- internals

  private async imageExists(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureImage(ref: string): Promise<void> {
    if (await this.imageExists(ref)) return;
    const stream = await this.docker.pull(ref);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Test hook: environment visible on the container config (leak surface). */
  async inspectConfigEnv(sandbox: Sandbox): Promise<string[]> {
    const info = await this.docker.getContainer(sandbox.id).inspect();
    return info.Config.Env ?? [];
  }

  /** Test hook: image history commands for an env snapshot (leak surface). */
  async inspectImageHistory(imageRef: string): Promise<string[]> {
    const history = (await this.docker.getImage(imageRef).history()) as Array<{
      CreatedBy?: string;
    }>;
    return history.map((h) => h.CreatedBy ?? "");
  }

  /** Test hook: remove an env snapshot image. */
  async removeEnvImage(key: string): Promise<void> {
    try {
      await this.docker.getImage(this.envImageRef(key)).remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

class BoundedCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly maxBytes: number) {}
  writable(): Writable {
    return new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (this.bytes < this.maxBytes) {
          const room = this.maxBytes - this.bytes;
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
          this.chunks.push(Buffer.from(slice));
          this.bytes += slice.length;
          if (chunk.length > room) this.truncated = true;
        } else {
          this.truncated = true;
        }
        cb();
      },
    });
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

interface DockerishError {
  statusCode?: number;
  message?: string;
}
function isNotFound(err: unknown): boolean {
  return (err as DockerishError)?.statusCode === 404;
}
function isRemovalInProgress(err: unknown): boolean {
  const e = err as DockerishError;
  return e?.statusCode === 409 && /removal.*progress|already in progress/i.test(e?.message ?? "");
}
