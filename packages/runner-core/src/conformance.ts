// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Provider conformance suite — the executable contract every
 * SandboxProvider must pass, including future managed vendors ("no
 * runner-core changes allowed; if any are needed, fix the abstraction").
 *
 * Usage in a provider's test file:
 *
 *   conformanceSuite({
 *     name: "local-docker",
 *     makeProvider: () => new LocalDockerProvider(),
 *     baseImage: "alpine:3.20",
 *     hooks: { inspectConfigEnv, inspectImageHistory, cleanupEnvImage },
 *   });
 *
 * Gated behind OUTERLAYER_CONFORMANCE=1 (touches real infrastructure).
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { EnvRef, Sandbox, SandboxProvider } from "./types.js";
import { reapOrphans } from "./reaper.js";

export interface ConformanceHooks {
  /** Environment visible on sandbox-level config — the secret-leak surface. */
  inspectConfigEnv?(provider: SandboxProvider, sandbox: Sandbox): Promise<string[]>;
  /** Layer/creation history of an env snapshot — the other leak surface. */
  inspectImageHistory?(provider: SandboxProvider, env: EnvRef): Promise<string[]>;
  /** Remove a snapshot so prepareEnv cache tests start cold. */
  cleanupEnvImage?(provider: SandboxProvider, key: string): Promise<void>;
}

export interface ConformanceOptions {
  name: string;
  makeProvider: () => SandboxProvider;
  /** Small image with /bin/sh + wget (alpine-class). */
  baseImage: string;
  warmBootBudgetMs?: number;
  parallelSandboxes?: number;
  hooks?: ConformanceHooks;
}

export function conformanceSuite(options: ConformanceOptions): void {
  const enabled = process.env.OUTERLAYER_CONFORMANCE === "1";
  const suite = enabled ? describe : describe.skip;
  const warmBudget = options.warmBootBudgetMs ?? 30_000;
  const parallel = options.parallelSandboxes ?? 10;
  const runId = randomBytes(4).toString("hex");
  const envKey = `conf-${runId}`;
  const CANARY = `OL_SECRET_${runId}`;

  suite(`SandboxProvider conformance: ${options.name}`, () => {
    const provider = options.makeProvider();
    let env: EnvRef;
    const leftovers: Sandbox[] = [];

    async function cleanDestroy(sandbox: Sandbox): Promise<void> {
      leftovers.splice(leftovers.indexOf(sandbox), 1);
      await provider.destroy(sandbox);
    }
    async function track(sandbox: Sandbox): Promise<Sandbox> {
      leftovers.push(sandbox);
      return sandbox;
    }

    it("prepareEnv builds once and is idempotent on the key", async () => {
      let buildRuns = 0;
      const build = async (sandbox: Sandbox, p: SandboxProvider) => {
        buildRuns += 1;
        // bake a marker file AND exercise per-exec env during build: the
        // canary must never survive into the snapshot's config/history
        const r = await p.exec(sandbox, `echo "built-${runId}" > /etc/ol-marker`, {
          env: { BUILD_SECRET: CANARY },
        });
        expect(r.code).toBe(0);
      };
      env = await provider.prepareEnv({ key: envKey, baseImage: options.baseImage, build });
      expect(env.built).toBe(true);
      expect(env.key).toBe(envKey);

      const again = await provider.prepareEnv({ key: envKey, baseImage: options.baseImage, build });
      expect(again.built).toBe(false);
      expect(again.imageRef).toBe(env.imageRef);
      expect(buildRuns).toBe(1);
    });

    it(`warm boot + exec round-trip within ${warmBudget}ms`, async () => {
      const started = Date.now();
      const sandbox = await track(await provider.create(env));
      const result = await provider.exec(sandbox, "cat /etc/ol-marker");
      const elapsed = Date.now() - started;
      await cleanDestroy(sandbox);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(`built-${runId}`);
      expect(elapsed).toBeLessThan(warmBudget);
    });

    it("exec returns nonzero exit codes as data, never throws", async () => {
      const sandbox = await track(await provider.create(env));
      const result = await provider.exec(sandbox, "exit 42");
      expect(result.code).toBe(42);
      const stderr = await provider.exec(sandbox, "echo oops >&2; exit 1");
      expect(stderr.code).toBe(1);
      expect(stderr.stderr).toContain("oops");
      expect(stderr.stdout).not.toContain("oops");
      await cleanDestroy(sandbox);
    });

    it("bounds output capture and flags truncation", async () => {
      const sandbox = await track(await provider.create(env));
      const result = await provider.exec(sandbox, "yes x | head -c 200000", {
        maxOutputBytes: 64 * 1024,
      });
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
      const small = await provider.exec(sandbox, "echo tiny", { maxOutputBytes: 64 * 1024 });
      expect(small.truncated).toBe(false);
      await cleanDestroy(sandbox);
    });

    it("exec timeout yields code 124 + timedOut, sandbox remains destroyable", async () => {
      const sandbox = await track(await provider.create(env));
      const result = await provider.exec(sandbox, "sleep 30", { timeoutMs: 2_000 });
      expect(result.timedOut).toBe(true);
      expect(result.code).toBe(124);
      expect(result.ms).toBeLessThan(10_000);
      await cleanDestroy(sandbox);
    });

    it("putFiles/getFile round-trips binary and utf8 content at nested paths", async () => {
      const sandbox = await track(await provider.create(env));
      const binary = randomBytes(64 * 1024);
      const text = "línea uno\nline two\n";
      await provider.putFiles(sandbox, {
        "/work/deep/nested/blob.bin": binary,
        "/work/notes.txt": text,
      });
      const gotBinary = await provider.getFile(sandbox, "/work/deep/nested/blob.bin");
      const gotText = await provider.getFile(sandbox, "/work/notes.txt");
      expect(gotBinary.equals(binary)).toBe(true);
      expect(gotText.toString("utf8")).toBe(text);
      await cleanDestroy(sandbox);
    });

    it("per-exec env reaches the command but never sandbox config nor snapshot layers", async () => {
      const sandbox = await track(await provider.create(env));
      const seen = await provider.exec(sandbox, 'echo "got:$TRIAL_SECRET"', {
        env: { TRIAL_SECRET: CANARY },
      });
      expect(seen.stdout).toContain(`got:${CANARY}`);

      if (options.hooks?.inspectConfigEnv) {
        const configEnv = await options.hooks.inspectConfigEnv(provider, sandbox);
        expect(configEnv.join("\n")).not.toContain(CANARY);
      }
      if (options.hooks?.inspectImageHistory) {
        const history = await options.hooks.inspectImageHistory(provider, env);
        expect(history.join("\n")).not.toContain(CANARY);
      }
      await cleanDestroy(sandbox);
    });

    it(`${parallel} parallel sandboxes create/exec/destroy cleanly`, async () => {
      const sandboxes = await Promise.all(
        Array.from({ length: parallel }, () => provider.create(env)),
      );
      sandboxes.forEach((s) => leftovers.push(s));
      const results = await Promise.all(
        sandboxes.map((s, i) => provider.exec(s, `echo par-${i}`)),
      );
      results.forEach((r, i) => {
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe(`par-${i}`);
      });
      await Promise.all(sandboxes.map((s) => cleanDestroy(s)));
    });

    it("destroy is idempotent (second call resolves)", async () => {
      const sandbox = await provider.create(env);
      await provider.destroy(sandbox);
      await expect(provider.destroy(sandbox)).resolves.toBeUndefined();
    });

    it("abandoned sandboxes are reaped by TTL (crash-recovery contract)", async () => {
      const orphan = await provider.create(env, { labels: { "conf-orphan": runId } });
      // no destroy — simulate a dead harness process
      const report = await reapOrphans(provider, { ttlMs: 0 });
      expect(report.destroyed.map((s) => s.id)).toContain(orphan.id);
      const remaining = await provider.list();
      expect(remaining.map((s) => s.id)).not.toContain(orphan.id);
    });

    it("network:none blocks egress; default allows it", async () => {
      const offline = await track(await provider.create(env, { network: "none" }));
      const blocked = await provider.exec(
        offline,
        "wget -T 3 -q -O /dev/null http://example.com && echo EGRESS_OK || echo EGRESS_BLOCKED",
        { timeoutMs: 15_000 },
      );
      expect(blocked.stdout).toContain("EGRESS_BLOCKED");
      await cleanDestroy(offline);

      const online = await track(await provider.create(env, { network: "default" }));
      const allowed = await provider.exec(
        online,
        "wget -T 5 -q -O /dev/null http://example.com && echo EGRESS_OK || echo EGRESS_BLOCKED",
        { timeoutMs: 20_000 },
      );
      expect(allowed.stdout).toContain("EGRESS_OK");
      await cleanDestroy(online);
    });

    it("resource caps contain a fork bomb; the host and provider stay usable", async () => {
      const capped = await track(
        await provider.create(env, { cpus: 1, memMb: 128, pidsLimit: 64 }),
      );
      const bomb = await provider.exec(capped, 'b(){ b|b & }; b; sleep 5; echo SURVIVED', {
        timeoutMs: 20_000,
      });
      // the bomb either errors out on the pid cap or times out — both are
      // contained outcomes; what matters is the provider still works:
      expect(bomb.ms).toBeLessThan(25_000);
      await cleanDestroy(capped);
      const fresh = await track(await provider.create(env));
      const alive = await provider.exec(fresh, "echo healthy");
      expect(alive.stdout.trim()).toBe("healthy");
      await cleanDestroy(fresh);
    });

    it("cleanup: no conformance sandboxes left behind", async () => {
      for (const sandbox of [...leftovers]) {
        await provider.destroy(sandbox);
      }
      await reapOrphans(provider, { ttlMs: 60 * 60 * 1000 });
      const remaining = (await provider.list()).filter((s) => s.envKey === envKey);
      expect(remaining).toEqual([]);
      if (options.hooks?.cleanupEnvImage) {
        await options.hooks.cleanupEnvImage(provider, envKey);
      }
    });
  });
}
