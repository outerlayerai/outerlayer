#!/usr/bin/env node
/**
 * License-map gate: what a package.json claims about its license has to agree
 * with the per-directory map in LICENSING.md and the root LICENSE preamble.
 *
 * WHY THIS EXISTS
 *   The repo is licensed per-directory: Apache-2.0 by default, and the
 *   Enterprise license for anything under a directory named "ee". Nothing
 *   about that map is enforced by the build — a package.json can declare any
 *   license string at all and every tool downstream believes it. A package
 *   that declares the wrong license is a real grant of rights the project
 *   never made, and npm publishes that string verbatim to anyone who
 *   installs it.
 *
 * THE INVARIANTS
 *   1. A declared `license` must equal the license its directory inherits:
 *      any directory named "ee" (or under one, or carrying a copy of the
 *      Enterprise license text) → the Enterprise license; everything else →
 *      Apache-2.0. A private workspace may omit `license` entirely (it
 *      inherits the root), but if it states one it must state the right one.
 *   2. A published (non-`private`) package must ship a LICENSE file and
 *      declare `license`, `author`, and `repository`. The tarball leaves the
 *      monorepo behind, so whatever it does not carry itself is lost.
 *   3. Every directory LICENSING.md names must exist. A map row pointing at a
 *      deleted directory reads as a live carve-out to anyone auditing the
 *      repo.
 *
 * USAGE
 *   node scripts/ci/check-license-map.mjs
 *   LICENSE_MAP_CWD=<dir> node scripts/ci/check-license-map.mjs   # scan a different repo root (self-test only)
 */

import { existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * SPDX has no identifier for a bespoke commercial license, so the EE packages
 * point at their own file. This exact string is the declaration the map means.
 */
export const EE_LICENSE_FIELD = 'SEE LICENSE IN LICENSE';

/** Fields a package must carry itself once it is published standalone. */
const REQUIRED_PUBLISHED_FIELDS = ['license', 'author', 'repository'];

/** @typedef {{ name: string, location: string, private: boolean, pkg: Record<string, any> }} Workspace */

/**
 * Expand the root `workspaces` globs without a glob dependency.
 *
 * Only the two shapes this repo uses are supported — a literal path and a
 * single trailing `/*`. An unrecognised shape throws rather than resolving to
 * nothing, because a glob this silently skipped would take its workspaces out
 * of the gate's reach without failing anything.
 * @param {string} cwd
 * @param {string[]} globs
 * @returns {string[]} workspace directories, relative to cwd, POSIX-separated
 */
export function expandWorkspaceGlobs(cwd, globs) {
  const locations = [];
  for (const glob of globs) {
    if (!glob.includes('*')) {
      if (existsSync(path.join(cwd, glob))) locations.push(glob);
      continue;
    }
    if (!glob.endsWith('/*') || glob.slice(0, -2).includes('*')) {
      throw new Error(
        `Unsupported workspace glob "${glob}" — this gate expands only literal paths and a single trailing "/*".`,
      );
    }
    const parent = glob.slice(0, -2);
    const parentPath = path.join(cwd, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      locations.push(`${parent}/${entry.name}`);
    }
  }
  return locations.sort();
}

/**
 * Every workspace that has a package.json with a name, keyed by location.
 * @param {string} cwd
 * @returns {Workspace[]}
 */
export function loadWorkspaces(cwd) {
  const rootPkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const workspaces = [];
  for (const location of expandWorkspaceGlobs(cwd, rootPkg.workspaces ?? [])) {
    const pkgPath = path.join(cwd, location, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.name) continue;
    workspaces.push({ name: pkg.name, location, private: !!pkg.private, pkg });
  }
  return workspaces;
}

/**
 * The license a directory inherits from the map, independent of what its
 * package.json claims.
 *
 * The "ee" rule wins over the Apache default, since ee/LICENSE self-scopes
 * to every directory of that name; a directory carrying its own copy of the
 * Enterprise text is EE by content rather than by name.
 * @param {string} cwd
 * @param {string} location
 * @returns {string} the expected `license` field value
 */
export function expectedLicense(cwd, location) {
  if (location.split('/').includes('ee')) return EE_LICENSE_FIELD;

  const licensePath = path.join(cwd, location, 'LICENSE');
  if (existsSync(licensePath)) {
    const text = readFileSync(licensePath, 'utf8');
    if (text.includes('Enterprise Edition (EE) License')) return EE_LICENSE_FIELD;
  }
  return 'Apache-2.0';
}

/**
 * Invariant 1 — a stated license must be the inherited one.
 * @param {Workspace[]} workspaces
 * @param {string} cwd
 * @returns {string[]}
 */
export function checkDeclaredLicenses(workspaces, cwd) {
  const problems = [];
  for (const ws of workspaces) {
    if (ws.pkg.license === undefined) continue; // absent means "inherits the root", which is always true
    const expected = expectedLicense(cwd, ws.location);
    if (ws.pkg.license !== expected) {
      problems.push(
        `${ws.location} (${ws.name}): declares "${ws.pkg.license}" but the license map puts it under "${expected}"`,
      );
    }
  }
  return problems;
}

/**
 * Invariant 2 — a published package carries its own license paperwork.
 * @param {Workspace[]} workspaces
 * @param {string} cwd
 * @returns {string[]}
 */
export function checkPublishedMetadata(workspaces, cwd) {
  const problems = [];
  for (const ws of workspaces) {
    if (ws.private) continue;
    if (!existsSync(path.join(cwd, ws.location, 'LICENSE'))) {
      problems.push(`${ws.location} (${ws.name}): published but ships no LICENSE file`);
    }
    for (const field of REQUIRED_PUBLISHED_FIELDS) {
      if (ws.pkg[field] === undefined) {
        problems.push(`${ws.location} (${ws.name}): published but package.json has no "${field}"`);
      }
    }
  }
  return problems;
}

/**
 * Directory paths LICENSING.md names, taken from its backticked spans.
 *
 * A trailing slash is what distinguishes a directory reference from the many
 * other backticked tokens in that file (package names, license ids, filenames),
 * so it is the marker the map is expected to keep using.
 * @param {string} markdown
 * @returns {string[]} unique paths, relative, no leading "./" or trailing "/"
 */
export function mappedDirectories(markdown) {
  const found = new Set();
  for (const [, span] of markdown.matchAll(/`([^`\n]+)`/g)) {
    if (!span.endsWith('/') || span.includes('*') || span.includes(' ')) continue;
    const cleaned = span.replace(/^\.\//, '').replace(/\/+$/, '');
    if (cleaned) found.add(cleaned);
  }
  return [...found].sort();
}

/**
 * Invariant 3 — every mapped directory still exists.
 * @param {string} cwd
 * @returns {string[]}
 */
export function checkMappedDirectories(cwd) {
  const licensingPath = path.join(cwd, 'LICENSING.md');
  if (!existsSync(licensingPath)) return ['LICENSING.md is missing — the license map is the map of record'];

  const problems = [];
  const root = path.resolve(cwd);
  for (const dir of mappedDirectories(readFileSync(licensingPath, 'utf8'))) {
    const target = path.resolve(cwd, dir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      problems.push(`LICENSING.md maps \`${dir}/\`, which resolves outside this repo`);
      continue;
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      problems.push(`LICENSING.md maps \`${dir}/\`, which is not a directory in this repo`);
    }
  }
  return problems;
}

function main(cwdOverride) {
  const cwd = cwdOverride ?? process.env.LICENSE_MAP_CWD ?? REPO_ROOT;
  const workspaces = loadWorkspaces(cwd);

  const licenseProblems = checkDeclaredLicenses(workspaces, cwd);
  const metadataProblems = checkPublishedMetadata(workspaces, cwd);
  const mapProblems = checkMappedDirectories(cwd);

  const output = ['## License Map (package.json licenses agree with LICENSING.md)\n'];
  if (licenseProblems.length + metadataProblems.length + mapProblems.length === 0) {
    output.push(
      `OK — ${workspaces.length} workspaces checked; every declared license matches the map, ` +
        'every published package carries its license metadata, and every mapped directory exists.\n',
    );
  }
  for (const p of licenseProblems) output.push(`- WRONG LICENSE: ${p}\n`);
  for (const p of metadataProblems) output.push(`- MISSING METADATA: ${p}\n`);
  for (const p of mapProblems) output.push(`- STALE MAP: ${p}\n`);

  const rendered = output.join('');
  process.stdout.write(rendered);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered);
  }

  if (licenseProblems.length > 0) {
    console.error(
      '\nA package.json `license` is the grant every consumer reads, and npm republishes it\n' +
        'verbatim. Fix by either correcting the field to the license the directory inherits,\n' +
        'or — if the directory really is meant to carry a different license — adding its own\n' +
        'LICENSE file and a row in LICENSING.md first.',
    );
  }
  if (metadataProblems.length > 0) {
    console.error(
      '\nA published package leaves the monorepo behind: the root LICENSE, the map, and the\n' +
        'git remote all stop being reachable from the tarball. Add the missing LICENSE file or\n' +
        'package.json fields so the artifact is self-describing on npm.',
    );
  }
  if (mapProblems.length > 0) {
    console.error(
      '\nLICENSING.md names a directory that does not exist. A carve-out for a deleted\n' +
        'directory reads as a live one to anyone auditing the repo — drop the row, or restore\n' +
        'the path it points at.',
    );
  }

  if (licenseProblems.length + metadataProblems.length + mapProblems.length > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
