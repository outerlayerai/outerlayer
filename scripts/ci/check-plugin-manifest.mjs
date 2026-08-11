#!/usr/bin/env node
/**
 * Claude Code plugin manifest gate: validates claude-plugin/ without
 * depending on the `claude` CLI, which CI runners are not guaranteed to
 * have installed.
 *
 * Checks:
 *   1. .claude-plugin/plugin.json parses and carries name/version/
 *      description/hooks.
 *   2. hooks/hooks.json parses.
 *   3. Every hook command references scripts/hook.mjs through
 *      ${CLAUDE_PLUGIN_ROOT} — a hardcoded or relative path would break the
 *      moment the plugin is installed anywhere but this checkout.
 *   4. Every file a hook command references actually exists in the plugin
 *      directory.
 *   5. hook.mjs imports only node builtins — it is the one thing the plugin
 *      runs before any dependency install exists, so an external import
 *      would fail on a fresh machine with nothing else to fall back on.
 *
 * USAGE
 *   node scripts/ci/check-plugin-manifest.mjs
 *   PLUGIN_MANIFEST_CWD=<dir> node scripts/ci/check-plugin-manifest.mjs   # scan a different repo root (self-test only)
 */

import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED_MANIFEST_FIELDS = ["name", "version", "description", "hooks"];
const BUILTIN_NAMES = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * @param {string} pluginDir
 * @returns {{ problems: string[], plugin: Record<string, any> | null, hooksJson: Record<string, any> | null }}
 */
export function checkManifests(pluginDir) {
  const problems = [];

  const pluginJsonPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  let plugin = null;
  if (!existsSync(pluginJsonPath)) {
    problems.push(`${pluginJsonPath} does not exist`);
  } else {
    try {
      plugin = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
    } catch (err) {
      problems.push(`${pluginJsonPath} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (plugin) {
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (plugin[field] === undefined) problems.push(`plugin.json is missing required field "${field}"`);
    }
  }

  const hooksJsonPath = path.join(pluginDir, "hooks", "hooks.json");
  let hooksJson = null;
  if (!existsSync(hooksJsonPath)) {
    problems.push(`${hooksJsonPath} does not exist`);
  } else {
    try {
      hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
    } catch (err) {
      problems.push(`${hooksJsonPath} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { problems, plugin, hooksJson };
}

/**
 * @param {string} pluginDir
 * @param {Record<string, any> | null} hooksJson
 * @returns {string[]}
 */
export function checkHookCommands(pluginDir, hooksJson) {
  const problems = [];
  if (!hooksJson?.hooks) return problems;

  for (const [event, matchers] of Object.entries(hooksJson.hooks)) {
    for (const matcher of /** @type {any[]} */ (matchers ?? [])) {
      for (const hook of matcher.hooks ?? []) {
        const command = hook.command ?? "";
        const ref = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/);
        if (!ref) {
          problems.push(`${event}: command does not reference "\${CLAUDE_PLUGIN_ROOT}/...": ${command}`);
          continue;
        }
        if (!ref[1].endsWith("scripts/hook.mjs")) {
          problems.push(`${event}: command references "${ref[1]}", expected it to end in "scripts/hook.mjs"`);
        }
        if (!existsSync(path.join(pluginDir, ref[1]))) {
          problems.push(`${event}: command references "${ref[1]}", which does not exist in the plugin directory`);
        }
      }
    }
  }
  return problems;
}

/**
 * @param {string} pluginDir
 * @returns {string[]}
 */
export function checkLauncherHasNoExternalImports(pluginDir) {
  const launcherPath = path.join(pluginDir, "scripts", "hook.mjs");
  if (!existsSync(launcherPath)) return [`${launcherPath} does not exist`];

  const source = readFileSync(launcherPath, "utf8");
  const problems = [];
  const importSpecifiers = [
    ...source.matchAll(/^\s*import\s+(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/gm),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);

  for (const specifier of importSpecifiers) {
    if (!BUILTIN_NAMES.has(specifier)) {
      problems.push(`scripts/hook.mjs imports "${specifier}", which is not a node builtin`);
    }
  }
  return problems;
}

function main(cwdOverride) {
  const cwd = cwdOverride ?? process.env.PLUGIN_MANIFEST_CWD ?? REPO_ROOT;
  const pluginDir = path.join(cwd, "claude-plugin");

  if (!existsSync(pluginDir)) {
    console.log("No claude-plugin/ directory — nothing to validate.");
    return;
  }

  const { problems: manifestProblems, hooksJson } = checkManifests(pluginDir);
  const commandProblems = checkHookCommands(pluginDir, hooksJson);
  const launcherProblems = checkLauncherHasNoExternalImports(pluginDir);
  const problems = [...manifestProblems, ...commandProblems, ...launcherProblems];

  if (problems.length === 0) {
    console.log("OK — claude-plugin/ manifest, hooks, and launcher pass validation.");
    return;
  }

  console.error("::error::Claude Code plugin manifest check failed\n");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
