// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Adapter-logic tests against a FAKE E2BApi that mirrors the real `e2b` v2 SDK
// method shapes (commands.run throws CommandExitError on nonzero; files.read
// returns Uint8Array for format:'bytes'; createSnapshot/deleteSnapshot). No live
// E2B. The creds-gated live conformance run is in e2b.conformance.test.ts.

import { describe, expect, test, vi } from "vitest";
import { CommandExitError } from "e2b";
import type { EnvRef, EnvSpec, Sandbox as OlSandbox } from "@outerlayer/runner-core";
import {
  E2BProvider,
  e2bProviderFromEnv,
  type E2BApi,
  type E2BCreateOpts,
  type E2BSandboxHandle,
  type E2BListedSandbox,
} from "../index.js";

interface RunResult { exitCode: number; stdout: string; stderr: string }

class FakeSandbox implements E2BSandboxHandle {
  readonly runCalls: Array<{ cmd: string; opts?: { cwd?: string; user?: string; envs?: Record<string, string> } }> = [];
  readonly writes: Array<{ path: string; data: string | ArrayBuffer }> = [];
  readonly madeDirs: string[] = [];
  killed = 0;
  snapshots = 0;
  private runImpl: (cmd: string) => Promise<RunResult> = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  private fileBytes = new Map<string, Uint8Array>();

  constructor(readonly sandboxId: string) {}

  onRun(fn: (cmd: string) => Promise<RunResult>): this { this.runImpl = fn; return this; }
  seedFile(path: string, bytes: Uint8Array): this { this.fileBytes.set(path, bytes); return this; }

  readonly commands = {
    run: (cmd: string, opts?: { cwd?: string; user?: string; envs?: Record<string, string> }) => {
      this.runCalls.push({ cmd, opts });
      return this.runImpl(cmd);
    },
  };
  readonly files = {
    write: async (path: string, data: string | ArrayBuffer) => { this.writes.push({ path, data }); },
    read: async (path: string, opts?: { format?: "text" | "bytes" }) => {
      const b = this.fileBytes.get(path) ?? new Uint8Array();
      return opts?.format === "bytes" ? b : Buffer.from(b).toString("utf8");
    },
    makeDir: async (path: string) => { this.madeDirs.push(path); },
  };
  async createSnapshot() { this.snapshots += 1; return { snapshotId: `snap_${this.sandboxId}` }; }
  async kill() { this.killed += 1; }
}

function fakeApi(sandboxes: FakeSandbox[] = []) {
  const created: Array<{ template: string; opts: E2BCreateOpts }> = [];
  const killedIds: string[] = [];
  const deletedSnapshots: string[] = [];
  let listResult: E2BListedSandbox[] = [];
  let cursor = 0;
  const api: E2BApi = {
    create: async (template, opts) => {
      created.push({ template, opts });
      return sandboxes[cursor++] ?? new FakeSandbox(`sb_${cursor}`);
    },
    list: async () => listResult,
    kill: async (id) => { killedIds.push(id); return true; },
    deleteSnapshot: async (id) => { deletedSnapshots.push(id); return true; },
  };
  return { api, created, killedIds, deletedSnapshots, setList: (r: E2BListedSandbox[]) => { listResult = r; } };
}

const ENV: EnvRef = { key: "abc123", imageRef: "ol-base", providerId: "e2b", createdAt: "t", built: false };

describe("E2BProvider — prepareEnv snapshots, create boots them", () => {
  test("requires an api key", () => {
    expect(() => new E2BProvider({ apiKey: "" })).toThrow(/requires an apiKey/);
  });

  test("prepareEnv runs the build EXACTLY once, snapshots it, tears down the scratch sandbox", async () => {
    const build = new FakeSandbox("sb_build");
    const f = fakeApi([build]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const recipe = vi.fn(async (s: OlSandbox, prov) => { await prov.exec(s, "pip install -e ."); });

    const env1 = await p.prepareEnv({ key: "k1", baseImage: "ol-base", build: recipe });
    expect(recipe).toHaveBeenCalledTimes(1);
    expect(build.runCalls.map((c) => c.cmd)).toContain("pip install -e .");
    expect(build.snapshots).toBe(1);
    expect(build.killed).toBe(1); // scratch torn down
    expect(env1.built).toBe(true);
    expect(env1.imageRef).toBe("snap_sb_build"); // imageRef IS the snapshot

    // cache hit — no rebuild, no second snapshot
    const env2 = await p.prepareEnv({ key: "k1", baseImage: "ol-base", build: recipe });
    expect(recipe).toHaveBeenCalledTimes(1);
    expect(env2.built).toBe(false);
    expect(env2.imageRef).toBe("snap_sb_build");
  });

  test("create boots from the SNAPSHOT and does NOT re-run the build", async () => {
    const build = new FakeSandbox("sb_build");
    const trial = new FakeSandbox("sb_trial");
    const f = fakeApi([build, trial]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const recipe = vi.fn(async (s: OlSandbox, prov) => { await prov.exec(s, "setup"); });

    const env = await p.prepareEnv({ key: "k1", baseImage: "ol-base", build: recipe });
    const sandbox = await p.create(env, { network: "default" });

    expect(sandbox.id).toBe("sb_trial");
    // first create booted the base template (build); second booted the snapshot.
    expect(f.created.map((c) => c.template)).toEqual(["ol-base", "snap_sb_build"]);
    expect(recipe).toHaveBeenCalledTimes(1); // NOT re-run on create
    expect(trial.runCalls).toHaveLength(0); // no build commands replayed into the trial
  });

  test("no-build env boots the base template directly (nothing to snapshot)", async () => {
    const f = fakeApi();
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const first = await p.prepareEnv({ key: "nb", baseImage: "ol-base" });
    expect(first.built).toBe(true);
    expect(first.imageRef).toBe("ol-base");
    const second = await p.prepareEnv({ key: "nb", baseImage: "ol-base" });
    expect(second.built).toBe(false);
  });

  test("cleanupEnvImage deletes an owned snapshot but never a shared template", async () => {
    const build = new FakeSandbox("sb_build");
    const f = fakeApi([build]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    await p.prepareEnv({ key: "built", baseImage: "ol-base", build: async () => {} });
    await p.prepareEnv({ key: "nobuild", baseImage: "ol-base" }); // imageRef = template

    await p.cleanupEnvImage("built");
    await p.cleanupEnvImage("nobuild");
    expect(f.deletedSnapshots).toEqual(["snap_sb_build"]); // template NOT deleted
  });

  test("create sends owner metadata + timeout; agent phase online, grade phase offline", async () => {
    const f = fakeApi([new FakeSandbox("sb_a"), new FakeSandbox("sb_g")]);
    const p = new E2BProvider({ apiKey: "e2b_k", api: f.api, defaultTimeoutMs: 60_000 });
    await p.create(ENV, { network: "default" });
    await p.create(ENV, { network: "none" });
    expect(f.created[0]!.opts.timeoutMs).toBe(60_000);
    expect(f.created[0]!.opts.apiKey).toBe("e2b_k");
    expect(f.created[0]!.opts.allowInternetAccess).toBe(true);
    expect(f.created[0]!.opts.metadata?.["outerlayer-trial"]).toBe("1");
    expect(f.created[0]!.opts.metadata?.["outerlayer-env-key"]).toBe("abc123");
    expect(f.created[1]!.opts.allowInternetAccess).toBe(false);
  });
});

describe("E2BProvider — exec contract", () => {
  test("nonzero exit is DATA, never a throw (catches CommandExitError)", async () => {
    const sbx = new FakeSandbox("sb_1").onRun(async () => {
      throw new CommandExitError({ exitCode: 42, stdout: "", stderr: "boom", error: "exit status 42" });
    });
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV);
    const res = await p.exec(sandbox, "exit 42");
    expect(res.code).toBe(42);
    expect(res.stderr).toBe("boom");
    expect(res.timedOut).toBe(false);
  });

  test("secrets ride per-exec envs (as root) and never touch create metadata", async () => {
    const sbx = new FakeSandbox("sb_1").onRun(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV, { network: "default" });
    await p.exec(sandbox, "printenv", { env: { ANTHROPIC_API_KEY: "sk-secret" }, cwd: "/work" });
    expect(sbx.runCalls[0]!.opts?.envs?.ANTHROPIC_API_KEY).toBe("sk-secret");
    expect(sbx.runCalls[0]!.opts?.user).toBe("root");
    expect(sbx.runCalls[0]!.opts?.cwd).toBe("/work");
    expect(JSON.stringify(f.created[0]!.opts.metadata)).not.toContain("sk-secret");
  });

  test("bounds output by bytes and flags truncation only when over the cap", async () => {
    let out = "x".repeat(5000);
    const sbx = new FakeSandbox("sb_1").onRun(async () => ({ exitCode: 0, stdout: out, stderr: "" }));
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV);
    const big = await p.exec(sandbox, "cat big", { maxOutputBytes: 1000 });
    expect(big.truncated).toBe(true);
    expect(Buffer.from(big.stdout, "utf8").length).toBe(1000);
    out = "tiny";
    const small = await p.exec(sandbox, "echo tiny", { maxOutputBytes: 1000 });
    expect(small.truncated).toBe(false);
    expect(small.stdout).toBe("tiny");
  });

  test("a hung command times out to code 124 + timedOut without hanging the caller", async () => {
    const sbx = new FakeSandbox("sb_1").onRun(() => new Promise<RunResult>(() => {}));
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV);
    const res = await p.exec(sandbox, "sleep 999", { timeoutMs: 25 });
    expect(res.code).toBe(124);
    expect(res.timedOut).toBe(true);
    expect(res.ms).toBeLessThan(2000);
  });

  test("pidsLimit is enforced via ulimit prepended to the command", async () => {
    const sbx = new FakeSandbox("sb_1").onRun(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV, { pidsLimit: 64 });
    await p.exec(sandbox, "forkbomb");
    expect(sbx.runCalls[0]!.cmd).toBe("ulimit -u 64 2>/dev/null; forkbomb");
  });
});

describe("E2BProvider — files, destroy, list", () => {
  test("putFiles makes parent dirs and round-trips binary as an ArrayBuffer", async () => {
    const sbx = new FakeSandbox("sb_1");
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV);
    const bin = Buffer.from([0, 1, 2, 255, 254]);
    await p.putFiles(sandbox, { "/work/deep/a.txt": "hi", "/work/b.bin": bin });
    expect(sbx.madeDirs).toContain("/work/deep");
    expect(sbx.writes.find((w) => w.path === "/work/deep/a.txt")!.data).toBe("hi");
    const blob = sbx.writes.find((w) => w.path === "/work/b.bin")!;
    expect(blob.data).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(blob.data as ArrayBuffer).equals(bin)).toBe(true);
  });

  test("getFile reads bytes and returns a Buffer (binary-safe)", async () => {
    const bytes = new Uint8Array([10, 20, 0, 200, 255]);
    const sbx = new FakeSandbox("sb_1").seedFile("/work/blob", bytes);
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV);
    const got = await p.getFile(sandbox, "/work/blob");
    expect(got.equals(Buffer.from(bytes))).toBe(true);
  });

  test("destroy kills the live handle and is idempotent (second call by id)", async () => {
    const sbx = new FakeSandbox("sb_1");
    const f = fakeApi([sbx]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const sandbox = await p.create(ENV);
    await p.destroy(sandbox);
    expect(sbx.killed).toBe(1);
    await expect(p.destroy(sandbox)).resolves.toBeUndefined();
    expect(f.killedIds).toEqual(["sb_1"]);
  });

  test("list filters to owner-labelled sandboxes and computes non-negative age", async () => {
    const f = fakeApi();
    f.setList([
      { sandboxId: "mine", metadata: { "outerlayer-trial": "1", "outerlayer-env-key": "abc123" }, startedAt: new Date(Date.now() - 5_000) },
      { sandboxId: "someone-else", metadata: {}, startedAt: new Date() },
    ]);
    const p = new E2BProvider({ apiKey: "k", api: f.api });
    const list = await p.list();
    expect(list.map((s) => s.id)).toEqual(["mine"]);
    expect(list[0]!.envKey).toBe("abc123");
    expect(list[0]!.ageMs).toBeGreaterThanOrEqual(4_000);
  });
});

describe("e2bProviderFromEnv feature flag", () => {
  test("null unless explicitly enabled AND keyed (never engages by accident)", () => {
    expect(e2bProviderFromEnv({})).toBeNull();
    expect(e2bProviderFromEnv({ E2B_API_KEY: "k" })).toBeNull();
    expect(e2bProviderFromEnv({ OUTERLAYER_E2B_ENABLED: "1" })).toBeNull();
    expect(e2bProviderFromEnv({ OUTERLAYER_E2B_ENABLED: "1", E2B_API_KEY: "k" })).toBeInstanceOf(E2BProvider);
  });
});
