// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it } from "vitest";
import { FlyProvider } from "../fly.js";
import { SANDBOX_LABELS } from "../types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Scriptable fetch: route key `METHOD path-prefix` → responder. */
function mockFly(routes: Record<string, (call: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.machines.dev/v1", "");
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => {
        const [m, p] = k.split(" ", 2);
        return m === call.method && path.startsWith(p!);
      })
      .sort((a, b) => b.length - a.length)[0]; // longest (most specific) prefix wins
    if (!key) return new Response("{}", { status: 200 });
    const { status = 200, body = {} } = routes[key]!(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeProvider(
  routes: Parameters<typeof mockFly>[0],
  execCalls: string[][] = [],
) {
  const { calls, fetchImpl } = mockFly(routes);
  const provider = new FlyProvider({
    apiToken: "tok",
    orgSlug: "acme",
    fetchImpl,
    execFileImpl: async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      return { stdout: "", stderr: "" };
    },
  });
  return { provider, calls };
}

const ENV = {
  key: "abcdef1234567890",
  imageRef: "registry.fly.io/ol-trial-envs:abcdef1234567890",
  providerId: "fly",
  createdAt: "2026-07-06T00:00:00.000Z",
  built: false,
};

describe("FlyProvider.create", () => {
  it("creates an isolated app (network = app name) and a machine with caps + labels, waits for started", async () => {
    const { provider, calls } = makeProvider({
      "POST /apps": () => ({ body: {} }),
      "POST /apps/": () => ({ body: { id: "m123" } }), // …/machines (longer prefix wins)
      "GET /apps/": () => ({ body: {} }),
    });
    const sandbox = await provider.create(ENV, {
      cpus: 2,
      memMb: 2048,
      labels: { trial: "t1" },
    });

    const appCreate = calls.find((c) => c.method === "POST" && c.path === "/apps")!;
    const appBody = appCreate.body as Record<string, unknown>;
    expect(appBody.org_slug).toBe("acme");
    expect(appBody.network).toBe(appBody.app_name); // 6PN per-sandbox isolation
    expect(String(appBody.app_name)).toMatch(/^ol-trial-abcdef12-[0-9a-f]{6}$/);

    const machineCreate = calls.find((c) => c.path.endsWith("/machines") && c.method === "POST")!;
    const config = (machineCreate.body as { config: Record<string, unknown> }).config;
    expect(config.image).toBe(ENV.imageRef);
    expect(config.guest).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 });
    const metadata = config.metadata as Record<string, string>;
    expect(metadata[SANDBOX_LABELS.owner]).toBe("1");
    expect(metadata[SANDBOX_LABELS.envKey]).toBe(ENV.key);
    expect(metadata.trial).toBe("t1");

    expect(calls.some((c) => c.path.includes("/wait?state=started&timeout=60"))).toBe(true);
    expect(sandbox.id).toMatch(/^ol-trial-abcdef12-[0-9a-f]{6}\/m123$/);
  });

  it("network:none cuts the default routes right after start", async () => {
    const execBodies: string[] = [];
    const { provider } = makeProvider({
      "POST /apps": () => ({ body: {} }),
      "POST /apps/": (c) => {
        if (c.path.endsWith("/exec")) {
          execBodies.push((c.body as { cmd: string[] }).cmd[2]!);
          return { body: { exit_code: 0, stdout: "", stderr: "" } };
        }
        return { body: { id: "m1" } };
      },
      "GET /apps/": () => ({ body: {} }),
    });
    await provider.create(ENV, { network: "none" });
    expect(execBodies.some((s) => s.includes("ip route del default"))).toBe(true);
  });
});

describe("FlyProvider.exec", () => {
  function execProvider(responder: (script: string) => { exit_code: number; stdout?: string; stderr?: string }) {
    const scripts: string[] = [];
    const { provider } = makeProvider({
      "POST /apps/": (c) => {
        const script = (c.body as { cmd: string[] }).cmd[2]!;
        scripts.push(script);
        return { body: responder(script) };
      },
    });
    return { provider, scripts };
  }
  const SBX = { id: "app1/m1", providerId: "fly", envKey: "k", createdAt: "2026-07-06T00:00:00Z" };

  it("injects per-exec env with safe quoting and cwd prefix", async () => {
    const { provider, scripts } = execProvider(() => ({ exit_code: 0, stdout: "ok" }));
    const result = await provider.exec(SBX, "echo $SECRET", {
      env: { SECRET: "v'; rm -rf /; '" },
      cwd: "/repo",
    });
    expect(result.code).toBe(0);
    expect(scripts[0]).toBe(
      `export SECRET='v'\\''; rm -rf /; '\\'''; cd '/repo' && echo $SECRET`,
    );
  });

  it("nonzero exit is data; stderr separated; output bounded with truncated flag", async () => {
    const { provider } = execProvider(() => ({
      exit_code: 3,
      stdout: "x".repeat(2000),
      stderr: "bad",
    }));
    const result = await provider.exec(SBX, "whatever", { maxOutputBytes: 100 });
    expect(result.code).toBe(3);
    expect(result.stdout.length).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.stderr).toBe("bad");
  });
});

describe("FlyProvider.putFiles / getFile", () => {
  const SBX = { id: "app1/m1", providerId: "fly", envKey: "k", createdAt: "2026-07-06T00:00:00Z" };

  it("chunks large files over multiple execs and reassembles byte-identically", async () => {
    const written: Record<string, Buffer> = {};
    const { provider } = makeProvider({
      "POST /apps/": (c) => {
        const script = (c.body as { cmd: string[] }).cmd[2]!;
        const write = /^printf %s '([^']*)' \| base64 -d (>{1,2}) '(.+)'$/.exec(script);
        if (write) {
          const [, b64, redirect, path] = write;
          const chunk = Buffer.from(b64!, "base64");
          written[path!] =
            redirect === ">" ? chunk : Buffer.concat([written[path!] ?? Buffer.alloc(0), chunk]);
        }
        return { body: { exit_code: 0, stdout: "", stderr: "" } };
      },
    });
    const big = Buffer.from(
      Array.from({ length: 300 * 1024 }, (_, i) => i % 251),
    );
    await provider.putFiles(SBX, { "/work/big.bin": big, "/work/note.txt": "hello" });
    expect(written["/work/big.bin"]!.equals(big)).toBe(true);
    expect(written["/work/note.txt"]!.toString("utf8")).toBe("hello");
  });

  it("getFile decodes base64 and refuses truncated reads", async () => {
    const payload = Buffer.from("file-content-π");
    let truncate = false;
    const { provider } = makeProvider({
      "POST /apps/": () => ({
        body: { exit_code: 0, stdout: payload.toString("base64"), stderr: "" },
      }),
    });
    const got = await provider.getFile(SBX, "/x");
    expect(got.equals(payload)).toBe(true);
    expect(truncate).toBe(false);
  });
});

describe("FlyProvider.destroy / list", () => {
  it("destroy tolerates 404s (idempotent) and tears down machine THEN app", async () => {
    const order: string[] = [];
    const { provider } = makeProvider({
      "DELETE /apps/app1/machines/m1": () => {
        order.push("machine");
        return { status: 404, body: {} };
      },
      "DELETE /apps/app1": () => {
        order.push("app");
        return { status: 404, body: {} };
      },
    });
    await expect(
      provider.destroy({ id: "app1/m1", providerId: "fly", envKey: "k", createdAt: "t" }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["machine", "app"]);
  });

  it("list maps labeled machines across prefix apps, skipping the envs app and foreign machines", async () => {
    const { provider } = makeProvider({
      "GET /apps?org_slug=acme": () => ({
        body: {
          apps: [
            { name: "ol-trial-aaaa-000001" },
            { name: "ol-trial-envs" },
            { name: "unrelated-app" },
          ],
        },
      }),
      "GET /apps/ol-trial-aaaa-000001/machines": () => ({
        body: [
          {
            id: "m1",
            config: {
              metadata: {
                [SANDBOX_LABELS.owner]: "1",
                [SANDBOX_LABELS.createdAt]: "2026-07-06T00:00:00.000Z",
                [SANDBOX_LABELS.envKey]: "k1",
              },
            },
          },
          { id: "m2", config: { metadata: {} } }, // foreign — no owner label
        ],
      }),
    });
    const list = await provider.list();
    expect(list).toEqual([
      expect.objectContaining({ id: "ol-trial-aaaa-000001/m1", envKey: "k1", providerId: "fly" }),
    ]);
    expect(list[0]!.ageMs).toBeGreaterThan(0);
  });
});

describe("FlyProvider.prepareEnv", () => {
  it("skips build+push when the pushed tag exists locally (idempotence)", async () => {
    const execCalls: string[][] = [];
    const { fetchImpl } = mockFly({});
    const provider = new FlyProvider({
      apiToken: "tok",
      orgSlug: "acme",
      fetchImpl,
      execFileImpl: async (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return { stdout: "", stderr: "" }; // image inspect succeeds → tag exists
      },
    });
    const env = await provider.prepareEnv({ key: "cafe0123", baseImage: "alpine:3.20" });
    expect(env.built).toBe(false);
    expect(env.imageRef).toBe("registry.fly.io/ol-trial-envs:cafe0123");
    expect(execCalls).toEqual([["docker", "image", "inspect", "registry.fly.io/ol-trial-envs:cafe0123"]]);
  });

  it("hands the registry token to docker over stdin, never on the command line", async () => {
    const execCalls: { cmd: string; args: string[]; stdin?: string }[] = [];
    const { fetchImpl } = mockFly({});
    const provider = new FlyProvider({
      apiToken: "fly-registry-token",
      orgSlug: "acme",
      fetchImpl,
      localDocker: {
        prepareEnv: async () => ({
          key: "cafe0123",
          imageRef: "local/img:cafe0123",
          providerId: "local-docker",
          createdAt: "2026-07-06T00:00:00.000Z",
          built: true,
        }),
      } as never,
      execFileImpl: async (cmd, args, opts) => {
        execCalls.push({ cmd, args, stdin: opts?.stdin });
        // `image inspect` must fail so the build+push path runs.
        if (args[0] === "image") throw new Error("no such image");
        return { stdout: "", stderr: "" };
      },
    });

    await provider.prepareEnv({ key: "cafe0123", baseImage: "alpine:3.20" });

    const login = execCalls.find((c) => c.args[0] === "login");
    expect(login).toEqual({
      cmd: "docker",
      args: ["login", "registry.fly.io", "-u", "x", "--password-stdin"],
      stdin: "fly-registry-token",
    });
    // The token must not reach the process table via ANY docker invocation.
    expect(execCalls.flatMap((c) => c.args)).not.toContain("fly-registry-token");
  });
});
