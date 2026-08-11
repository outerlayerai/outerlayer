// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * End-to-end tests for the Claude Code plugin launcher
 * (claude-plugin/scripts/hook.mjs). The launcher is a standalone script the
 * plugin ships, not a package export, so these tests exercise the real thing
 * the way Claude Code runs it: a fresh node process per event, stdin
 * carrying the hook payload.
 *
 * Its contract mirrors the hook fast-path's: ALWAYS exit 0, no output of its
 * own, every failure swallowed. The sandbox redirects both seams the
 * launcher has — OUTERLAYER_HOME (the managed-install root) and
 * OUTERLAYER_NPM (the installer binary) — so no test touches the network or
 * the real home directory.
 */

const LAUNCHER = resolve(__dirname, "../../../../claude-plugin/scripts/hook.mjs");

let home: string;
let npmLog: string;
let entryLog: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-plugin-"));
  npmLog = join(home, "npm-invocations.log");
  entryLog = join(home, "entry-run.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A stub installer that records its argv — one line per invocation. */
function writeFakeNpm(): string {
  const bin = join(home, "fake-npm");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${npmLog}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A fake managed install whose entry records how it was invoked, emits one
 * JSON line on stdout (standing in for the SessionStart health report), and
 * exits 0 — the same dispatch surface as the real dist/index.js. */
function writeFakeInstall(entrySource?: string): { entry: string; pkgJson: string } {
  const pkgDir = join(home, "cli", "node_modules", "outerlayer");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  const pkgJson = join(pkgDir, "package.json");
  writeFileSync(pkgJson, JSON.stringify({ name: "outerlayer", version: "0.0.0-test" }));
  const entry = join(pkgDir, "dist", "index.js");
  writeFileSync(
    entry,
    entrySource ??
      [
        `import { readFileSync, writeFileSync } from "node:fs";`,
        `let stdin = "";`,
        `try { stdin = readFileSync(0, "utf8"); } catch {}`,
        `writeFileSync(${JSON.stringify(entryLog)}, JSON.stringify({`,
        `  argv: process.argv.slice(1),`,
        `  source: process.env.OUTERLAYER_HOOK_SOURCE ?? null,`,
        `  stdin,`,
        `}));`,
        `process.stdout.write('{"ok":true}');`,
        `process.exit(0);`,
      ].join("\n"),
  );
  return { entry, pkgJson };
}

function runLauncher(event: string, opts: { input?: string } = {}) {
  return spawnSync(process.execPath, [LAUNCHER, event], {
    input: opts.input ?? "",
    encoding: "utf8" as const,
    env: { ...process.env, OUTERLAYER_HOME: home, OUTERLAYER_NPM: writeFakeNpm() },
    timeout: 15_000,
  });
}

/** The detached installer may still be starting when the launcher exits. */
async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function npmInvocations(): string[] {
  if (!existsSync(npmLog)) return [];
  return readFileSync(npmLog, "utf8").split("\n").filter((l) => l.length > 0);
}

describe("plugin launcher: managed install present", () => {
  it("runs the managed CLI in-process with `hook <event>` argv, plugin provenance, and stdin passed through", async () => {
    const { entry } = writeFakeInstall();
    const payload = JSON.stringify({ session_id: "s1", transcript_path: "/t.jsonl", cwd: "/w" });
    const result = runLauncher("SessionEnd", { input: payload });
    expect(result.status).toBe(0);
    await waitForFile(entryLog);
    expect(JSON.parse(readFileSync(entryLog, "utf8"))).toEqual({
      argv: [entry, "hook", "SessionEnd"],
      source: "plugin",
      stdin: payload,
    });
    // No install triggered for a fresh install, and the CLI's own stdout
    // (the SessionStart health-report channel) passes through untouched.
    expect(npmInvocations()).toEqual([]);
    expect(result.stdout).toBe('{"ok":true}');
    expect(result.stderr).toBe("");
  });

  it("refreshes a stale install in the background while still running the current version", async () => {
    const { pkgJson } = writeFakeInstall();
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(pkgJson, eightDaysAgo, eightDaysAgo);
    const result = runLauncher("Stop");
    expect(result.status).toBe(0);
    await waitForFile(entryLog); // current version still ran
    await waitForFile(npmLog); // and a refresh started
    expect(npmInvocations()).toEqual([
      `install --prefix ${join(home, "cli")} --no-audit --no-fund --loglevel error outerlayer@latest`,
    ]);
  });

  it("self-heals a corrupt install: exit 0, no output, reinstall triggered", async () => {
    writeFakeInstall("this is not javascript(");
    const result = runLauncher("SessionStart");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await waitForFile(npmLog);
    expect(npmInvocations()).toHaveLength(1);
  });
});

describe("plugin launcher: no install yet", () => {
  it("drops the event, exits 0 silently, and starts exactly one background install", async () => {
    const result = runLauncher("SessionStart");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await waitForFile(npmLog);
    expect(npmInvocations()).toEqual([
      `install --prefix ${join(home, "cli")} --no-audit --no-fund --loglevel error outerlayer@latest`,
    ]);
  });

  it("a second invocation under a fresh install lock does not start a second install", async () => {
    expect(runLauncher("SessionStart").status).toBe(0);
    await waitForFile(npmLog);
    expect(runLauncher("Stop").status).toBe(0);
    // The second run must observe the lock, not the log — give a would-be
    // second installer time to appear before asserting it never did.
    await new Promise((r) => setTimeout(r, 200));
    expect(npmInvocations()).toHaveLength(1);
  });

  it("breaks a stale install lock left by a crashed install", async () => {
    mkdirSync(join(home, "cli"), { recursive: true });
    const lock = join(home, "cli", ".install-lock");
    writeFileSync(lock, "");
    const elevenMinAgo = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(lock, elevenMinAgo, elevenMinAgo);
    expect(runLauncher("SessionEnd").status).toBe(0);
    await waitForFile(npmLog);
    expect(npmInvocations()).toHaveLength(1);
  });

  it("an unavailable installer is swallowed: exit 0, nothing on stdout/stderr", () => {
    const result = spawnSync(process.execPath, [LAUNCHER, "SessionStart"], {
      input: "",
      encoding: "utf8" as const,
      env: { ...process.env, OUTERLAYER_HOME: home, OUTERLAYER_NPM: join(home, "does-not-exist") },
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("plugin launcher: prewarm (Setup hook)", () => {
  it("installs in the foreground — the installer has run by the time the launcher exits", () => {
    const result = runLauncher("prewarm");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    // Foreground: no waitForFile needed.
    expect(npmInvocations()).toEqual([
      `install --prefix ${join(home, "cli")} --no-audit --no-fund --loglevel error outerlayer@latest`,
    ]);
    expect(existsSync(entryLog)).toBe(false); // prewarm never runs the CLI
  });
});
