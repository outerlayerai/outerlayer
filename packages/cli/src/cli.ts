// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { runInit, orgRolloutSnippet, type InitResult } from "./init.js";
import {
  SettingsParseError,
  readSettings,
  writeSettings,
  settingsPath,
  listHookCandidates,
  wrapHooks,
  unwrapHooks,
  type ClaudeSettings,
  type HookCandidate,
  type Scope,
} from "./settings.js";
import { runDoctor, doctorExitCode, type Check } from "./doctor.js";

/** Absolute path to this installed CLI's bin, for hook commands. */
function resolveCliBin(): string {
  // dist/index.js is the bin; this module is bundled alongside it.
  try {
    return fileURLToPath(new URL("./index.js", import.meta.url));
  } catch {
    return "outerlayer";
  }
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function icon(status: Check["status"]): string {
  if (status === "pass") return `${GREEN}✓${RESET}`;
  if (status === "warn") return `${YELLOW}!${RESET}`;
  return `${RED}✗${RESET}`;
}

/**
 * Renders every stdout line a completed `runInit` call produces (everything
 * EXCEPT the `cliBinUnresolved` stderr case, which the caller handles
 * before ever reaching here). Pure — no commander, no real CLI binary
 * resolution — so the statusline/hooks branching is unit-testable directly
 * against a hand-built `InitResult`.
 */
export function formatInitOutput(result: InitResult): string {
  const lines: string[] = [];
  if (result.removed) {
    lines.push(
      result.changed
        ? `${GREEN}✓${RESET} Removed OuterLayer hooks from ${result.path}${result.backupPath ? `\n${DIM}  backup: ${result.backupPath}${RESET}` : ""}\n`
        : `${DIM}No OuterLayer hooks to remove in ${result.path}${RESET}\n`,
    );
    if (result.statuslineWrappedCommand) {
      lines.push(`${GREEN}✓${RESET} Restored status line to: ${DIM}${result.statuslineWrappedCommand}${RESET}\n`);
    }
    return lines.join("");
  }

  if (!result.changed) {
    lines.push(`${GREEN}✓${RESET} Hooks already installed in ${result.path} (no change)\n`);
  } else {
    lines.push(
      `${GREEN}✓${RESET} Installed ${result.events.join(", ")} hooks → ${result.path}\n` +
        (result.backupPath ? `${DIM}  backup: ${result.backupPath}${RESET}\n` : ""),
    );
  }
  if (result.wrapped.length > 0) {
    lines.push(
      `${GREEN}✓${RESET} Auto-wrapped ${result.wrapped.length} hook(s) for execution evidence (adds one spawn per firing — see ${YELLOW}outerlayer hooks unwrap${RESET} to undo):\n`,
    );
    for (const w of result.wrapped) {
      lines.push(`  ${DIM}${w.event}${w.matcher ? `[${w.matcher}]` : ""}: ${w.command}${RESET}\n`);
    }
  }
  if (result.statusline === "installed" || result.statusline === "repaired") {
    lines.push(`${GREEN}✓${RESET} Installed the OuterLayer status line (session + all-agent cost)\n`);
  } else if (result.statusline === "wrapped") {
    lines.push(
      `${GREEN}✓${RESET} Status line was occupied — wrapped it (its output stays, ours appends):\n` +
        `  ${DIM}${result.statuslineWrappedCommand}${RESET}\n`,
    );
  } else if (result.statusline === "skipped") {
    lines.push(`${YELLOW}!${RESET} Status line slot has an unrecognized shape — left untouched\n`);
  }
  if (result.gitignoreUpdated) lines.push(`${GREEN}✓${RESET} Added .outerlayer/ to .gitignore\n`);
  lines.push(
    "\nSessions sync to your OuterLayer app with full content: prompts, agent\n" +
      "messages, thinking, tool inputs/outputs, file paths, repo and branch\n" +
      "names, models, token counts, and costs.\n" +
      "\n" +
      "Secrets are scrubbed before upload — API keys, tokens, and private keys\n" +
      `are replaced with [REDACTED:<type>] on your machine, always. This\n` +
      "cannot be disabled.\n" +
      "\n" +
      `Nothing syncs until you run ${YELLOW}outerlayer sync${RESET} (after that, sessions\n` +
      "sync automatically in the background).\n",
  );
  lines.push(`\nNext: run ${YELLOW}outerlayer scan${RESET} to see your first insights.\n`);
  return lines.join("");
}

export async function runCli(processArgv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("outerlayer")
    .description("OuterLayer — see what your coding agents actually do")
    .version("0.1.0");

  program
    .command("init")
    .description(
      "Install Claude Code capture hooks (idempotent, backs up first) and auto-wrap PreToolUse/PostToolUse hooks for execution evidence",
    )
    .option("--user", "install into user settings (~/.claude/settings.json) [default]")
    .option("--project", "install into project settings (./.claude/settings.json)")
    .option("--org", "print a managed-settings.json snippet for MDM/GPO rollout")
    .option("--remove", "uninstall OuterLayer hooks")
    .option("--gitignore", "also add .outerlayer/ to .gitignore (project scope)")
    .option("--no-wrap-hooks", "skip auto-wrapping PreToolUse/PostToolUse hooks (installed lifecycle hooks are unaffected)")
    .option("--statusline", "install the status-line segment (wraps an occupied slot, never replaces it) [default]")
    .option("--no-statusline", "leave the statusLine slot untouched")
    .action((opts) => {
      const cliBin = resolveCliBin();
      if (opts.org) {
        process.stdout.write(orgRolloutSnippet(cliBin) + "\n");
        return;
      }
      const scope = opts.project ? "project" : "user";
      try {
        const result = runInit({
          scope,
          remove: opts.remove,
          cliBin,
          addGitignore: opts.gitignore,
          wrapHooks: opts.wrapHooks,
          statusline: opts.statusline,
        });
        if (result.cliBinUnresolved) {
          process.stderr.write(
            `${RED}✗${RESET} the resolved CLI path (${cliBin}) does not exist — refusing to write hook entries pointing at it.\n` +
              `  Reinstall OuterLayer, then re-run ${YELLOW}outerlayer init${RESET}.\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(formatInitOutput(result));
      } catch (err) {
        if (err instanceof SettingsParseError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  program
    .command("doctor")
    .description("Diagnose capture setup (each check comes with a one-line fix)")
    .action(() => {
      const checks = runDoctor();
      process.stdout.write("\nOuterLayer doctor\n\n");
      for (const c of checks) {
        process.stdout.write(`  ${icon(c.status)} ${c.name}${DIM} — ${c.detail}${RESET}\n`);
        if (c.fix && c.status !== "pass") process.stdout.write(`      ${DIM}↳ ${c.fix}${RESET}\n`);
      }
      const fails = checks.filter((c) => c.status === "fail").length;
      const warns = checks.filter((c) => c.status === "warn").length;
      process.stdout.write(`\n${fails === 0 ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${checks.length - fails - warns} passed, ${warns} warnings, ${fails} failures\n`);
      process.exitCode = doctorExitCode(checks);
    });

  program
    .command("sync")
    .description("Sync local coding-agent sessions to OuterLayer cloud (tier-gated; --dry-run shows exactly what leaves)")
    .option("--url <url>", "cloud base URL (or OUTERLAYER_URL / config)")
    .option("--api-key <key>", "API key (or OUTERLAYER_API_KEY / config)")
    .option("--app-id <id>", "app id the key is bound to (or OUTERLAYER_APP_ID / config)")
    .option("--tier <tier>", "capture tier applied before upload: metrics | redacted | full (default: full)")
    .option("--dry-run", "print exactly what would leave this machine, send nothing")
    .option("--all", "ignore the sync checkpoint and re-send everything")
    .option("--limit <n>", "only the N most recent sessions", (v) => parseInt(v, 10))
    .option("--json", "machine-readable output")
    .option("--quiet", "no output — exit code only (the hook-triggered background sync runs with this)")
    .option("--root <dir>", "Claude Code transcript root (default ~/.claude/projects)")
    .option("--codex-root <dir>", "Codex sessions root (default ~/.codex/sessions)")
    .option("--cursor-root <dir>", "Cursor chats root (default ~/.cursor/chats)")
    .action(async (opts) => {
      const { runSync, SyncConfigError, SyncTransportError } = await import("./sync-cmd.js");
      try {
        const result = await runSync({
          url: opts.url,
          apiKey: opts.apiKey,
          appId: opts.appId,
          tier: opts.tier,
          dryRun: opts.dryRun,
          all: opts.all,
          limit: opts.limit,
          json: opts.json,
          quiet: opts.quiet,
          root: opts.root,
          codexRoot: opts.codexRoot,
          cursorRoot: opts.cursorRoot,
        });
        if (result.rejected.length > 0) process.exitCode = 2;
      } catch (err) {
        if (err instanceof SyncConfigError || err instanceof SyncTransportError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  program
    .command("watch")
    .description("Run the copy-out daemon (mirrors transcripts before Claude Code deletes them)")
    .option("--once", "do a single mirror sweep and exit")
    .action(async (opts) => {
      const { runWatch } = await import("./watch.js");
      await runWatch({ once: opts.once });
    });

  program
    .command("hook <event>")
    .description("(internal) capture-hook fast path — installed by `init`")
    .action(() => {
      // Real handling is intercepted in index.ts before commander loads.
      // This registration exists only so `--help` documents it.
    });

  program
    .command("statusline")
    .description(
      "(internal) Claude Code statusLine command — installed by `init`. Reads the status JSON on stdin plus the daemon-maintained state file and prints one line",
    )
    .option("--wrap-id <base64>", "a pre-existing statusLine command to run first, base64-encoded; its output is preserved and ours appends")
    .action(() => {
      // Real handling is intercepted in index.ts before commander loads.
      // This registration exists only so `--help` documents it.
    });

  program
    .command("hook-wrap")
    .description("(internal) runs a hook wrapped by `hooks wrap`, recording write-ahead exec evidence")
    .option("--id <base64>", "the original hook command, base64-encoded")
    .option("--capture-output", "tee stdout/stderr into a bounded tail")
    .action(() => {
      // Real handling is intercepted in index.ts before commander loads.
      // This registration exists only so `--help` documents it.
    });

  // Parent keeps the flat compile action; commander only dispatches to a
  // subcommand (`emit artifact`) when the first operand names one.
  const emitCmd = program
    .command("emit")
    .description(
      "Compile .outerlayer/ into each configured target tool's native files (targets come from .outerlayer/config.json — claude-code, cursor, codex, copilot, factory)",
    )
    .option("--check", "compute outputs and compare against disk; write nothing, exit 1 on any drift (CI mode)")
    .option("--dir <path>", "repo root to read from (default: cwd)")
    .option("--json", "machine-readable JSON output")
    .addHelpText(
      "after",
      "\nTarget selection comes from .outerlayer/config.json only — there is no --target flag.\n" +
        'Missing or empty config: {"targets": [...]} — e.g. {"targets": ["claude-code"]}.\n\n' +
        "Orphan detection (--check) only covers header-carrying outputs — every markdown\n" +
        "target file gets a generated-by comment, but .mcp.json / .cursor/mcp.json are JSON\n" +
        "(no comment syntax) and so can never be flagged as orphaned; missing/content drift\n" +
        "still applies to them.",
    )
    .action(async (opts) => {
      const { runEmit, EmitError } = await import("./emit-cmd.js");
      try {
        const result = runEmit({ cwd: opts.dir, check: opts.check, json: opts.json });
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof EmitError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  emitCmd
    .command("artifact <file>")
    .description(
      "Emit a proof artifact (screenshot, recording, report, log) — spooled into the active recorded session, or uploaded anchored to a PR / git checkout",
    )
    .requiredOption("--caption <text>", "what this artifact shows/proves")
    .option("--for <criterion-id>", "acceptance-criterion id this artifact proves (e.g. AC-083-04)")
    .option("--pr <number>", "pull request number to anchor to", (v) => parseInt(v, 10))
    .option("--json", "machine-readable JSON output")
    .option("--url <url>", "cloud base URL (or OUTERLAYER_URL / config)")
    .option("--api-key <key>", "API key (or OUTERLAYER_API_KEY / config)")
    .option("--app-id <id>", "app id the key is bound to (or OUTERLAYER_APP_ID / config)")
    .addHelpText(
      "after",
      "\nInside a recorded Claude Code session the artifact spools locally and ships,\n" +
        "bound to that session, on the next `outerlayer sync`. Otherwise it uploads\n" +
        "immediately, anchored to a PR (--pr, or CI's PR context) or to the current\n" +
        "git checkout. With nothing to attach it to, the command refuses.\n",
    )
    .action(async (file, opts) => {
      const { runEmitArtifact, EmitArtifactError } = await import("./emit-artifact-cmd.js");
      try {
        const result = await runEmitArtifact({
          file,
          caption: opts.caption,
          criterionId: opts.for,
          pr: opts.pr,
          json: opts.json,
          url: opts.url,
          apiKey: opts.apiKey,
          appId: opts.appId,
        });
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof EmitArtifactError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  registerImportCommands(program);
  registerHooksCommands(program);

  await program.parseAsync(processArgv);
}

/** A hook candidate's identity within one settings file, stable across the
 * scan-then-select round trip an interactive `hooks wrap` prompt needs. */
function candidateKey(c: HookCandidate): string {
  return `${c.event}:${c.matcherIndex}:${c.hookIndex}`;
}

function registerHooksCommands(program: Command): void {
  const hooksCmd = program
    .command("hooks")
    .description(
      "Wrap hook commands so a hang or a kill-on-timeout leaves execution evidence. " +
        "`init` auto-wraps PreToolUse/PostToolUse hooks; these subcommands cover the rest — manual re-scans, other events, and undo.",
    );

  hooksCmd
    .command("status")
    .description("List hook entries across user + project settings, marking which are wrapped")
    .action(() => {
      for (const scope of ["user", "project"] as const) {
        const path = settingsPath(scope);
        let settings: ClaudeSettings | null;
        try {
          settings = readSettings(path);
        } catch (err) {
          if (err instanceof SettingsParseError) {
            process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
            continue;
          }
          throw err;
        }
        const candidates = listHookCandidates(settings);
        process.stdout.write(`\n${DIM}${path}${RESET}\n`);
        if (candidates.length === 0) {
          process.stdout.write(`  ${DIM}(no hook entries)${RESET}\n`);
          continue;
        }
        for (const c of candidates) {
          const mark = c.wrapped ? `${GREEN}wrapped${RESET}` : `${DIM}not wrapped${RESET}`;
          process.stdout.write(`  ${c.event}${c.matcher ? `[${c.matcher}]` : ""}: ${c.command} — ${mark}\n`);
        }
      }
    });

  hooksCmd
    .command("wrap")
    .description("Wrap hook commands to run through hook-wrap (interactive by default — asks per hook)")
    .option("--project", "operate on project settings (./.claude/settings.json) instead of user")
    .option("--event <name>", "only consider hooks registered for this event")
    .option("--all", "wrap every candidate without prompting")
    .option(
      "--capture-output",
      "also tee stdout/stderr into a bounded tail on each wrapped hook (adds overhead — off by default)",
    )
    .addHelpText(
      "after",
      "\nEach wrapped hook adds one node boot plus one spawn to that hook's critical path\n" +
        "(the same class of overhead as the existing `hook` fast path) on every tool call\n" +
        "it fires for. `init` already auto-wraps PreToolUse/PostToolUse hooks; run this\n" +
        "directly to wrap other events, re-scan after adding new hooks, or after\n" +
        "`init --no-wrap-hooks`.\n",
    )
    .action(async (opts) => {
      const cliBin = resolveCliBin();
      const scope: Scope = opts.project ? "project" : "user";
      const path = settingsPath(scope);
      let settings: ClaudeSettings | null;
      try {
        settings = readSettings(path);
      } catch (err) {
        if (err instanceof SettingsParseError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      const events: string[] | undefined = opts.event ? [opts.event as string] : undefined;
      const candidates = listHookCandidates(settings).filter(
        (c) => !c.wrapped && (!events || events.includes(c.event)),
      );
      if (candidates.length === 0) {
        process.stdout.write(`${DIM}No unwrapped hook candidates in ${path}${RESET}\n`);
        return;
      }

      let accept: (c: HookCandidate) => boolean;
      if (opts.all) {
        accept = () => true;
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const accepted = new Set<string>();
        for (const c of candidates) {
          const answer = await rl.question(
            `Wrap ${c.event}${c.matcher ? `[${c.matcher}]` : ""}: ${c.command} ? [y/N] `,
          );
          if (/^y(es)?$/i.test(answer.trim())) accepted.add(candidateKey(c));
        }
        rl.close();
        accept = (c) => accepted.has(candidateKey(c));
      }

      const { next, changed, wrapped, skippedUnresolvedBin } = wrapHooks(settings, cliBin, {
        events,
        captureOutput: opts.captureOutput,
        select: accept,
      });
      if (skippedUnresolvedBin) {
        process.stderr.write(
          `${RED}✗${RESET} the resolved CLI path (${cliBin}) does not exist — refusing to write hook entries pointing at it.\n` +
            `  Reinstall OuterLayer, then re-run this command.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (!changed) {
        process.stdout.write(`${DIM}No hooks wrapped${RESET}\n`);
        return;
      }
      const backupPath = writeSettings(path, next);
      process.stdout.write(
        `${GREEN}✓${RESET} Wrapped ${wrapped.length} hook(s) in ${path}\n` +
          (backupPath ? `${DIM}  backup: ${backupPath}${RESET}\n` : ""),
      );
    });

  hooksCmd
    .command("unwrap")
    .description("Restore wrapped hooks to their original commands (also the escape hatch if the wrapper misbehaves)")
    .option("--project", "operate on project settings (./.claude/settings.json) instead of user")
    .action((opts) => {
      const scope: Scope = opts.project ? "project" : "user";
      const path = settingsPath(scope);
      let settings: ClaudeSettings | null;
      try {
        settings = readSettings(path);
      } catch (err) {
        if (err instanceof SettingsParseError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      const { next, changed, unwrapped } = unwrapHooks(settings);
      if (!changed) {
        process.stdout.write(`${DIM}No wrapped hooks in ${path}${RESET}\n`);
        return;
      }
      const backupPath = writeSettings(path, next);
      process.stdout.write(
        `${GREEN}✓${RESET} Restored ${unwrapped} hook(s) in ${path}\n` +
          (backupPath ? `${DIM}  backup: ${backupPath}${RESET}\n` : ""),
      );
    });
}

function registerImportCommands(program: Command): void {
  const importCmd = program.command("import").description("Import an existing config format into .outerlayer/");

  importCmd
    .command("ruler")
    .description(
      "Port a .ruler/ tree (github.com/intellectronica/ruler) into the equivalent .outerlayer/ tree — mostly a rename",
    )
    .option("--dir <path>", "repo root to read from (default: cwd)")
    .option("--json", "machine-readable JSON output")
    .action(async (opts) => {
      const { runImportRuler, ImportRulerError } = await import("./import-ruler-cmd.js");
      try {
        const result = runImportRuler({ cwd: opts.dir, json: opts.json });
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof ImportRulerError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  importCmd
    .command("capture")
    .description(
      "Install the evidence capture pack into .outerlayer/ — the emitting-evidence skill plus an AGENTS.md snippet teaching agents to run `emit artifact`",
    )
    .option("--dir <path>", "repo root to write into (default: cwd)")
    .option("--json", "machine-readable JSON output")
    .action(async (opts) => {
      const { runImportCapture, ImportCaptureError } = await import("./import-capture-cmd.js");
      try {
        const result = runImportCapture({ cwd: opts.dir, json: opts.json });
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } catch (err) {
        if (err instanceof ImportCaptureError) {
          process.stderr.write(`${RED}✗${RESET} ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
