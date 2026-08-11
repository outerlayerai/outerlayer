// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The lifecycle hooks we register. Deliberately NOT
 * Pre/PostToolUse — transcripts already carry tool data, and per-tool hooks
 * add latency risk for zero marginal signal. */
export const REGISTERED_EVENTS = ["SessionStart", "SessionEnd", "Stop"] as const;
export type HookEvent = (typeof REGISTERED_EVENTS)[number];

/** Marker so our entries are recognizable + removable without touching others. */
export const MARKER = "_outerlayer";

/**
 * Where the Claude Code plugin's launcher (`claude-plugin/scripts/hook.mjs`)
 * installs its self-managed CLI copy. Its presence means the plugin is
 * active independently of anything in settings.json — `init` and `doctor`
 * both check it to tell the two install paths apart.
 */
export function managedPluginInstallDir(home: string): string {
  return join(home, ".outerlayer", "cli", "node_modules", "outerlayer");
}

export function pluginActive(home: string): boolean {
  return existsSync(managedPluginInstallDir(home));
}

export type Scope = "user" | "project";

export function settingsPath(scope: Scope, opts: { home?: string; cwd?: string } = {}): string {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  return scope === "user"
    ? join(home, ".claude", "settings.json")
    : join(cwd, ".claude", "settings.json");
}

/** Marker for `hooks wrap` entries: the value is the ORIGINAL command, so
 * `hooks unwrap` is a pure lookup rather than a re-decode of the wrapped
 * argv. Presence marks "we wrapped this"; distinct from `MARKER`, which
 * marks our own lifecycle hooks (those are never wrap candidates). */
const WRAP_MARKER = "_outerlayerWrapped";

export interface HookCommand {
  type: "command";
  command: string;
  [MARKER]?: true;
  [WRAP_MARKER]?: string;
}
export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
export interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/** True when a hook command is one we installed (carries our marker). */
export function isOurHookCommand(h: HookCommand): boolean {
  return h[MARKER] === true;
}

/** True when a hook command has been wrapped by `hooks wrap`. */
export function isWrapped(h: HookCommand): boolean {
  return typeof h[WRAP_MARKER] === "string";
}

/**
 * True when `cliBin` will actually run. A bare command name (no path
 * separator) is trusted as-is — it resolves via PATH at hook-execution
 * time, which nothing short of spawning `which` can verify here — but
 * anything that looks like a path, absolute or relative, must exist on disk
 * right now. A hook command written pointing at a path that doesn't exist
 * fails identically on every subsequent session (`/bin/sh: <path>: No such
 * file or directory`) with nothing in the transcript to explain why — a
 * broken install path has produced exactly this.
 */
export function cliBinResolvable(cliBin: string): boolean {
  if (!cliBin.includes("/") && !cliBin.includes("\\")) return true;
  return existsSync(cliBin);
}

export interface MergeResult {
  changed: boolean;
  backupPath?: string;
  path: string;
}

/** Read + parse settings JSON. Returns null when absent; throws on corruption
 * (init must refuse to write over an unparseable file). */
export function readSettings(path: string): ClaudeSettings | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as ClaudeSettings;
  } catch (err) {
    throw new SettingsParseError(path, err);
  }
}

export class SettingsParseError extends Error {
  constructor(readonly path: string, readonly cause: unknown) {
    super(`refusing to modify ${path}: it is not valid JSON (${cause instanceof Error ? cause.message : cause})`);
    this.name = "SettingsParseError";
  }
}

/** The command a hook entry runs. Absolute path to the installed CLI. */
export function hookCommand(cliBin: string): string {
  // `<bin> hook <EVENT>` — the fast path. Claude Code substitutes the event
  // via the matcher key, so we pass a literal per registered event.
  return cliBin;
}

/** Build our hook block for one event. */
function ourEntry(cliBin: string, event: HookEvent): HookMatcher {
  return {
    hooks: [{ type: "command", command: `${cliBin} hook ${event}`, [MARKER]: true }],
  };
}

/** True when a matcher block is one of ours (safe to replace/remove). */
function isOurs(block: HookMatcher): boolean {
  return block.hooks?.some(isOurHookCommand) ?? false;
}

/**
 * Idempotently merge our hook entries into `settings`, touching ONLY the hook
 * events we own and leaving every other key byte-for-byte. Returns the new
 * settings object + whether anything changed.
 */
export function mergeHooks(
  settings: ClaudeSettings | null,
  cliBin: string,
): { next: ClaudeSettings; changed: boolean } {
  const next: ClaudeSettings = settings ? structuredClone(settings) : {};
  next.hooks = next.hooks ? { ...next.hooks } : {};
  let changed = false;

  for (const event of REGISTERED_EVENTS) {
    const existing = next.hooks[event] ?? [];
    const foreign = existing.filter((b) => !isOurs(b)); // preserve others' hooks
    const desired = [...foreign, ourEntry(cliBin, event)];
    // compare to detect idempotence
    if (JSON.stringify(next.hooks[event] ?? []) !== JSON.stringify(desired)) {
      next.hooks[event] = desired;
      changed = true;
    }
  }
  return { next, changed };
}

/** Remove only our entries; leave foreign hooks and empty-after keys tidy. */
export function removeHooks(settings: ClaudeSettings | null): { next: ClaudeSettings; changed: boolean } {
  const next: ClaudeSettings = settings ? structuredClone(settings) : {};
  if (!next.hooks) return { next, changed: false };
  let changed = false;
  for (const event of Object.keys(next.hooks)) {
    const kept = (next.hooks[event] ?? []).filter((b) => !isOurs(b));
    if (kept.length !== (next.hooks[event] ?? []).length) changed = true;
    if (kept.length === 0) delete next.hooks[event];
    else next.hooks[event] = kept;
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, changed };
}

/** Write settings, backing up the prior file first. Pretty-printed 2-space to
 * match Claude Code's own format. */
export function writeSettings(path: string, settings: ClaudeSettings, now = Date.now): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(path)) {
    backupPath = `${path}.bak-${now()}`;
    copyFileSync(path, backupPath);
  }
  writeSettingsPreservingTrailingNewline(path, settings);
  return backupPath;
}

function writeSettingsPreservingTrailingNewline(path: string, settings: ClaudeSettings): void {
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// hooks wrap / unwrap
//
// `hooks wrap` rewrites a hook's `command` to run it through `hook-wrap`
// instead of directly, so a hang or a kill-on-timeout still leaves spool
// evidence (see hook-wrap-fast.ts). The original command travels base64
// inside the rewritten command (so `hook-wrap` can decode and run it) AND
// verbatim under WRAP_MARKER (so `hooks unwrap` is a lookup, never a
// re-decode of the argv it just rewrote).
// ---------------------------------------------------------------------------

/** The wrapped command embeds the original as one base64 argv token —
 * settings hook commands are `sh -c` strings, and nesting one inside another
 * shell string is a quoting minefield base64 sidesteps entirely. */
export function encodeWrappedCommand(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

export function decodeWrappedCommand(id: string): string {
  return Buffer.from(id, "base64").toString("utf8");
}

/** One hook command found while scanning settings for `hooks wrap`/`hooks
 * status`, located by event + position so a caller can rewrite exactly this
 * entry. `command` is always the ORIGINAL command, whether or not it is
 * currently wrapped. */
export interface HookCandidate {
  event: string;
  matcherIndex: number;
  hookIndex: number;
  matcher?: string;
  command: string;
  wrapped: boolean;
}

/** Lists every hook command across all events except our own lifecycle
 * hooks (installed by `init`) — those are never wrap candidates. */
export function listHookCandidates(settings: ClaudeSettings | null): HookCandidate[] {
  const out: HookCandidate[] = [];
  const hooks = settings?.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    (hooks[event] ?? []).forEach((matcher, matcherIndex) => {
      matcher.hooks.forEach((h, hookIndex) => {
        if (isOurHookCommand(h)) return;
        out.push({
          event,
          matcherIndex,
          hookIndex,
          matcher: matcher.matcher,
          command: isWrapped(h) ? h[WRAP_MARKER]! : h.command,
          wrapped: isWrapped(h),
        });
      });
    });
  }
  return out;
}

/** Builds the wrapped replacement for one hook command. Idempotent: wrapping
 * an already-wrapped command returns it unchanged rather than double-wrapping. */
function wrapHookCommand(cliBin: string, h: HookCommand, opts: { captureOutput?: boolean } = {}): HookCommand {
  if (isWrapped(h)) return h;
  const id = encodeWrappedCommand(h.command);
  const flag = opts.captureOutput ? " --capture-output" : "";
  return { type: "command", command: `${cliBin} hook-wrap --id ${id}${flag}`, [WRAP_MARKER]: h.command };
}

/** Inverse of wrapHookCommand: restores the original command and drops the
 * marker. A no-op on a command that was never wrapped. */
function unwrapHookCommand(h: HookCommand): HookCommand {
  if (!isWrapped(h)) return h;
  return { type: "command", command: h[WRAP_MARKER]! };
}

/** The events `init` auto-wraps with no prompt. `Stop` is deliberately
 * excluded: Claude Code's own transcript already records its per-hook
 * command and duration (see stop_hook_summary in the parser), so wrapping it
 * buys no new evidence for the cost of a spawn on every turn. PreToolUse/
 * PostToolUse are the ones the transcript records nothing about at all. */
export const AUTO_WRAP_EVENTS = ["PreToolUse", "PostToolUse"] as const;

/**
 * Wraps every candidate hook command in `settings`, skipping our own
 * lifecycle hooks and anything already wrapped. `opts.events` restricts
 * which event keys are scanned; `opts.select` lets a caller (e.g. the
 * interactive `hooks wrap` prompt) opt out of individual candidates without
 * touching the rest.
 *
 * Refuses to touch anything when `cliBin` doesn't resolve (see
 * `cliBinResolvable`) — writing a wrapped command that points nowhere is
 * strictly worse than not wrapping at all, since it silently breaks the very
 * hook it was meant to add evidence for.
 */
export function wrapHooks(
  settings: ClaudeSettings | null,
  cliBin: string,
  opts: { events?: string[]; captureOutput?: boolean; select?: (c: HookCandidate) => boolean } = {},
): { next: ClaudeSettings; changed: boolean; wrapped: HookCandidate[]; skippedUnresolvedBin?: boolean } {
  const next: ClaudeSettings = settings ? structuredClone(settings) : {};
  const wrapped: HookCandidate[] = [];
  if (!cliBinResolvable(cliBin)) {
    return { next, changed: false, wrapped, skippedUnresolvedBin: true };
  }
  let changed = false;
  if (!next.hooks) return { next, changed, wrapped };
  for (const event of Object.keys(next.hooks)) {
    if (opts.events && !opts.events.includes(event)) continue;
    const matchers = next.hooks[event] ?? [];
    for (let mi = 0; mi < matchers.length; mi++) {
      const matcher = matchers[mi]!;
      for (let hi = 0; hi < matcher.hooks.length; hi++) {
        const h = matcher.hooks[hi]!;
        if (isOurHookCommand(h) || isWrapped(h)) continue;
        const candidate: HookCandidate = {
          event,
          matcherIndex: mi,
          hookIndex: hi,
          matcher: matcher.matcher,
          command: h.command,
          wrapped: false,
        };
        if (opts.select && !opts.select(candidate)) continue;
        matcher.hooks[hi] = wrapHookCommand(cliBin, h, { captureOutput: opts.captureOutput });
        wrapped.push(candidate);
        changed = true;
      }
    }
  }
  return { next, changed, wrapped };
}

/** Restores every wrapped hook command to its original, dropping the marker. */
export function unwrapHooks(settings: ClaudeSettings | null): { next: ClaudeSettings; changed: boolean; unwrapped: number } {
  const next: ClaudeSettings = settings ? structuredClone(settings) : {};
  let changed = false;
  let unwrapped = 0;
  if (!next.hooks) return { next, changed, unwrapped };
  for (const event of Object.keys(next.hooks)) {
    const matchers = next.hooks[event] ?? [];
    for (const matcher of matchers) {
      for (let hi = 0; hi < matcher.hooks.length; hi++) {
        const h = matcher.hooks[hi]!;
        if (!isWrapped(h)) continue;
        matcher.hooks[hi] = unwrapHookCommand(h);
        unwrapped++;
        changed = true;
      }
    }
  }
  return { next, changed, unwrapped };
}
