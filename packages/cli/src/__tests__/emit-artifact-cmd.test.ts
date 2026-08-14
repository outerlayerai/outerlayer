// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEmitArtifact, EmitArtifactError } from "../emit-artifact-cmd.js";
import { artifactBlobsDir, artifactsSpoolPath } from "../artifact-spool.js";
import { detectActiveSession, SESSION_DETECT_MAX_AGE_MS, SESSION_DETECT_TAIL_BYTES } from "../session-detect.js";

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ol-emitart-home-"));
  // realpath so cwd comparisons are not confused by macOS's /var → /private/var symlink
  work = realpathSync(mkdtempSync(join(tmpdir(), "ol-emitart-work-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from("not-a-real-png-but-real-bytes");
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");

function writeArtifactFile(dir: string, name = "shot.png", bytes: Buffer = PNG_BYTES): void {
  writeFileSync(join(dir, name), bytes);
}

type FetchCall = { url: string; init: RequestInit };

function acceptingFetch(
  calls: FetchCall[],
  data: Record<string, unknown> = { artifactId: "art-1", provenance: "local", kind: "screenshot" },
): typeof fetch {
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

const CREDS = { url: "https://gw.outerlayer.test", apiKey: "sk_test", appId: "app-1" };

/** Real git repo with a remote and one commit — resolveRepoIdentity shells
 * out to git, so the fixture must be a genuine checkout. */
function makeGitRepo(): { dir: string; sha: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ol-emitart-repo-")));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@test.invalid", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
  const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, sha };
}

function writeSpoolEvent(record: Record<string, unknown>): void {
  mkdirSync(join(home, ".outerlayer", "spool"), { recursive: true });
  appendFileSync(join(home, ".outerlayer", "spool", "events.jsonl"), JSON.stringify(record) + "\n");
}

describe("runEmitArtifact — direct upload", () => {
  // proves AC-083-01 — the wire payload carries the client-computed identity
  // fields (sha256 of the actual bytes, media type from the extension, the
  // caption and criterion id) and NEITHER kind NOR provenance: the server
  // derives both, so a caller can never claim a stronger kind or origin.
  it("POSTs /v1/artifacts with the exact artifact fields and renders the response", async () => {
    writeArtifactFile(work);
    const calls: FetchCall[] = [];
    const result = await runEmitArtifact({
      file: "shot.png",
      cwd: work,
      home,
      quiet: true,
      env: {},
      caption: "checkout flow passes",
      criterionId: "AC-083-01",
      pr: 7,
      ...CREDS,
      fetchImpl: acceptingFetch(calls),
    });

    expect(calls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/artifacts"]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test");
    expect(headers["x-outerlayer-app-id"]).toBe("app-1");
    expect(headers["content-type"]).toBe("application/json");

    const payload = JSON.parse(String(calls[0]!.init.body)) as {
      schemaVersion: number;
      artifact: Record<string, unknown>;
      blob: { data: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.artifact).toEqual({
      clientArtifactId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      filename: "shot.png",
      mediaType: "image/png",
      bytes: PNG_BYTES.length,
      sha256: PNG_SHA,
      caption: "checkout flow passes",
      criterionId: "AC-083-01",
      emittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      ci: false,
      prNumber: 7,
    });
    // The exact-match above already excludes extra keys; pin the two the
    // contract forbids by name as well.
    expect("kind" in payload.artifact).toBe(false);
    expect("provenance" in payload.artifact).toBe(false);
    expect(payload.blob.data).toBe(PNG_BYTES.toString("base64"));

    expect(result.spooled).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("artifact accepted");
    expect(result.output).toContain("screenshot shot.png");
    expect(result.output).toContain("provenance local");
    expect(result.output).toContain("pr #7");
  });

  // proves AC-083-03 — in CI the payload self-identifies: ci true, the
  // repository from the Actions env, and the PR number parsed from
  // GITHUB_REF's refs/pull/<n>/ shape.
  it("carries ci, repository, and the GITHUB_REF PR number from the CI env", async () => {
    writeArtifactFile(work, "report.html", Buffer.from("<html>e2e</html>"));
    const calls: FetchCall[] = [];
    await runEmitArtifact({
      file: "report.html",
      cwd: work,
      home,
      quiet: true,
      env: { CI: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_REF: "refs/pull/61/merge" },
      caption: "e2e report",
      ...CREDS,
      fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { artifact: Record<string, unknown> };
    expect(payload.artifact.ci).toBe(true);
    expect(payload.artifact.repository).toBe("acme/app");
    expect(payload.artifact.prNumber).toBe(61);
    expect(payload.artifact.mediaType).toBe("text/html");
  });

  it("falls back to the GITHUB_EVENT_PATH payload for the PR number when GITHUB_REF has none", async () => {
    writeArtifactFile(work);
    writeFileSync(join(work, "event.json"), JSON.stringify({ pull_request: { number: 88 } }));
    const calls: FetchCall[] = [];
    await runEmitArtifact({
      file: "shot.png",
      cwd: work,
      home,
      quiet: true,
      env: { CI: "true", GITHUB_REPOSITORY: "acme/app", GITHUB_EVENT_PATH: join(work, "event.json") },
      caption: "from a workflow_dispatch-ish event",
      ...CREDS,
      fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { artifact: Record<string, unknown> };
    expect(payload.artifact.prNumber).toBe(88);
  });

  // proves AC-083-04 — a plain developer machine outside any session or CI
  // still anchors to the git checkout: repo identity rides along, ci is
  // false, and there is no session (and no CI repository) field at all.
  it("anchors to the git checkout with ci false and no session", async () => {
    const { dir: repo, sha } = makeGitRepo();
    try {
      writeArtifactFile(repo);
      const calls: FetchCall[] = [];
      await runEmitArtifact({
        file: "shot.png",
        cwd: repo,
        home,
        quiet: true,
        env: {},
        caption: "local proof",
        ...CREDS,
        fetchImpl: acceptingFetch(calls),
      });
      const payload = JSON.parse(String(calls[0]!.init.body)) as { artifact: Record<string, unknown> };
      expect(payload.artifact.gitRepo).toBe("github.com/acme/app");
      expect(payload.artifact.gitBranch).toBe("main");
      expect(payload.artifact.commitSha).toBe(sha);
      expect(payload.artifact.ci).toBe(false);
      expect("session" in payload.artifact).toBe(false);
      expect("repository" in payload.artifact).toBe(false);
      expect("prNumber" in payload.artifact).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // proves AC-083-06 — with no anchor at all (no session, no CI PR context,
  // no git checkout, no --pr) the command refuses outright: nothing spools,
  // nothing uploads, and the message names every way to provide an anchor.
  it("refuses with 'nothing to attach this to' and touches nothing", async () => {
    writeArtifactFile(work);
    const calls: FetchCall[] = [];
    const err = await runEmitArtifact({
      file: "shot.png",
      cwd: work,
      home,
      quiet: true,
      env: {},
      caption: "orphan",
      ...CREDS,
      fetchImpl: acceptingFetch(calls),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmitArtifactError);
    expect((err as Error).message).toContain("nothing to attach this to");
    expect((err as Error).message).toContain("--pr");
    expect(calls).toEqual([]);
    expect(existsSync(artifactsSpoolPath(home))).toBe(false);
    expect(existsSync(artifactBlobsDir(home))).toBe(false);
  });

  it("uploads an unknown extension as application/octet-stream and displays kind `file`", async () => {
    writeArtifactFile(work, "data.bin", Buffer.from("binary-things"));
    const calls: FetchCall[] = [];
    const result = await runEmitArtifact({
      file: "data.bin",
      cwd: work,
      home,
      quiet: true,
      env: {},
      caption: "raw dump",
      pr: 3,
      ...CREDS,
      fetchImpl: acceptingFetch(calls),
    });
    const payload = JSON.parse(String(calls[0]!.init.body)) as { artifact: Record<string, unknown> };
    expect(payload.artifact.mediaType).toBe("application/octet-stream");
    expect(result.output).toContain("file data.bin");
  });

  it("uses sync's missing-credentials error style on the direct path", async () => {
    writeArtifactFile(work);
    await expect(
      runEmitArtifact({ file: "shot.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1 }),
    ).rejects.toThrow(/missing --url, --api-key, --app-id.*OUTERLAYER_URL \/ OUTERLAYER_API_KEY \/ OUTERLAYER_APP_ID/);
  });

  it("reads credentials from env vars when flags are absent", async () => {
    writeArtifactFile(work);
    const calls: FetchCall[] = [];
    await runEmitArtifact({
      file: "shot.png",
      cwd: work,
      home,
      quiet: true,
      env: { OUTERLAYER_URL: CREDS.url, OUTERLAYER_API_KEY: CREDS.apiKey, OUTERLAYER_APP_ID: CREDS.appId },
      caption: "x",
      pr: 1,
      fetchImpl: acceptingFetch(calls),
    });
    expect(calls.map((c) => c.url)).toEqual(["https://gw.outerlayer.test/v1/artifacts"]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${CREDS.apiKey}`);
  });

  it("401 surfaces the actionable auth message", async () => {
    writeArtifactFile(work);
    const unauthorized = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(
      runEmitArtifact({ file: "shot.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS, fetchImpl: unauthorized }),
    ).rejects.toThrow(/not authorized/);
  });

  it("other non-2xx surfaces the status and a body snippet", async () => {
    writeArtifactFile(work);
    const failing = (async () => new Response("blob store unavailable", { status: 503 })) as typeof fetch;
    await expect(
      runEmitArtifact({ file: "shot.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS, fetchImpl: failing }),
    ).rejects.toThrow(/artifact upload failed \(503\): blob store unavailable/);
  });

  it("--json prints the response body's data object", async () => {
    writeArtifactFile(work);
    const calls: FetchCall[] = [];
    const result = await runEmitArtifact({
      file: "shot.png",
      cwd: work,
      home,
      quiet: true,
      json: true,
      env: {},
      caption: "x",
      pr: 1,
      ...CREDS,
      fetchImpl: acceptingFetch(calls, { artifactId: "art-9", provenance: "local", kind: "screenshot" }),
    });
    expect(JSON.parse(result.output)).toEqual({ artifactId: "art-9", provenance: "local", kind: "screenshot" });
  });
});

describe("runEmitArtifact — spool path (inside a recorded session)", () => {
  // proves AC-083-02 — inside a live recorded session (CLAUDECODE set and a
  // fresh matching events.jsonl record) the bytes spool locally, content-
  // addressed, for the next sync — and NOTHING goes over the wire.
  it("writes the spool record and the content-addressed blob, and never fetches", async () => {
    const { dir: repo, sha } = makeGitRepo();
    try {
      const video = Buffer.from("webm-bytes-of-the-demo");
      const videoSha = createHash("sha256").update(video).digest("hex");
      writeArtifactFile(repo, "demo.webm", video);
      writeSpoolEvent({
        t: new Date().toISOString(),
        event: "PostToolUse",
        sessionId: "sess-abc-123",
        transcriptPath: null,
        cwd: repo,
      });
      const calls: FetchCall[] = [];
      const result = await runEmitArtifact({
        file: "demo.webm",
        cwd: repo,
        home,
        quiet: true,
        env: { CLAUDECODE: "1" },
        caption: "records the whole checkout flow",
        pr: 12,
        fetchImpl: acceptingFetch(calls),
      });

      expect(calls).toEqual([]);
      const lines = readFileSync(artifactsSpoolPath(home), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const { artifactId, t, ...rest } = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(artifactId).toMatch(/^[0-9a-f-]{36}$/);
      expect(String(t)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(rest).toEqual({
        rec: "artifact",
        sessionId: "sess-abc-123",
        cwd: repo,
        gitRepo: "github.com/acme/app",
        gitBranch: "main",
        commitSha: sha,
        prNumber: 12,
        filename: "demo.webm",
        mediaType: "video/webm",
        bytes: video.length,
        sha256: videoSha,
        caption: "records the whole checkout flow",
      });
      expect(readFileSync(join(artifactBlobsDir(home), videoSha))).toEqual(video);

      expect(result.spooled).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("spooled");
      expect(result.output).toContain("video demo.webm");
      expect(result.output).toContain("session sess-abc");
      expect(result.output).toContain("outerlayer sync");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("spool --json emits {spooled: true, record} with the record it wrote", async () => {
    writeArtifactFile(work);
    writeSpoolEvent({ t: new Date().toISOString(), event: "PostToolUse", sessionId: "sess-json", transcriptPath: null, cwd: work });
    const result = await runEmitArtifact({
      file: "shot.png",
      cwd: work,
      home,
      quiet: true,
      json: true,
      env: { CLAUDECODE: "1" },
      caption: "x",
    });
    const parsed = JSON.parse(result.output) as { spooled: boolean; record: Record<string, unknown> };
    expect(parsed.spooled).toBe(true);
    expect(parsed.record).toEqual(JSON.parse(readFileSync(artifactsSpoolPath(home), "utf8").trim()));
    expect(parsed.record.sessionId).toBe("sess-json");
  });
});

describe("runEmitArtifact — validation", () => {
  it("requires --caption", async () => {
    writeArtifactFile(work);
    await expect(
      runEmitArtifact({ file: "shot.png", cwd: work, home, quiet: true, env: {}, pr: 1, ...CREDS }),
    ).rejects.toThrow(/missing --caption/);
  });

  it("rejects an invalid --for id, naming the allowed shape", async () => {
    writeArtifactFile(work);
    const err = await runEmitArtifact({
      file: "shot.png", cwd: work, home, quiet: true, env: {}, caption: "x", criterionId: "not a valid id!", pr: 1, ...CREDS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmitArtifactError);
    expect((err as Error).message).toContain('invalid --for "not a valid id!"');
    expect((err as Error).message).toContain("1-64 characters");
  });

  it("rejects a non-positive --pr", async () => {
    writeArtifactFile(work);
    await expect(
      runEmitArtifact({ file: "shot.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 0, ...CREDS }),
    ).rejects.toThrow(/invalid --pr/);
  });

  it("rejects a file over 8 MiB with the gateway-cap message", async () => {
    writeArtifactFile(work, "huge.png", Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(
      runEmitArtifact({ file: "huge.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS }),
    ).rejects.toThrow(/artifact exceeds 8 MiB/);
  });

  it("accepts exactly 8 MiB — the cap is exclusive", async () => {
    writeArtifactFile(work, "edge.png", Buffer.alloc(8 * 1024 * 1024));
    const calls: FetchCall[] = [];
    const result = await runEmitArtifact({
      file: "edge.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS, fetchImpl: acceptingFetch(calls),
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("rejects a caption over the length cap instead of truncating it", async () => {
    writeArtifactFile(work);
    await expect(
      runEmitArtifact({ file: "shot.png", cwd: work, home, quiet: true, env: {}, caption: "x".repeat(501), pr: 1, ...CREDS }),
    ).rejects.toThrow(/caption is 501 characters — the cap is 500/);
  });

  it("rejects a filename over the length cap", async () => {
    const name = `${"f".repeat(117)}.png`; // 121 chars
    writeArtifactFile(work, name);
    await expect(
      runEmitArtifact({ file: name, cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS }),
    ).rejects.toThrow(/filename is 121 characters — the cap is 120/);
  });

  it("rejects a missing file", async () => {
    await expect(
      runEmitArtifact({ file: "nope.png", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS }),
    ).rejects.toThrow(/no such file: nope\.png/);
  });

  it("rejects a directory", async () => {
    mkdirSync(join(work, "adir"));
    await expect(
      runEmitArtifact({ file: "adir", cwd: work, home, quiet: true, env: {}, caption: "x", pr: 1, ...CREDS }),
    ).rejects.toThrow(/not a regular file: adir/);
  });
});

// ---------------------------------------------------------------------------
// session detection over the events spool
// ---------------------------------------------------------------------------

describe("detectActiveSession", () => {
  const NOW = Date.parse("2026-08-14T12:00:00.000Z");
  const FRESH = "2026-08-14T11:30:00.000Z";

  function tailOf(lines: unknown[], truncated = false) {
    return () => ({
      data: Buffer.from(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n"),
      truncated,
    });
  }

  function event(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { t: FRESH, event: "PostToolUse", sessionId: "sess-live", transcriptPath: null, cwd: "/work/app", ...over };
  }

  const base = { home: "/nonexistent-home", cwds: ["/work/app"], nowMs: NOW };

  it("returns undefined without CLAUDECODE even when the spool holds a live record", () => {
    expect(detectActiveSession({ ...base, env: {}, readTailImpl: tailOf([event()]) })).toBeUndefined();
  });

  it("finds the session when CLAUDECODE is set and a fresh record matches the cwd", () => {
    expect(detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf([event()]) })).toBe("sess-live");
  });

  it("returns undefined when no record matches any candidate cwd", () => {
    expect(
      detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf([event({ cwd: "/elsewhere" })]) }),
    ).toBeUndefined();
  });

  it("matches the repo root as well as the exact cwd", () => {
    expect(
      detectActiveSession({
        ...base,
        cwds: ["/repo/root", "/repo/root/sub/dir"],
        env: { CLAUDECODE: "1" },
        readTailImpl: tailOf([event({ cwd: "/repo/root" })]),
      }),
    ).toBe("sess-live");
  });

  it("takes the NEWEST matching record when several sessions share the cwd", () => {
    expect(
      detectActiveSession({
        ...base,
        env: { CLAUDECODE: "1" },
        readTailImpl: tailOf([event({ sessionId: "sess-old" }), event({ sessionId: "sess-new" })]),
      }),
    ).toBe("sess-new");
  });

  it("ignores SessionEnd records — an ended session is not a live anchor", () => {
    expect(
      detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf([event({ event: "SessionEnd" })]) }),
    ).toBeUndefined();
  });

  it("ignores records older than 24 hours", () => {
    expect(
      detectActiveSession({
        ...base,
        env: { CLAUDECODE: "1" },
        readTailImpl: tailOf([event({ t: new Date(NOW - SESSION_DETECT_MAX_AGE_MS - 1).toISOString() })]),
      }),
    ).toBeUndefined();
  });

  it("drops the first line of a truncated tail — it may be a fragment", () => {
    expect(
      detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf([event()], true) }),
    ).toBeUndefined();
  });

  it("keeps the first line of an untruncated tail", () => {
    expect(
      detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf([event()], false) }),
    ).toBe("sess-live");
  });

  it("skips malformed lines without losing later ones", () => {
    expect(
      detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf(["{ not json", event()]) }),
    ).toBe("sess-live");
  });

  it("skips records with a null sessionId (a hook payload that failed to parse)", () => {
    expect(
      detectActiveSession({ ...base, env: { CLAUDECODE: "1" }, readTailImpl: tailOf([event({ sessionId: null })]) }),
    ).toBeUndefined();
  });

  it("returns undefined when the spool file does not exist (default reader)", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "ol-detect-"));
    try {
      expect(detectActiveSession({ env: { CLAUDECODE: "1" }, home: emptyHome, cwds: ["/w"], nowMs: NOW })).toBeUndefined();
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("reads the END of a spool larger than the tail window (default reader)", () => {
    const bigHome = mkdtempSync(join(tmpdir(), "ol-detect-big-"));
    try {
      mkdirSync(join(bigHome, ".outerlayer", "spool"), { recursive: true });
      const spool = join(bigHome, ".outerlayer", "spool", "events.jsonl");
      const filler = JSON.stringify(event({ sessionId: "sess-ancient", t: "2026-01-01T00:00:00.000Z" })) + "\n";
      const fillerCount = Math.ceil((SESSION_DETECT_TAIL_BYTES * 1.5) / filler.length);
      writeFileSync(spool, filler.repeat(fillerCount));
      appendFileSync(spool, JSON.stringify(event({ sessionId: "sess-latest", t: new Date(NOW - 1000).toISOString() })) + "\n");
      expect(detectActiveSession({ env: { CLAUDECODE: "1" }, home: bigHome, cwds: ["/work/app"], nowMs: NOW })).toBe(
        "sess-latest",
      );
    } finally {
      rmSync(bigHome, { recursive: true, force: true });
    }
  });
});
