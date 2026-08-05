/**
 * lint-staged config — runs ESLint --fix on staged files in workspaces
 * that have their own ESLint flat config.
 *
 * ## Why a function config (not a glob map)
 *
 * ESLint v9's flat config walks up from CWD to find `eslint.config.mjs`,
 * not up from the file being linted. If we invoke `eslint <file>` from
 * the repo root, ESLint fails because there's no root-level config. So
 * we group staged files by owning workspace and run ESLint with that
 * workspace as CWD.
 *
 * ## Why we discover workspaces dynamically
 *
 * A hardcoded `{dir → workspace-name}` map has to be edited every time a
 * workspace is added, removed, or renamed — and silently misfires when
 * the map drifts from reality. `yarn workspaces list --json` is
 * authoritative (yarn reads it from the root `package.json` `workspaces`
 * field plus each workspace's own `package.json` `name`). Discovering at
 * config-load time costs ~250ms per commit and eliminates the drift.
 *
 * ## Explicit filters (applied after yarn returns the full list)
 *
 * 1. Root workspace (`location === "."`) — nothing to lint at repo root.
 * 2. No `eslint.config.mjs` — ESLint v9 would fail "couldn't find config"
 *    if we ran it there. Many workspaces under `apps/`/`packages/` are
 *    type-only or shared-config packages without their own flat config.
 * 3. No `eslint` in the `lint` package.json script — belt-and-suspenders
 *    for workspaces that ship an `eslint.config.mjs` but actually run a
 *    different linter (no current examples; future-proofing).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));

const LINTABLE_EXT = /\.(m?js|c?js|jsx|ts|tsx)$/;

/**
 * Discover lintable workspaces at module-load time (once per commit).
 * @returns {Array<{location: string, name: string}>}
 */
const LINTABLE_WORKSPACES = discoverLintableWorkspaces();

function discoverLintableWorkspaces() {
  // `yarn workspaces list --json` output is NDJSON:
  //   {"location":".","name":"outerlayer-app"}
  //   {"location":"apps/tenant-dashboard","name":"tenant-dashboard"}
  //   ...
  //
  // execFileSync (not execSync) keeps us off `sh -c` — no shell expansion,
  // no command-injection footgun. Args are a fixed literal array.
  const output = execFileSync('yarn', ['workspaces', 'list', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((ws) => {
      if (ws.location === '.') return false;

      const eslintConfig = path.join(REPO_ROOT, ws.location, 'eslint.config.mjs');
      if (!existsSync(eslintConfig)) return false;

      const pkgPath = path.join(REPO_ROOT, ws.location, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const lintScript = pkg.scripts?.lint ?? '';
      if (!lintScript.includes('eslint')) return false;

      return true;
    });
}

function workspaceFor(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  return LINTABLE_WORKSPACES.find(
    (ws) => rel === ws.location || rel.startsWith(ws.location + path.sep),
  );
}

export default function (stagedFiles) {
  const byWorkspace = new Map();
  for (const abs of stagedFiles) {
    if (!LINTABLE_EXT.test(abs)) continue;
    const ws = workspaceFor(abs);
    if (!ws) continue;
    if (!byWorkspace.has(ws.name)) byWorkspace.set(ws.name, []);
    byWorkspace.get(ws.name).push(abs);
  }

  const commands = [];
  for (const [wsName, files] of byWorkspace) {
    const quoted = files.map((f) => JSON.stringify(f)).join(' ');
    commands.push(`yarn workspace ${wsName} exec eslint --fix ${quoted}`);
  }

  return commands;
}
