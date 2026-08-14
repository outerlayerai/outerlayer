// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer emit <name>`: record the pass/fail outcome of a check that
 * just ran in this environment — CI first, by design. The name references a
 * validator declaration, the link is the row's proof (the CI run URL a
 * reviewer follows), and the anchor is a PR number: from `--pr` or from the
 * GitHub Actions environment. No PR or no repository is a refusal, not a
 * guess — a result nobody can trace to a change is worse than an error now.
 *
 * `provenance` never rides the wire: the server derives it from how the
 * result arrived, so a caller cannot claim a stronger origin than it has.
 * Unlike `emit artifact` there is no session detection and no spool — an
 * emitted result uploads immediately or not at all.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  EMITTED_RESULT_MAX_LINK_LENGTH,
  EMITTED_RESULTS,
  EmittedNameSchema,
  type EmitResultRequest,
  type EmittedResultOutcome,
} from "@outerlayer/session-schema";
import { resolveRepoIdentity } from "@outerlayer/capture";
import { prNumberFromCiEnv } from "./emit-artifact-cmd.js";
import { cloudConfigPath, detectCi, readCloudConfig } from "./sync-cmd.js";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export class EmitResultError extends Error {}

export interface EmitResultCommandOptions {
  /** Emit name as the validator declares it (e.g. `smoke.pass`). */
  name: string;
  /** Proof link — the CI run URL. Required. */
  link?: string;
  /** Outcome: `pass` (default) or `fail`. */
  result?: string;
  /** PR number to anchor to (`--pr`); falls back to the CI environment. */
  pr?: string | number;
  /** Machine-readable output. */
  json?: boolean;
  /** Cloud base URL (flag > OUTERLAYER_URL > config file). */
  url?: string;
  /** API key (flag > OUTERLAYER_API_KEY > config file). */
  apiKey?: string;
  /** App id the key is bound to (flag > OUTERLAYER_APP_ID > config file). */
  appId?: string;
  /** Suppress stdout writes (tests). */
  quiet?: boolean;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable transport (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface EmitResultCommandResult {
  /** The response body's `data` object. */
  data: Record<string, unknown>;
  output: string;
  exitCode: 0 | 1;
}

export async function runEmitResult(opts: EmitResultCommandOptions): Promise<EmitResultCommandResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  // -------------------------------------------------------------------
  // validation — every flag checked before any I/O (no git, no config
  // file, no network), so a typo fails in milliseconds.
  // -------------------------------------------------------------------
  if (!EmittedNameSchema.safeParse(opts.name).success) {
    throw new EmitResultError(
      `invalid name "${opts.name}" — an emit name is 1-64 characters: a lowercase letter followed by ` +
        `lowercase letters, digits, ".", "_" or "-" (e.g. smoke.pass)`,
    );
  }
  const link = opts.link;
  if (link === undefined || link === "") {
    throw new EmitResultError(
      `--link is required — the row's proof link is the CI run, e.g. --link "https://github.com/acme/app/actions/runs/123"`,
    );
  }
  if (!link.startsWith("http://") && !link.startsWith("https://")) {
    throw new EmitResultError(`invalid --link "${link}" — expected an http:// or https:// URL`);
  }
  // The gateway refuses whitespace too (the link renders inside a markdown
  // `(url)` wrapper); failing here saves the round-trip and names the fix.
  if (/\s/.test(link)) {
    throw new EmitResultError(`invalid --link — URLs cannot contain whitespace; percent-encode it`);
  }
  if (link.length > EMITTED_RESULT_MAX_LINK_LENGTH) {
    throw new EmitResultError(
      `link is ${link.length} characters — the cap is ${EMITTED_RESULT_MAX_LINK_LENGTH}`,
    );
  }
  let result: EmittedResultOutcome = "pass";
  if (opts.result !== undefined) {
    if (!(EMITTED_RESULTS as readonly string[]).includes(opts.result)) {
      throw new EmitResultError(`invalid --result "${opts.result}" — expected "pass" or "fail"`);
    }
    result = opts.result as EmittedResultOutcome;
  }
  let prFlag: number | undefined;
  if (opts.pr !== undefined) {
    const n = typeof opts.pr === "number" ? opts.pr : Number(opts.pr);
    if (!Number.isInteger(n) || n <= 0) {
      throw new EmitResultError(`invalid --pr "${opts.pr}" — expected a positive integer`);
    }
    prFlag = n;
  }

  // -------------------------------------------------------------------
  // anchor — an emitted result must name its PR and repository at emit
  // time (the gateway refuses anything less; there is no reconciler).
  // -------------------------------------------------------------------
  const prNumber = prFlag ?? prNumberFromCiEnv(env);
  if (prNumber === undefined) {
    throw new EmitResultError(
      "nothing to attach this to — no PR number. Pass --pr <number> or run on a pull_request CI event.",
    );
  }
  const repository = env.GITHUB_REPOSITORY;
  const gitRepo = repository === undefined ? resolveRepoIdentity(cwd).gitRepo : undefined;
  if (repository === undefined && gitRepo === undefined) {
    throw new EmitResultError(
      "nothing to attach this to — no repository. Run in CI (GITHUB_REPOSITORY) or from a git checkout with a remote.",
    );
  }

  const fileConfig = readCloudConfig(home);
  const url = opts.url ?? env.OUTERLAYER_URL ?? fileConfig.url;
  const apiKey = opts.apiKey ?? env.OUTERLAYER_API_KEY ?? fileConfig.apiKey;
  const appId = opts.appId ?? env.OUTERLAYER_APP_ID ?? fileConfig.appId;
  if (!url || !apiKey || !appId) {
    const missing = [!url && "--url", !apiKey && "--api-key", !appId && "--app-id"].filter(Boolean).join(", ");
    throw new EmitResultError(
      `missing ${missing}. Pass flags, set OUTERLAYER_URL / OUTERLAYER_API_KEY / OUTERLAYER_APP_ID, ` +
        `or save them to ${cloudConfigPath(home)}. Mint a key in the dashboard: Settings → API keys.`,
    );
  }

  const ci = detectCi(env);
  const request: EmitResultRequest = {
    schemaVersion: 1,
    emit: {
      clientEmitId: randomUUID(),
      name: opts.name,
      result,
      link,
      emittedAt: now().toISOString(),
      ...(ci ? { ci: true } : {}),
      prNumber,
      ...(repository !== undefined ? { repository } : {}),
      ...(gitRepo !== undefined ? { gitRepo } : {}),
    },
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = new URL("/v1/emitted-results", url).toString();
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
    throw new EmitResultError(`network error reaching ${endpoint}: ${String(err)}`);
  }
  if (response.status === 401) {
    throw new EmitResultError(
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
    throw new EmitResultError(`emit failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  let data: Record<string, unknown> = {};
  try {
    data = ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
  } catch {
    // a 2xx with an unparseable body still means the result was accepted
  }
  const output = opts.json
    ? JSON.stringify(data)
    : `${GREEN}✓${RESET} emitted ${opts.name} (${result}) ${DIM}·${RESET} PR #${prNumber}`;
  if (!opts.quiet) process.stdout.write(output + "\n");
  return { data, output, exitCode: 0 };
}
