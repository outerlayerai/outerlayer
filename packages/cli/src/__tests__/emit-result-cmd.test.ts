// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEmitResult, EmitResultError } from "../emit-result-cmd.js";

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-emitres-home-"));
  // realpath so cwd comparisons are not confused by macOS's /var → /private/var symlink
  work = realpathSync(mkdtempSync(join(tmpdir(), "ol-emitres-work-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

type FetchCall = { url: string; init: RequestInit };

function acceptingFetch(
  calls: FetchCall[],
  data: Record<string, unknown> = {
    id: "emitted-1",
    name: "smoke.pass",
    result: "pass",
    provenance: "ci",
    verification: "confirmed",
    prNumber: 61,
    repository: "acme/app",
  },
): typeof fetch {
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

const CREDS = { url: "https://gw.outerlayer.test", apiKey: "sk_test", appId: "app-1" };
const LINK = "https://github.com/acme/app/actions/runs/123";

/** Real git repo with a remote and one commit — resolveRepoIdentity shells
 * out to git, so the fixture must be a genuine checkout. */
function makeGitRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ol-emitres-repo-")));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@test.invalid", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
  return dir;
}

describe("runEmitResult — validation (before any I/O)", () => {
  it("rejects a name off the declaration shape, naming the allowed form", async () => {
    const err = await runEmitResult({
      name: "Smoke.Pass", link: LINK, pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmitResultError);
    expect((err as Error).message).toContain('invalid name "Smoke.Pass"');
    expect((err as Error).message).toContain("1-64 characters");
    expect((err as Error).message).toContain("smoke.pass");
  });

  it("requires --link, saying what the link is for — an empty value counts as missing", async () => {
    await expect(
      runEmitResult({ name: "smoke.pass", pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS }),
    ).rejects.toThrow(/--link is required — the row's proof link is the CI run/);
    await expect(
      runEmitResult({ name: "smoke.pass", link: "", pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS }),
    ).rejects.toThrow(/--link is required/);
  });

  it("rejects a non-http(s) link", async () => {
    await expect(
      runEmitResult({ name: "smoke.pass", link: "ftp://ci.example/run/1", pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS }),
    ).rejects.toThrow(/invalid --link "ftp:\/\/ci\.example\/run\/1" — expected an http:\/\/ or https:\/\/ URL/);
  });

  it("rejects a link over the length cap instead of truncating it — exactly 500 is accepted", async () => {
    const over = `https://${"a".repeat(493)}`; // 501 chars
    await expect(
      runEmitResult({ name: "smoke.pass", link: over, pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS }),
    ).rejects.toThrow(/link is 501 characters — the cap is 500/);

    const atCap = `https://${"a".repeat(492)}`; // 500 chars
    const calls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: atCap, pr: 7, cwd: work, home, quiet: true,
      env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
    expect(payload.emit.link).toBe(atCap);
  });

  it("rejects a result off the pass/fail pair", async () => {
    await expect(
      runEmitResult({ name: "smoke.pass", link: LINK, result: "skip", pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS }),
    ).rejects.toThrow(/invalid --result "skip" — expected "pass" or "fail"/);
  });

  it("rejects a non-positive or non-numeric --pr, echoing the given value", async () => {
    for (const pr of [0, -3, "0", "abc", "1.5"]) {
      const err = await runEmitResult({
        name: "smoke.pass", link: LINK, pr, cwd: work, home, quiet: true, env: {}, ...CREDS,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmitResultError);
      expect((err as Error).message).toContain(`invalid --pr "${pr}"`);
      expect((err as Error).message).toContain("positive integer");
    }
  });

  it("validates flags before resolving anchors or credentials — a bad name fails even with nothing else set", async () => {
    const calls: FetchCall[] = [];
    const err = await runEmitResult({
      name: "!bad", cwd: work, home, quiet: true, env: {}, fetchImpl: acceptingFetch(calls),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmitResultError);
    expect((err as Error).message).toContain('invalid name "!bad"');
    expect(calls).toEqual([]);
  });
});

describe("runEmitResult — anchor resolution", () => {
  it("takes the PR number from GITHUB_REF's refs/pull/<n>/ shape", async () => {
    const calls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, cwd: work, home, quiet: true,
      env: { CI: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_REF: "refs/pull/61/merge" },
      ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
    expect(payload.emit.prNumber).toBe(61);
  });

  it("falls back to the GITHUB_EVENT_PATH payload for the PR number when GITHUB_REF has none", async () => {
    writeFileSync(join(work, "event.json"), JSON.stringify({ pull_request: { number: 88 } }));
    const calls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, cwd: work, home, quiet: true,
      env: { CI: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_EVENT_PATH: join(work, "event.json") },
      ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
    expect(payload.emit.prNumber).toBe(88);
  });

  it("lets an explicit --pr override the CI environment's PR context", async () => {
    const calls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, pr: "907", cwd: work, home, quiet: true,
      env: { CI: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_REF: "refs/pull/61/merge" },
      ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
    expect(payload.emit.prNumber).toBe(907);
  });

  it("refuses without a PR number, pointing at --pr and the pull_request CI event", async () => {
    const calls: FetchCall[] = [];
    const err = await runEmitResult({
      name: "smoke.pass", link: LINK, cwd: work, home, quiet: true,
      env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch(calls),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmitResultError);
    expect((err as Error).message).toContain("nothing to attach this to — no PR number");
    expect((err as Error).message).toContain("--pr");
    expect((err as Error).message).toContain("pull_request");
    expect(calls).toEqual([]);
  });

  it("refuses with a PR but no repository — not in CI and not a git checkout", async () => {
    const calls: FetchCall[] = [];
    const err = await runEmitResult({
      name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true, env: {}, ...CREDS,
      fetchImpl: acceptingFetch(calls),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmitResultError);
    expect((err as Error).message).toContain("nothing to attach this to — no repository");
    expect((err as Error).message).toContain("GITHUB_REPOSITORY");
    expect(calls).toEqual([]);
  });

  it("anchors to the git checkout as gitRepo when GITHUB_REPOSITORY is absent", async () => {
    const repo = makeGitRepo();
    try {
      const calls: FetchCall[] = [];
      await runEmitResult({
        name: "smoke.pass", link: LINK, pr: 7, cwd: repo, home, quiet: true, env: {},
        ...CREDS, fetchImpl: acceptingFetch(calls),
      });
      const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
      expect(payload.emit.gitRepo).toBe("github.com/acme/app");
      expect("repository" in payload.emit).toBe(false);
      expect("ci" in payload.emit).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("sends only the CI repository when GITHUB_REPOSITORY is set, even inside a git checkout", async () => {
    const repo = makeGitRepo();
    try {
      const calls: FetchCall[] = [];
      await runEmitResult({
        name: "smoke.pass", link: LINK, pr: 7, cwd: repo, home, quiet: true,
        env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch(calls),
      });
      const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
      expect(payload.emit.repository).toBe("acme/app");
      expect("gitRepo" in payload.emit).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runEmitResult — credentials", () => {
  function writeCloudConfig(config: Record<string, string>): void {
    mkdirSync(join(home, ".outerlayer"), { recursive: true });
    writeFileSync(join(home, ".outerlayer", "config.json"), JSON.stringify(config));
  }

  it("uses sync's missing-credentials error style", async () => {
    await expect(
      runEmitResult({ name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true, env: { GITHUB_REPOSITORY: "acme/app" } }),
    ).rejects.toThrow(/missing --url, --api-key, --app-id.*OUTERLAYER_URL \/ OUTERLAYER_API_KEY \/ OUTERLAYER_APP_ID/);
  });

  it("reads credentials from the config file when flags and env are absent", async () => {
    writeCloudConfig({ url: "https://config.outerlayer.test", apiKey: "sk_config", appId: "app-config" });
    const calls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
      env: { GITHUB_REPOSITORY: "acme/app" }, fetchImpl: acceptingFetch(calls),
    });
    expect(calls.map((c) => c.url)).toEqual(["https://config.outerlayer.test/v1/emitted-results"]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_config");
    expect(headers["x-outerlayer-app-id"]).toBe("app-config");
  });

  it("prefers env vars over the config file, and flags over both", async () => {
    writeCloudConfig({ url: "https://config.outerlayer.test", apiKey: "sk_config", appId: "app-config" });
    const envCreds = {
      GITHUB_REPOSITORY: "acme/app",
      OUTERLAYER_URL: "https://env.outerlayer.test",
      OUTERLAYER_API_KEY: "sk_env",
      OUTERLAYER_APP_ID: "app-env",
    };

    const envCalls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
      env: envCreds, fetchImpl: acceptingFetch(envCalls),
    });
    expect(envCalls.map((c) => c.url)).toEqual(["https://env.outerlayer.test/v1/emitted-results"]);
    expect((envCalls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_env");

    const flagCalls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
      env: envCreds, ...CREDS, fetchImpl: acceptingFetch(flagCalls),
    });
    expect(flagCalls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/emitted-results"]);
    const headers = flagCalls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test");
    expect(headers["x-outerlayer-app-id"]).toBe("app-1");
  });
});

describe("runEmitResult — wire contract and output", () => {
  // proves AC-085-12 — the wire payload carries the declared name, the
  // outcome, the proof link, and the PR anchor from the CI environment, with
  // the advisory ci marker — and NO provenance field: the server derives
  // provenance from how the emit arrived, so a caller can never claim it.
  it("POSTs /v1/emitted-results with the exact payload and headers", async () => {
    const calls: FetchCall[] = [];
    const result = await runEmitResult({
      name: "smoke.pass",
      link: LINK,
      result: "fail",
      cwd: work,
      home,
      quiet: true,
      env: { CI: "true", GITHUB_REPOSITORY: "Acme/App", GITHUB_REF: "refs/pull/61/merge" },
      now: () => new Date("2026-08-14T10:00:00.000Z"),
      ...CREDS,
      fetchImpl: acceptingFetch(calls),
    });

    expect(calls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/emitted-results"]);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk_test",
      "x-outerlayer-app-id": "app-1",
    });

    const payload = JSON.parse(String(calls[0]!.init.body)) as {
      schemaVersion: number;
      emit: Record<string, unknown>;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.emit).toEqual({
      clientEmitId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "smoke.pass",
      result: "fail",
      link: LINK,
      emittedAt: "2026-08-14T10:00:00.000Z",
      ci: true,
      prNumber: 61,
      repository: "Acme/App",
    });
    // The exact-match above already excludes extra keys; pin the one the
    // contract forbids by name as well.
    expect("provenance" in payload.emit).toBe(false);
    expect("gitRepo" in payload.emit).toBe(false);

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      id: "emitted-1",
      name: "smoke.pass",
      result: "pass",
      provenance: "ci",
      verification: "confirmed",
      prNumber: 61,
      repository: "acme/app",
    });
  });

  it("defaults the result to pass and omits the ci marker outside CI", async () => {
    const calls: FetchCall[] = [];
    await runEmitResult({
      name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
      env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { emit: Record<string, unknown> };
    expect(payload.emit.result).toBe("pass");
    expect("ci" in payload.emit).toBe(false);
  });

  it("401 surfaces the actionable auth message", async () => {
    const unauthorized = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(
      runEmitResult({
        name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
        env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: unauthorized,
      }),
    ).rejects.toThrow(/not authorized — the API key is unknown, expired, or bound to a different app/);
  });

  it("other non-2xx surfaces the status and a body snippet", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { code: "nothing_to_attach", message: "nothing to attach this to" } }), {
        status: 400,
      })) as typeof fetch;
    await expect(
      runEmitResult({
        name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
        env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: failing,
      }),
    ).rejects.toThrow(/emit failed \(400\): .*nothing_to_attach/);
  });

  it("renders the success line with the name, outcome, and PR anchor", async () => {
    const calls: FetchCall[] = [];
    const result = await runEmitResult({
      name: "smoke.pass", link: LINK, result: "fail", pr: 7, cwd: work, home, quiet: true,
      env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    expect(result.output).toContain("emitted smoke.pass (fail)");
    expect(result.output).toContain("PR #7");
    expect(result.exitCode).toBe(0);
  });

  it("writes the success line to stdout unless quiet", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    try {
      await runEmitResult({
        name: "smoke.pass", link: LINK, pr: 7, cwd: work, home,
        env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch([]),
      });
      expect(writes.join("")).toContain("emitted smoke.pass (pass)");

      writes.length = 0;
      await runEmitResult({
        name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true,
        env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS, fetchImpl: acceptingFetch([]),
      });
      expect(writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("--json prints the response body's data object", async () => {
    const calls: FetchCall[] = [];
    const result = await runEmitResult({
      name: "smoke.pass", link: LINK, pr: 7, cwd: work, home, quiet: true, json: true,
      env: { GITHUB_REPOSITORY: "acme/app" }, ...CREDS,
      fetchImpl: acceptingFetch(calls, { id: "emitted-9", name: "smoke.pass", result: "pass", provenance: "local", verification: "pending", prNumber: 7, repository: "acme/app" }),
    });
    expect(JSON.parse(result.output)).toEqual({
      id: "emitted-9",
      name: "smoke.pass",
      result: "pass",
      provenance: "local",
      verification: "pending",
      prNumber: 7,
      repository: "acme/app",
    });
  });
});
