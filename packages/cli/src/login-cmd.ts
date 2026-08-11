// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer login` — the device-code handshake against a dashboard's
 * `/api/cli/device/{start,poll}` routes. Start → print the code and open
 * the verification URL → poll until the human approves it in the dashboard
 * → persist the minted key → run one foreground sync so the connection is
 * proven working before the command exits.
 *
 * There is deliberately no hosted-URL default constant in this repo (see
 * the plan this shipped from), so `--url`/`OUTERLAYER_DASHBOARD_URL` is
 * required-ish: the command refuses to guess.
 */

import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { writeCloudConfig, isLoopbackUrl, runSync, type SyncCommandResult } from "./sync-cmd.js";

export class LoginConfigError extends Error {}
export class LoginTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LoginTransportError";
  }
}
export class LoginDeniedError extends Error {}
export class LoginTimeoutError extends Error {}

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

type DevicePollResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; key: string; app_id: string; base_url: string; org_name: string | null; app_name: string | null };

export interface LoginCommandOptions {
  url?: string;
  home?: string;
  quiet?: boolean;
  /** Injectable transport (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (tests). Default: setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable "open a browser" seam (tests; also lets a headless/CI
   * environment no-op this without erroring). Default: platform opener. */
  openImpl?: (url: string) => void;
  /** Injectable foreground sync (tests). Default: the real runSync. */
  syncImpl?: typeof runSync;
  env?: Record<string, string | undefined>;
}

export interface LoginCommandResult {
  url: string;
  apiKey: string;
  appId: string;
  orgName: string | null;
  appName: string | null;
  configWritten: boolean;
  sync: SyncCommandResult | null;
  output: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort browser launch: detached, stdio ignored, every failure
 * swallowed by the caller — a headless machine (CI, SSH session) must still
 * be able to complete login by copying the printed URL manually. */
function defaultOpen(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body: parsed };
}

export async function runLogin(opts: LoginCommandOptions = {}): Promise<LoginCommandResult> {
  const env = opts.env ?? process.env;
  const dashboardUrl = opts.url || env.OUTERLAYER_DASHBOARD_URL;
  if (!dashboardUrl) {
    throw new LoginConfigError("Dashboard URL required: pass --url <url> or set OUTERLAYER_DASHBOARD_URL");
  }
  const base = trimTrailingSlash(dashboardUrl);
  const home = opts.home ?? homedir();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const openImpl = opts.openImpl ?? defaultOpen;
  const syncImpl = opts.syncImpl ?? runSync;

  let output = "";

  const start = await postJson<DeviceStartResponse>(fetchImpl, `${base}/api/cli/device/start`, {});
  if (start.status !== 200) {
    throw new LoginTransportError(`Failed to start device login (${start.status})`, start.status);
  }

  output += `First, copy your one-time code: ${start.body.user_code}\n`;
  output += `Then visit: ${start.body.verification_url}\n`;
  output += `Waiting for approval…\n`;
  try {
    openImpl(start.body.verification_url);
  } catch {
    // Best-effort — the printed URL above is the fallback.
  }

  const intervalMs = Math.max(1000, start.body.interval * 1000);
  const deadline = Date.now() + start.body.expires_in * 1000;
  let approved: Extract<DevicePollResponse, { status: "approved" }> | null = null;

  while (!approved) {
    if (Date.now() >= deadline) {
      throw new LoginTimeoutError("Device login timed out waiting for approval — run `outerlayer login` again");
    }
    await sleepImpl(intervalMs);

    const poll = await postJson<DevicePollResponse | { error: string; message?: string }>(
      fetchImpl,
      `${base}/api/cli/device/poll`,
      { device_code: start.body.device_code },
    );
    if (poll.status === 402) {
      const body = poll.body as { message?: string };
      throw new LoginTransportError(body.message ?? "API key limit reached", 402);
    }
    if (poll.status !== 200) {
      throw new LoginTransportError(`Poll failed (${poll.status})`, poll.status);
    }
    const body = poll.body as DevicePollResponse;
    if (body.status === "denied") throw new LoginDeniedError("Device login was denied in the dashboard");
    if (body.status === "expired") throw new LoginTimeoutError("Device login code expired — run `outerlayer login` again");
    if (body.status === "approved") approved = body;
    // status === "pending" — loop and poll again after the interval.
  }

  // Skip persisting over a loopback URL — mirrors runSync's own guard so a
  // one-off `login --url http://localhost:...` (local dev/testing) can
  // never silently clobber a real, already-configured cloud connection.
  const configWritten = !isLoopbackUrl(approved.base_url);
  if (configWritten) {
    writeCloudConfig({ url: approved.base_url, apiKey: approved.key, appId: approved.app_id }, home);
    output += `Connected${approved.org_name ? ` to ${approved.org_name}` : ""}${approved.app_name ? ` / ${approved.app_name}` : ""}.\n`;
  } else {
    output += `Connected (not saved as default config — ${approved.base_url} is a loopback URL).\n`;
  }

  let sync: SyncCommandResult | null = null;
  try {
    sync = await syncImpl({
      url: approved.base_url,
      apiKey: approved.key,
      appId: approved.app_id,
      home,
      quiet: true,
      fetchImpl,
      sleepImpl,
    });
    output += `Synced ${sync.synced} session(s).\n`;
  } catch {
    // Login itself succeeded regardless of whether the very first sync did —
    // the hook fast path (or a later `outerlayer sync`) catches up.
    output += `Login succeeded; the first sync will run automatically from your next session.\n`;
  }

  return {
    url: approved.base_url,
    apiKey: approved.key,
    appId: approved.app_id,
    orgName: approved.org_name,
    appName: approved.app_name,
    configWritten,
    sync,
    output,
  };
}
