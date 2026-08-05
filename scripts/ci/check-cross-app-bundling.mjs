import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'glob';

// Anchor to the repo root (this file lives at scripts/ci/) so the guard runs the
// same whether CI invokes it from the repo root or a workspace.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Gate: an app's build must not reach into ANOTHER app's source outside the
 * workspace graph.
 *
 * `apps/gateway-node/esbuild.config.mjs` bundles `../builder/src/index.ts` (and
 * copies `../builder/src/scripts`) via a bare relative path, with no declared
 * dependency on `builder` (architecture review finding #6e). That coupling is
 * invisible to turbo's build ordering, to yarn, and to knip — if `builder`'s
 * source moves or breaks, gateway-node's bundle breaks with no graph signal.
 *
 * This guard enforces the coupling be DECLARED: for every `apps/<app>/esbuild.
 * config.mjs` that references a sibling app's directory through a `..` relative
 * path, that sibling app's package must be listed in the config app's
 * dependencies (or devDependencies). Declaring it puts the edge back in the
 * graph; a new undeclared cross-app bundle fails CI.
 */

/**
 * Which sibling app directories an esbuild config bundles through a `..`
 * relative path. Matches both forms the configs use:
 *   - a path literal:  `"../builder/src/index.ts"`  → `../builder/`
 *   - path.resolve args: `resolve(here, "..", "builder", "src")` → `"..", "builder"`
 * @param {string} source - the esbuild config file contents
 * @param {string[]} siblingDirNames - other apps' directory basenames
 * @returns {Set<string>} the sibling dir names referenced
 */
export function crossAppRefs(source, siblingDirNames) {
  const hits = new Set();
  for (const dir of siblingDirNames) {
    const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asPath = new RegExp(`\\.\\./${esc}/`);
    const asArgs = new RegExp(`["']\\.\\.["']\\s*,\\s*["']${esc}["']`);
    if (asPath.test(source) || asArgs.test(source)) hits.add(dir);
  }
  return hits;
}

/** The union of a package.json's dependencies + devDependencies keys. */
export function declaredDeps(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

/** Map each `apps/<dir>` basename → its package name (dir names can differ). */
function appDirToPackageName() {
  const map = new Map();
  for (const rel of globSync('apps/*/package.json', { cwd: REPO_ROOT })) {
    const dir = rel.match(/^apps\/([^/]+)\//)?.[1];
    if (!dir) continue;
    const name = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')).name;
    if (name) map.set(dir, name);
  }
  return map;
}

/**
 * @returns {Array<{ config: string, bundlesDir: string, needsDep: string }>}
 *   one entry per esbuild config that bundles a sibling app without declaring it
 */
export function scan() {
  const dirToName = appDirToPackageName();
  const appDirs = [...dirToName.keys()];
  const violations = [];

  for (const cfg of globSync('apps/*/esbuild.config.mjs', { cwd: REPO_ROOT })) {
    const appDir = cfg.match(/^apps\/([^/]+)\//)?.[1];
    if (!appDir) continue;
    const source = readFileSync(path.join(REPO_ROOT, cfg), 'utf8');
    const siblings = appDirs.filter((d) => d !== appDir);
    const refs = crossAppRefs(source, siblings);
    if (refs.size === 0) continue;

    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'apps', appDir, 'package.json'), 'utf8'),
    );
    const deps = declaredDeps(pkg);
    for (const dir of refs) {
      const needsDep = dirToName.get(dir);
      if (needsDep && !deps.has(needsDep)) {
        violations.push({ config: cfg, bundlesDir: dir, needsDep });
      }
    }
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = scan();
  if (violations.length > 0) {
    console.error(
      [
        "cross-app bundling guard: an esbuild config bundles another app's source",
        'without declaring it as a dependency — the coupling is invisible to the',
        'workspace graph (turbo build ordering, yarn, knip).',
        '',
        ...violations
          .sort((a, b) => a.config.localeCompare(b.config))
          .map(
            (v) =>
              `- ${v.config} bundles apps/${v.bundlesDir}/ but does not declare "${v.needsDep}"`,
          ),
        '',
        "Fix: add the bundled app to the config app's package.json dependencies.",
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(
    'cross-app bundling guard: OK — every cross-app esbuild bundle is a declared dependency.',
  );
}
