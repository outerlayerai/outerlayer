#!/usr/bin/env node
/**
 * Stryker mutate-target integrity gate.
 *
 * Every `stryker.config*.mjs` in the repo declares a `mutate` glob list — the
 * files a mutation run is supposed to grade. Those globs drift silently: a
 * refactor renames or deletes a file, nobody updates the Stryker config that
 * targeted it, and the config's `mutate` pattern goes on matching NOTHING.
 * Stryker itself doesn't fail on an empty match set — it just mutates fewer
 * files than the config claims, and a workspace's break threshold gets
 * satisfied against a smaller corpus than intended. `scripts/ci/patch-mutation.mjs`'s
 * `SCOPED_FLOORS` has the same failure mode: a path-scoped floor's `files`
 * list is enforcement metadata, not code, so nothing else in the pipeline
 * notices when an entry stops matching a real file.
 *
 * A third place carries the same enforcement metadata: `.github/workflows/
 * stryker-nightly.yml`'s `mutate` job overrides a workspace's mutate glob
 * per-shard via an inline `mutate:` string in its matrix — a mechanism
 * entirely separate from `stryker.config*.mjs` (CLI `--mutate` beats the
 * config file), in a different file with different syntax, so a fix to the
 * `.mjs` config alone can leave a matching YAML entry stale with nothing
 * else noticing.
 *
 * This script is the check that would have caught it: for every `mutate`
 * pattern (excluding `!`-negations, which subtract from a positive match, not
 * targets in their own right) in a config's `mutate` array, a nightly matrix
 * entry's `mutate` string, and every `SCOPED_FLOORS` file entry, resolve it
 * against the real file tree and fail loudly if nothing matches.
 *
 * USAGE
 *   node scripts/ci/check-stryker-mutate-targets.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import yaml from 'js-yaml';
import { SCOPED_FLOORS } from './patch-mutation.mjs';

const cwd = process.cwd();
const NIGHTLY_WORKFLOW = '.github/workflows/stryker-nightly.yml';

/** True for a Stryker exclude pattern (`!foo`) — not a target to resolve. */
export function isNegationPattern(pattern) {
  return typeof pattern === 'string' && pattern.startsWith('!');
}

/**
 * Every `stryker.config*.mjs` under `apps/` and `packages/` (repo-relative,
 * POSIX-separated), sorted for deterministic output. Skips `node_modules`.
 */
export function findStrykerConfigs(rootDir, roots = ['apps', 'packages']) {
  const out = [];
  for (const root of roots) {
    const rootAbs = path.join(rootDir, root);
    if (!existsSync(rootAbs)) continue;
    for (const workspace of readdirSync(rootAbs)) {
      const workspaceAbs = path.join(rootAbs, workspace);
      let entries;
      try {
        entries = readdirSync(workspaceAbs);
      } catch {
        continue; // not a directory
      }
      for (const entry of entries) {
        if (/^stryker\.config.*\.mjs$/.test(entry)) {
          out.push(`${root}/${workspace}/${entry}`);
        }
      }
    }
  }
  return out.sort();
}

/**
 * The positive (non-negation) mutate patterns that resolve to NO file on
 * disk, using `resolve(pattern, cwd)` — the caller injects the real `glob`
 * lookup so this stays unit-testable against a fake filesystem.
 */
export function unmatchedPatterns(patterns, resolve) {
  return patterns.filter((p) => !isNegationPattern(p)).filter((p) => resolve(p).length === 0);
}

/**
 * `SCOPED_FLOORS` entries whose `files` list points at a path that doesn't
 * exist. `exists(workspace, file)` is injected for testability.
 */
export function unmatchedScopedFloorFiles(scopedFloors, exists) {
  const out = [];
  for (const scope of scopedFloors) {
    for (const file of scope.files) {
      if (!exists(scope.workspace, file)) out.push({ key: scope.key, workspace: scope.workspace, file });
    }
  }
  return out;
}

/**
 * The `mutate` job's matrix `workspace` entries from the nightly workflow
 * YAML that carry an inline `mutate:` override, as `{ name, path, patterns }`
 * — `patterns` split from the comma-joined string, trimmed, empties dropped.
 * Entries with no `mutate` field use their workspace's `stryker.config.mjs`
 * as-is (already covered by `checkConfig`) and are omitted. Pure — takes the
 * YAML text, not a file path — so it's unit-testable against a fixture.
 */
export function parseNightlyMutateEntries(yamlText) {
  const doc = yaml.load(yamlText);
  const workspace = doc?.jobs?.mutate?.strategy?.matrix?.workspace ?? [];
  return workspace
    .filter((entry) => typeof entry.mutate === 'string' && entry.mutate.length > 0)
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      patterns: entry.mutate
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    }));
}

/**
 * Nightly-matrix `mutate:` patterns already known to resolve to nothing,
 * carried explicitly instead of silently ignored, keyed by workspace so a
 * package can be added back the moment a NEW drift is found there. Currently
 * empty: the `packages/gateway-core` route shards this allowlist used to
 * carry have all been re-derived against the current `openapi/routes/` file
 * set.
 *
 * SHRINK-ONLY, like the repo's other baselines: an entry is deleted the
 * moment its shard is repointed or its shard is removed from the workflow —
 * never added to for a NEW drift, which always fails the gate outright.
 * `staleEntriesThatNowResolve` enforces the promise from the other
 * direction: it fails if an entry here NOW resolves on disk (the fix landed
 * and nobody deleted the line).
 */
export const KNOWN_STALE_NIGHTLY_MUTATE_TARGETS = [];

/** True when `(shard, pattern)` is on the known-stale allowlist. */
export function isKnownStaleNightlyTarget(shard, pattern, knownStale = KNOWN_STALE_NIGHTLY_MUTATE_TARGETS) {
  return knownStale.some((k) => k.shard === shard && k.pattern === pattern);
}

/**
 * Known-stale entries that now resolve to a real file — the shrink-only
 * violation: a shard was repointed but its allowlist line wasn't deleted, so
 * the list keeps carrying a "known stale" label past the point it stopped
 * being true. `resolve(shard, pattern)` is injected for testability.
 */
export function staleEntriesThatNowResolve(knownStale, resolve) {
  return knownStale.filter((k) => resolve(k.shard, k.pattern).length > 0);
}

async function checkConfig(configRelPath) {
  const workspaceAbs = path.dirname(path.join(cwd, configRelPath));
  const mod = await import(pathToFileURL(path.join(cwd, configRelPath)).href);
  const mutate = mod.default?.mutate;
  if (!Array.isArray(mutate)) return []; // e.g. *.patch.mjs — mutate supplied via --mutate CLI flag

  const positives = mutate.filter((p) => !isNegationPattern(p));
  const resolve = (pattern) => globSync(pattern, { cwd: workspaceAbs, nodir: true, dot: false });
  return unmatchedPatterns(positives, resolve).map((pattern) => ({ config: configRelPath, pattern }));
}

function checkNightlyWorkflow() {
  const workflowPath = path.join(cwd, NIGHTLY_WORKFLOW);
  if (!existsSync(workflowPath)) return [];
  const entries = parseNightlyMutateEntries(readFileSync(workflowPath, 'utf8'));

  const failures = [];
  for (const entry of entries) {
    const workspaceAbs = path.join(cwd, entry.path);
    const resolve = (pattern) => globSync(pattern, { cwd: workspaceAbs, nodir: true, dot: false });
    for (const pattern of unmatchedPatterns(entry.patterns, resolve)) {
      if (isKnownStaleNightlyTarget(entry.name, pattern)) continue; // tracked, not a new regression
      failures.push({ config: `${NIGHTLY_WORKFLOW} (matrix: ${entry.name})`, pattern });
    }
  }
  return failures;
}

/** Resolves a `(shard, pattern)` pair against the real nightly-workflow workspaces. */
function resolveKnownStaleEntry(shard, pattern) {
  const entry = parseNightlyMutateEntries(readFileSync(path.join(cwd, NIGHTLY_WORKFLOW), 'utf8')).find(
    (e) => e.name === shard,
  );
  if (!entry) return []; // shard removed from the workflow entirely — nothing to resolve
  return globSync(pattern, { cwd: path.join(cwd, entry.path), nodir: true, dot: false });
}

async function main() {
  const configs = findStrykerConfigs(cwd);
  const configFailures = (await Promise.all(configs.map(checkConfig))).flat();
  const nightlyFailures = checkNightlyWorkflow();
  const shrinkViolations = existsSync(path.join(cwd, NIGHTLY_WORKFLOW))
    ? staleEntriesThatNowResolve(KNOWN_STALE_NIGHTLY_MUTATE_TARGETS, resolveKnownStaleEntry)
    : [];

  const scopedFloorFailures = unmatchedScopedFloorFiles(SCOPED_FLOORS, (workspace, file) =>
    existsSync(path.join(cwd, workspace, file)),
  );

  if (
    configFailures.length === 0 &&
    nightlyFailures.length === 0 &&
    shrinkViolations.length === 0 &&
    scopedFloorFailures.length === 0
  ) {
    console.log(
      `✓ stryker mutate targets: all ${configs.length} config(s) resolve, all ${NIGHTLY_WORKFLOW} ` +
        `matrix mutate entries resolve (carrying ${KNOWN_STALE_NIGHTLY_MUTATE_TARGETS.length} known-stale ` +
        'entries pending a route-shard re-derive), all SCOPED_FLOORS files exist.',
    );
    return;
  }

  console.error('✗ stale Stryker mutate target(s) found — a pattern matches nothing on disk:\n');
  for (const { config, pattern } of [...configFailures, ...nightlyFailures]) {
    console.error(`  ${config}: mutate pattern \`${pattern}\` matches no file`);
  }
  for (const { key, workspace, file } of scopedFloorFailures) {
    console.error(`  scripts/ci/patch-mutation.mjs SCOPED_FLOORS[${key}]: ${workspace}/${file} does not exist`);
  }
  if (shrinkViolations.length > 0) {
    console.error(
      '\n✗ KNOWN_STALE_NIGHTLY_MUTATE_TARGETS entries that now resolve — delete these lines, the shard is fixed:',
    );
    for (const { shard, pattern } of shrinkViolations) {
      console.error(`  ${shard}: \`${pattern}\` now matches a file — remove it from the allowlist`);
    }
  }
  console.error(
    '\nA renamed or deleted file left a mutate glob (or a SCOPED_FLOORS entry) pointing at nothing — ' +
      'the affected floor is now being satisfied against a smaller corpus than intended. Update the ' +
      'pattern/path to the file\'s new location (or remove the entry if the logic no longer exists) and ' +
      're-measure the affected mutation score before adjusting any floor.',
  );
  process.exitCode = 1;
}

// Run as a CLI only when invoked directly — importable for unit tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
