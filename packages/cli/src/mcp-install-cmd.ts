// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * `outerlayer mcp install`: writes (or updates) an `mcpServers` entry in the
 * repo's `.mcp.json` pointing an MCP client at the OuterLayer gateway's
 * `POST /v1/mcp` endpoint — the same file format `outerlayer emit` writes
 * for the `mcp` content kind (Claude Code's native `.mcp.json`, `${VAR}`
 * interpolation included), so a repo already using `.outerlayer/mcp/`
 * entries and one wired by this command look identical on disk.
 *
 * The API key is NEVER accepted as a flag and NEVER written into the file
 * as a literal value — only the `${OUTERLAYER_API_KEY}` placeholder, which
 * Claude Code (and compatible clients) resolve from the environment at
 * connect time. A flag would land in shell history and process listings;
 * writing the resolved value would put a live credential into a file this
 * command has no way of knowing is gitignored.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export class McpInstallError extends Error {}

/** Hosted OuterLayer Cloud gateway. Self-host deployments pass `--url`
 * pointing at their own `gateway-node` origin (see apps/gateway-node/README.md). */
export const DEFAULT_MCP_URL = "https://api.agentmark.co/v1/mcp";

const API_KEY_ENV_PLACEHOLDER = "${OUTERLAYER_API_KEY}";

export interface McpInstallCommandOptions {
  /** Repo root to write into (default: `process.cwd()`). */
  cwd?: string;
  /** Gateway MCP endpoint (default: the hosted OuterLayer Cloud gateway). */
  url?: string;
  /** `mcpServers` key to write under (default: `"outerlayer"`). */
  name?: string;
  /** Self-host app id — emitted as `X-Outerlayer-App-Id`. Self-host's
   * `SelfHostAuthResolver` has no key service to resolve a caller from the
   * bearer token alone, so it fails closed without this header; hosted
   * deployments don't need it (omit for hosted). */
  appId?: string;
  quiet?: boolean;
  json?: boolean;
}

export interface McpInstallCommandResult {
  /** Repo-relative path written (`.mcp.json`). */
  path: string;
  server: string;
  url: string;
  /** False when the exact same entry was already present (idempotent no-op). */
  changed: boolean;
  output: string;
  exitCode: 0 | 1;
}

/** Exported so a test can assert `X-Outerlayer-App-Id` is genuinely ABSENT
 * as an object key when `appId` is omitted, not merely `undefined` — after
 * a `JSON.stringify`/`JSON.parse` round trip (what `runMcpInstall` writes
 * and every other test reads back) an explicit `undefined` value and a
 * missing key are indistinguishable, since `JSON.stringify` drops
 * `undefined`-valued keys either way. */
export function buildServerEntry(url: string, appId: string | undefined): Record<string, unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY_ENV_PLACEHOLDER}` };
  if (appId) headers["X-Outerlayer-App-Id"] = appId;
  return { type: "http", url, headers };
}

export function runMcpInstall(opts: McpInstallCommandOptions = {}): McpInstallCommandResult {
  const cwd = opts.cwd ?? process.cwd();
  if (!existsSync(cwd)) throw new McpInstallError(`no such directory: ${cwd}`);

  const name = opts.name ?? "outerlayer";
  const url = opts.url ?? DEFAULT_MCP_URL;
  const relPath = ".mcp.json";
  const absPath = join(cwd, relPath);

  let doc: Record<string, unknown> = {};
  if (existsSync(absPath)) {
    try {
      doc = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new McpInstallError(`${relPath} exists and is not valid JSON — fix or remove it before running "mcp install"`);
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new McpInstallError(`${relPath} exists and its top level is not a JSON object — refusing to overwrite`);
    }
  }

  const existingServers =
    doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
      ? (doc.mcpServers as Record<string, unknown>)
      : {};

  const entry = buildServerEntry(url, opts.appId);
  const changed = JSON.stringify(existingServers[name] ?? null) !== JSON.stringify(entry);

  const next = { ...doc, mcpServers: { ...existingServers, [name]: entry } };
  writeFileSync(absPath, `${JSON.stringify(next, null, 2)}\n`);

  const output = opts.json
    ? JSON.stringify({ path: relPath, server: name, url, changed })
    : changed
      ? `${GREEN}✓${RESET} Wrote "${name}" MCP server (${url}) to ${relPath}\n` +
        `${DIM}  Set OUTERLAYER_API_KEY in your environment — the key is referenced as ${API_KEY_ENV_PLACEHOLDER}, never written to this file.${RESET}`
      : `${DIM}"${name}" MCP server already configured in ${relPath} (no change)${RESET}`;

  if (!opts.quiet) process.stdout.write(output + "\n");

  return { path: relPath, server: name, url, changed, output, exitCode: 0 };
}
