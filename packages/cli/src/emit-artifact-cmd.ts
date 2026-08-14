// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer emit artifact <file>`: capture a proof artifact — a
 * screenshot, recording, report, or log — and anchor it where a reviewer
 * will look for it. Inside a recorded Claude Code session the bytes are
 * SPOOLED locally and shipped by the next `outerlayer sync`, bound to the
 * session (and turn) that produced them; outside a session the artifact
 * uploads immediately, anchored to a PR (flag or CI env) or to the current
 * git checkout. No anchor at all is a refusal, not a guess — an artifact
 * nobody can find later is worse than an error now.
 *
 * `kind` and `provenance` never ride the wire: the server derives both
 * (see session-schema's artifact contract), so a caller cannot claim a
 * stronger kind or origin than it has.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  ARTIFACT_MAX_CAPTION_LENGTH,
  ARTIFACT_MAX_FILENAME_LENGTH,
  ArtifactCriterionIdSchema,
  inferArtifactKind,
  mediaTypeForArtifactPath,
  type ArtifactSpoolRecord,
  type EmitArtifactRequest,
} from "@outerlayer/session-schema";
import { resolveRepoIdentity } from "@outerlayer/capture";
import { appendArtifactRecord, artifactBlobsDir } from "./artifact-spool.js";
import { detectActiveSession } from "./session-detect.js";
import { cloudConfigPath, detectCi, readCloudConfig } from "./sync-cmd.js";

/** The gateway's request ceiling — a larger artifact 413s there, so refuse
 * locally with a message that names the actual limit. */
const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export class EmitArtifactError extends Error {}

export interface EmitArtifactCommandOptions {
  /** Artifact file path, resolved against `cwd`. */
  file: string;
  /** What the artifact shows/proves — required. */
  caption?: string;
  /** Acceptance-criterion id (`--for`). */
  criterionId?: string;
  /** PR number to anchor to (`--pr`). */
  pr?: number;
  /** Cloud base URL (flag > OUTERLAYER_URL > config file). */
  url?: string;
  /** API key (flag > OUTERLAYER_API_KEY > config file). */
  apiKey?: string;
  /** App id the key is bound to (flag > OUTERLAYER_APP_ID > config file). */
  appId?: string;
  /** Machine-readable output. */
  json?: boolean;
  /** Suppress stdout writes (tests). */
  quiet?: boolean;
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Injectable transport (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface EmitArtifactCommandResult {
  /** True when the bytes were spooled for the next sync instead of uploaded. */
  spooled: boolean;
  /** The spool record written (spool path only). */
  record?: ArtifactSpoolRecord;
  /** The response body's `data` object (direct-upload path only). */
  data?: Record<string, unknown>;
  output: string;
  exitCode: 0 | 1;
}

/** PR number from the GitHub Actions environment: `GITHUB_REF`
 * (`refs/pull/<n>/…`) covers pull_request events; the event payload file
 * covers other events that still carry a PR. Both probes tolerate absence —
 * non-GitHub CI simply resolves nothing. */
function prNumberFromCiEnv(env: Record<string, string | undefined>): number | undefined {
  const refMatch = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
  if (refMatch) {
    const n = parseInt(refMatch[1]!, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
        pull_request?: { number?: unknown };
      };
      const n = event.pull_request?.number;
      if (typeof n === "number" && Number.isInteger(n) && n > 0) return n;
    } catch {
      // absent or unreadable event payload — no PR context from this probe
    }
  }
  return undefined;
}

export async function runEmitArtifact(opts: EmitArtifactCommandOptions): Promise<EmitArtifactCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  const caption = opts.caption;
  if (caption === undefined || caption === "") {
    throw new EmitArtifactError(
      `missing --caption — say what this artifact proves, e.g. --caption "checkout flow passes"`,
    );
  }
  if (caption.length > ARTIFACT_MAX_CAPTION_LENGTH) {
    throw new EmitArtifactError(
      `caption is ${caption.length} characters — the cap is ${ARTIFACT_MAX_CAPTION_LENGTH}`,
    );
  }
  if (opts.criterionId !== undefined && !ArtifactCriterionIdSchema.safeParse(opts.criterionId).success) {
    throw new EmitArtifactError(
      `invalid --for "${opts.criterionId}" — a criterion id is 1-64 characters of letters, digits, "_", ".", ":" or "-" (e.g. AC-084-04)`,
    );
  }
  const criterionId = opts.criterionId;
  let prNumber: number | undefined;
  if (opts.pr !== undefined) {
    if (!Number.isInteger(opts.pr) || opts.pr <= 0) {
      throw new EmitArtifactError(`invalid --pr "${opts.pr}" — expected a positive integer`);
    }
    prNumber = opts.pr;
  }

  const filePath = resolve(cwd, opts.file);
  let stat: Stats;
  try {
    stat = statSync(filePath);
  } catch {
    throw new EmitArtifactError(`no such file: ${opts.file}`);
  }
  if (!stat.isFile()) throw new EmitArtifactError(`not a regular file: ${opts.file}`);
  const bytes = readFileSync(filePath);
  if (bytes.length > ARTIFACT_MAX_BYTES) {
    throw new EmitArtifactError(
      `artifact exceeds 8 MiB (${(bytes.length / (1024 * 1024)).toFixed(1)} MB) — the gateway refuses larger uploads`,
    );
  }
  const filename = basename(filePath);
  if (filename.length > ARTIFACT_MAX_FILENAME_LENGTH) {
    throw new EmitArtifactError(
      `filename is ${filename.length} characters — the cap is ${ARTIFACT_MAX_FILENAME_LENGTH}`,
    );
  }
  const mediaType = mediaTypeForArtifactPath(filePath);
  const kind = inferArtifactKind(mediaType);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = resolveRepoIdentity(cwd);

  const sessionId = detectActiveSession({
    env,
    home,
    cwds: identity.repoRoot !== undefined ? [identity.repoRoot, cwd] : [cwd],
    nowMs: now().getTime(),
  });

  // ---------------------------------------------------------------------
  // spool path — a live recorded session owns this artifact; the next
  // `outerlayer sync` uploads it bound to that session. Nothing is written
  // outside the spool and nothing goes over the wire here.
  // ---------------------------------------------------------------------
  if (sessionId !== undefined) {
    mkdirSync(artifactBlobsDir(home), { recursive: true });
    // Content-addressed by sha: a double emit of the same bytes rewrites the
    // same blob file and simply adds a second (deduped-by-sha) record.
    writeFileSync(join(artifactBlobsDir(home), sha256), bytes);
    const record: ArtifactSpoolRecord = {
      rec: "artifact",
      artifactId: randomUUID(),
      t: now().toISOString(),
      sessionId,
      cwd,
      ...(identity.gitRepo !== undefined ? { gitRepo: identity.gitRepo } : {}),
      ...(identity.gitBranch !== undefined ? { gitBranch: identity.gitBranch } : {}),
      ...(identity.commitSha !== undefined ? { commitSha: identity.commitSha } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      filename,
      mediaType,
      bytes: bytes.length,
      sha256,
      caption,
      ...(criterionId !== undefined ? { criterionId } : {}),
    };
    appendArtifactRecord(record, home);
    const output = opts.json
      ? JSON.stringify({ spooled: true, record })
      : `${GREEN}✓${RESET} artifact spooled ${DIM}·${RESET} ${kind} ${filename} ${DIM}·${RESET} session ${sessionId.slice(0, 8)} ${DIM}·${RESET} uploads on the next ${YELLOW}outerlayer sync${RESET}`;
    if (!opts.quiet) process.stdout.write(output + "\n");
    return { spooled: true, record, output, exitCode: 0 };
  }

  // ---------------------------------------------------------------------
  // direct upload — anchor check FIRST: with no session, no PR (flag or CI
  // context), and no git repo, an accepted artifact would be unreachable
  // from every surface that renders artifacts. Refuse before touching the
  // network or the spool.
  // ---------------------------------------------------------------------
  const ci = detectCi(env);
  const repository = env.GITHUB_REPOSITORY;
  prNumber ??= prNumberFromCiEnv(env);
  if (prNumber === undefined && identity.gitRepo === undefined) {
    throw new EmitArtifactError(
      "nothing to attach this to — no recorded session, no PR, and no git repo. " +
        "Run inside a recorded Claude Code session, from a git checkout, in CI with PR context, or pass --pr <number>.",
    );
  }

  const fileConfig = readCloudConfig(home);
  const url = opts.url ?? env.OUTERLAYER_URL ?? fileConfig.url;
  const apiKey = opts.apiKey ?? env.OUTERLAYER_API_KEY ?? fileConfig.apiKey;
  const appId = opts.appId ?? env.OUTERLAYER_APP_ID ?? fileConfig.appId;
  if (!url || !apiKey || !appId) {
    const missing = [!url && "--url", !apiKey && "--api-key", !appId && "--app-id"].filter(Boolean).join(", ");
    throw new EmitArtifactError(
      `missing ${missing}. Pass flags, set OUTERLAYER_URL / OUTERLAYER_API_KEY / OUTERLAYER_APP_ID, ` +
        `or save them to ${cloudConfigPath(home)}. Mint a key in the dashboard: Settings → API keys.`,
    );
  }

  const request: EmitArtifactRequest = {
    schemaVersion: 1,
    artifact: {
      clientArtifactId: randomUUID(),
      filename,
      mediaType,
      bytes: bytes.length,
      sha256,
      caption,
      ...(criterionId !== undefined ? { criterionId } : {}),
      emittedAt: now().toISOString(),
      ci,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(identity.gitRepo !== undefined ? { gitRepo: identity.gitRepo } : {}),
      ...(identity.gitBranch !== undefined ? { gitBranch: identity.gitBranch } : {}),
      ...(identity.commitSha !== undefined ? { commitSha: identity.commitSha } : {}),
    },
    blob: { data: bytes.toString("base64") },
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = new URL("/v1/artifacts", url).toString();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-outerlayer-app-id": appId,
      },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new EmitArtifactError(`network error reaching ${endpoint}: ${String(err)}`);
  }
  if (response.status === 401) {
    throw new EmitArtifactError(
      "not authorized — the API key is unknown, expired, or bound to a different app. Mint a fresh key: dashboard → Settings → API keys.",
    );
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 160);
    } catch {
      // unreadable error body — the status alone still tells the story
    }
    throw new EmitArtifactError(`artifact upload failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  let data: Record<string, unknown> = {};
  try {
    data = ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
  } catch {
    // a 2xx with an unparseable body still means the artifact was accepted
  }
  const provenance = typeof data.provenance === "string" ? data.provenance : "unknown";
  const output = opts.json
    ? JSON.stringify(data)
    : `${GREEN}✓${RESET} artifact accepted ${DIM}·${RESET} ${kind} ${filename} ${DIM}·${RESET} provenance ${provenance}` +
      (prNumber !== undefined ? ` ${DIM}·${RESET} pr #${prNumber}` : "");
  if (!opts.quiet) process.stdout.write(output + "\n");
  return { spooled: false, data, output, exitCode: 0 };
}
