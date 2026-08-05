#!/usr/bin/env node
/**
 * Publish-safety gate: a published (non-`private`) workspace may only
 * depend on other published workspaces.
 *
 * WHY THIS EXISTS
 *   Published `@outerlayer/*` packages live in the same packages/* directory
 *   as private `@repo/*` packages. Nothing else stops a published
 *   package from picking up a `workspace:*` dependency on a private one —
 *   `workspace:*` always resolves locally, so the build/test/typecheck
 *   graph is silently fine right up until someone actually
 *   `npm install`s the published package standalone, which then fails (the
 *   private dependency was never published, so it can't resolve). This
 *   check catches that class of bug at PR time instead of at publish time.
 *
 * THE INVARIANT
 *   For every non-private workspace, every `dependencies` /
 *   `peerDependencies` entry using the `workspace:` protocol must point at
 *   another non-private workspace — UNLESS the edge is on the committed
 *   bundled-deps allowlist (publish-safety-allowlist.json).
 *
 *   `devDependencies` are exempt by default (they don't ship) UNLESS the
 *   dependent's `tsup.config.ts` vendors the dep via `noExternal` — then
 *   it ships inside the published dist despite the "dev" label, so it's
 *   held to the same rule. (`@outerlayer/capture` depending on
 *   `@repo/model-registry` this way is the seeded allowlist entry.)
 *
 *   Every allowlist entry is itself verified against the dependent's
 *   `noExternal` list (string presence) so the allowlist can't rot: if the
 *   vendoring is ever removed, the entry must be removed too, or this
 *   check fails.
 *
 * USAGE
 *   node scripts/ci/check-publish-safety.mjs
 *   PUBLISH_SAFETY_CWD=<dir> node scripts/ci/check-publish-safety.mjs   # scan a different repo root (self-test only)
 */

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'glob';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @typedef {{ name: string, location: string, private: boolean, pkg: Record<string, any> }} Workspace */

/**
 * Enumerate every workspace (excluding the root) keyed by package name.
 *
 * Deliberately yarn-independent: shelling out to `yarn workspaces list
 * --json` broke in CI, where the ambient global `yarn` is Classic 1.x
 * (Corepack isn't active for every job step) and errors on this repo's
 * `packageManager: yarn@4.9.1` pin. Reading the root `workspaces` globs and
 * globbing `package.json` files ourselves needs no package manager at all.
 * @param {string} cwd
 * @returns {Record<string, Workspace>}
 */
export function loadWorkspaces(cwd) {
  const rootPkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const workspaceGlobs = rootPkg.workspaces ?? [];
  const workspaces = {};
  for (const glob of workspaceGlobs) {
    for (const pkgPath of globSync(`${glob}/package.json`, { cwd, ignore: '**/node_modules/**' })) {
      const location = path.dirname(pkgPath);
      const pkg = JSON.parse(readFileSync(path.join(cwd, pkgPath), 'utf8'));
      if (!pkg.name) continue;
      workspaces[pkg.name] = { name: pkg.name, location, private: !!pkg.private, pkg };
    }
  }
  return workspaces;
}

/** Does `depName` appear (string presence) in `location`'s tsup.config.ts noExternal list? */
function isVendoredViaNoExternal(cwd, location, depName) {
  const tsupPath = path.join(cwd, location, 'tsup.config.ts');
  if (!existsSync(tsupPath)) return false;
  return readFileSync(tsupPath, 'utf8').includes(depName);
}

/**
 * Scan the workspace graph for publish-safety violations.
 * @param {Record<string, Workspace>} workspaces
 * @param {string} cwd
 * @returns {Array<{ from: string, to: string, kind: string }>}
 */
export function scan(workspaces, cwd) {
  const violations = [];
  for (const w of Object.values(workspaces)) {
    if (w.private) continue; // only published workspaces are constrained

    for (const kind of ['dependencies', 'peerDependencies']) {
      for (const [dep, ver] of Object.entries(w.pkg[kind] ?? {})) {
        if (!ver.startsWith('workspace:')) continue;
        const target = workspaces[dep];
        if (target?.private) violations.push({ from: w.name, to: dep, kind });
      }
    }

    // devDependencies are exempt UNLESS vendored into the published dist.
    for (const [dep, ver] of Object.entries(w.pkg.devDependencies ?? {})) {
      if (!ver.startsWith('workspace:')) continue;
      const target = workspaces[dep];
      if (target?.private && isVendoredViaNoExternal(cwd, w.location, dep)) {
        violations.push({ from: w.name, to: dep, kind: 'devDependencies (vendored via noExternal)' });
      }
    }
  }
  return violations;
}

/**
 * Verify every committed allowlist entry still points at a real,
 * currently-vendored edge — an allowlist entry whose noExternal vendoring
 * was removed is stale and must be deleted, not left to rot.
 * @param {Record<string, string[]>} allowlist
 * @param {Record<string, Workspace>} workspaces
 * @param {string} cwd
 * @returns {string[]} human-readable problems, empty if the allowlist is clean
 */
export function checkAllowlistFreshness(allowlist, workspaces, cwd) {
  const problems = [];
  for (const [from, deps] of Object.entries(allowlist)) {
    const dependent = workspaces[from];
    if (!dependent) {
      problems.push(`${from}: allowlisted but no such workspace exists`);
      continue;
    }
    if (dependent.private) {
      problems.push(`${from}: allowlisted but the workspace is private — remove the entry`);
      continue;
    }
    for (const dep of deps) {
      if (!isVendoredViaNoExternal(cwd, dependent.location, dep)) {
        problems.push(
          `${from} -> ${dep}: allowlisted but ${dependent.location}/tsup.config.ts no longer ` +
            `vendors "${dep}" via noExternal — the allowlist entry has rotted, remove it`,
        );
      }
    }
  }
  return problems;
}

/**
 * @param {string} [cwdOverride] - repo root to scan. Defaults to this repo;
 *   overridable (env PUBLISH_SAFETY_CWD) so the self-test can point the real
 *   CLI entrypoint at a throwaway fixture instead of re-testing only the
 *   exported helpers.
 */

/**
 * Does this published workspace ship its build sourcemaps?
 *
 * A tsup sourcemap inlines `sourcesContent` — the complete readable source of
 * everything in the bundle. For a package that vendors a private workspace via
 * `noExternal`, that would publish the private package's source and data files
 * to npm. The allowlist covers the compiled output only.
 *
 * Two independent conditions have to hold, since either alone is one edit from
 * being undone: the build must not emit maps, and `files` must not ship them
 * if it ever does.
 * @param {string} cwd
 * @param {Workspace} ws
 * @returns {string[]} one message per failed condition
 */
export function sourcemapLeaks(cwd, ws) {
  const problems = [];

  const tsupPath = path.join(cwd, ws.location, 'tsup.config.ts');
  if (existsSync(tsupPath)) {
    const tsup = readFileSync(tsupPath, 'utf8');
    // Only an explicit `sourcemap: false` is safe. Absent means tsup's default
    // (off today) and a future default flip would go unnoticed.
    if (!/sourcemap:\s*false/.test(tsup)) {
      problems.push(`${ws.name}: tsup.config.ts must set \`sourcemap: false\``);
    }
  }

  const files = ws.pkg.files;
  if (Array.isArray(files) && !files.includes('!dist/**/*.map')) {
    problems.push(`${ws.name}: package.json "files" must exclude "!dist/**/*.map"`);
  }

  return problems;
}

function main(cwdOverride) {
  const cwd = cwdOverride ?? process.env.PUBLISH_SAFETY_CWD ?? REPO_ROOT;
  const allowlistPath = path.join(cwd, 'scripts/ci/publish-safety-allowlist.json');
  const workspaces = loadWorkspaces(cwd);
  const allowlist = existsSync(allowlistPath)
    ? JSON.parse(readFileSync(allowlistPath, 'utf8')).allow ?? {}
    : {};

  const violations = scan(workspaces, cwd).filter(
    (v) => !(allowlist[v.from] ?? []).includes(v.to),
  );
  const staleAllowlistEntries = checkAllowlistFreshness(allowlist, workspaces, cwd);
  const sourcemapProblems = Object.values(workspaces)
    .filter((ws) => !ws.private)
    .flatMap((ws) => sourcemapLeaks(cwd, ws));

  const output = ['## Publish Safety (published workspaces may only depend on published workspaces)\n'];
  if (
    violations.length === 0 &&
    staleAllowlistEntries.length === 0 &&
    sourcemapProblems.length === 0
  ) {
    output.push(
      'OK — no published workspace depends on a private workspace outside the allowlist, ' +
        'and none ships build sourcemaps.\n',
    );
  }
  for (const v of violations) {
    output.push(`- VIOLATION: ${v.from} depends on private workspace ${v.to} (${v.kind})\n`);
  }
  for (const p of staleAllowlistEntries) {
    output.push(`- STALE ALLOWLIST ENTRY: ${p}\n`);
  }
  for (const p of sourcemapProblems) {
    output.push(`- SOURCEMAP: ${p}\n`);
  }

  const rendered = output.join('');
  process.stdout.write(rendered);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered);
  }

  if (sourcemapProblems.length > 0) {
    console.error(
      '\nA published package must not ship its build sourcemaps. tsup inlines\n' +
        '`sourcesContent`, so the map carries the full readable source of everything\n' +
        'bundled, including any private workspace vendored via `noExternal` and its\n' +
        'data files. Set `sourcemap: false` in tsup.config.ts and add "!dist/**/*.map"\n' +
        'to the package\'s "files".',
    );
  }

  if (violations.length > 0 || staleAllowlistEntries.length > 0) {
    console.error(
      '\nPublish safety failed. A published package that depends on a private one breaks a ' +
        'standalone `npm install` (the private dependency is never published).\n' +
        'Fix by either:\n' +
        '  1. Making the target package published (drop its "private" field), or\n' +
        "  2. Vendoring it into the dependent's dist via tsup's `noExternal`, moving the\n" +
        '     dependency to devDependencies, and adding it to\n' +
        '     scripts/ci/publish-safety-allowlist.json with a justification comment.',
    );
    process.exit(1);
  }

  if (sourcemapProblems.length > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
