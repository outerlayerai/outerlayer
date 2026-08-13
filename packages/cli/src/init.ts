// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mergeHooks,
  readSettings,
  removeHooks,
  settingsPath,
  writeSettings,
  wrapHooks,
  cliBinResolvable,
  pluginActive,
  mergeStatusline,
  removeStatusline,
  REGISTERED_EVENTS,
  AUTO_WRAP_EVENTS,
  type HookCandidate,
  type Scope,
  type StatuslineMergeOutcome,
} from "./settings.js";

export interface InitOptions {
  scope?: Scope;
  remove?: boolean;
  /** Absolute path to the installed `outerlayer` binary. */
  cliBin: string;
  home?: string;
  cwd?: string;
  /** For project scope: offer to gitignore .outerlayer/. */
  addGitignore?: boolean;
  /** Auto-wrap eligible PreToolUse/PostToolUse hooks with no prompt. Default
   * true; `init --no-wrap-hooks` disables it entirely. */
  wrapHooks?: boolean;
  /** Install the status-line segment (wrapping an occupied slot, never
   * replacing it). Default true; `init --no-statusline` skips the slot. */
  statusline?: boolean;
}

export interface InitResult {
  path: string;
  changed: boolean;
  backupPath?: string;
  events: readonly string[];
  gitignoreUpdated?: boolean;
  removed?: boolean;
  /** Hooks auto-wrapped this run. Empty on `--no-wrap-hooks`, when nothing
   * eligible was configured, or when `cliBinUnresolved` is set. */
  wrapped: HookCandidate[];
  /** Set instead of writing anything: `cliBin` doesn't resolve on disk, so
   * every hook command this call would install (lifecycle AND wrapped)
   * would point nowhere — the exact failure a broken install path produces,
   * silently, on every subsequent session. Settings are left untouched. */
  cliBinUnresolved?: boolean;
  /** Set when the Claude Code plugin's managed CLI install is already
   * present: capture is live through the plugin, so the settings hooks this
   * call installs are redundant (both fire; `hook-fast`'s dedupe means no
   * duplicate capture, but there is nothing to gain from keeping both). */
  pluginAlreadyActive?: boolean;
  /** What happened to the statusLine slot. Absent on `--no-statusline`,
   * remove runs, and `cliBinUnresolved`. */
  statusline?: StatuslineMergeOutcome;
  /** The pre-existing statusLine command now wrapped (or restored, on
   * remove) — named in output so the user sees it was preserved. */
  statuslineWrappedCommand?: string;
}

/**
 * `outerlayer init`: idempotently install the lifecycle hooks into
 * the chosen settings scope, then auto-wrap eligible PreToolUse/PostToolUse
 * hooks (see AUTO_WRAP_EVENTS) unless `wrapHooks: false`. Backs up first;
 * never rewrites unrelated keys; refuses (throws) on a corrupt settings file.
 */
export function runInit(opts: InitOptions): InitResult {
  const scope: Scope = opts.scope ?? "user";
  const path = settingsPath(scope, { home: opts.home, cwd: opts.cwd });

  const current = readSettings(path); // throws SettingsParseError on corruption

  if (opts.remove) {
    const hooksRemoved = removeHooks(current);
    const statuslineRemoved = removeStatusline(hooksRemoved.next);
    const changed = hooksRemoved.changed || statuslineRemoved.changed;
    const backupPath = changed ? writeSettings(path, statuslineRemoved.next) : undefined;
    return {
      path,
      changed,
      backupPath,
      events: REGISTERED_EVENTS,
      removed: true,
      wrapped: [],
      ...(statuslineRemoved.restoredCommand ? { statuslineWrappedCommand: statuslineRemoved.restoredCommand } : {}),
    };
  }

  // A cliBin that doesn't resolve breaks every hook command this call would
  // install, not just wrapped ones — refuse to write anything rather than
  // ship a settings file where every hook fails identically and silently.
  if (!cliBinResolvable(opts.cliBin)) {
    return { path, changed: false, events: REGISTERED_EVENTS, wrapped: [], cliBinUnresolved: true };
  }

  const merged = mergeHooks(current, opts.cliBin);
  let next = merged.next;
  let changed = merged.changed;
  let wrapped: HookCandidate[] = [];

  if (opts.wrapHooks ?? true) {
    const wrapResult = wrapHooks(next, opts.cliBin, { events: [...AUTO_WRAP_EVENTS] });
    if (wrapResult.changed) {
      next = wrapResult.next;
      changed = true;
      wrapped = wrapResult.wrapped;
    }
  }

  let statusline: StatuslineMergeOutcome | undefined;
  let statuslineWrappedCommand: string | undefined;
  if (opts.statusline ?? true) {
    const slotResult = mergeStatusline(next, opts.cliBin);
    statusline = slotResult.outcome;
    statuslineWrappedCommand = slotResult.wrappedCommand;
    if (slotResult.changed) {
      next = slotResult.next;
      changed = true;
    }
  }

  const backupPath = changed ? writeSettings(path, next) : undefined;

  let gitignoreUpdated = false;
  if (scope === "project" && opts.addGitignore) {
    gitignoreUpdated = ensureGitignore(opts.cwd ?? process.cwd());
  }

  const pluginAlreadyActive = pluginActive(opts.home ?? homedir());

  return {
    path,
    changed,
    backupPath,
    events: REGISTERED_EVENTS,
    gitignoreUpdated,
    wrapped,
    pluginAlreadyActive,
    ...(statusline ? { statusline } : {}),
    ...(statuslineWrappedCommand ? { statuslineWrappedCommand } : {}),
  };
}

/** Add `.outerlayer/` to the repo's .gitignore if not already ignored. */
export function ensureGitignore(cwd: string): boolean {
  const gitignore = join(cwd, ".gitignore");
  const entry = ".outerlayer/";
  let contents = "";
  if (existsSync(gitignore)) {
    contents = readFileSync(gitignore, "utf8");
    if (contents.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === ".outerlayer")) {
      return false;
    }
  }
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignore, `${contents}${prefix}${entry}\n`);
  return true;
}

/** The org-rollout snippet (`init --org`): a managed-settings.json
 * fragment + MDM/GPO guidance printed to stdout (never written to system
 * paths). */
export function orgRolloutSnippet(cliBin: string): string {
  const hooks: Record<string, unknown> = {};
  for (const event of REGISTERED_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command: `${cliBin} hook ${event}` }] }];
  }
  const managed = JSON.stringify({ hooks }, null, 2);
  return [
    "# Org-wide rollout (managed settings)",
    "",
    "Deploy this managed-settings.json to every developer machine via MDM/GPO.",
    "It cannot be overridden by users, guaranteeing fleet-wide capture.",
    "",
    "  macOS (MDM):    /Library/Application Support/ClaudeCode/managed-settings.json",
    "                  (domain com.anthropic.claudecode)",
    "  Linux:          /etc/claude-code/managed-settings.json",
    "  Windows (GPO):  HKLM\\SOFTWARE\\Policies\\ClaudeCode",
    "",
    "managed-settings.json:",
    managed,
    "",
    "Each developer still runs `outerlayer login` once to connect their machine.",
  ].join("\n");
}
