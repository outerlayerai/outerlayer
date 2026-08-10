/**
 * Path-scoping for the pre-push gates. The predicates are pure so the skip
 * decisions are unit tested without running the gates; {@link pushedChangedPaths}
 * does the one git read and, when that read fails, prints a warning and returns
 * {@link RUN_ALL_PATHS} so every gate runs (fail-closed).
 */
import { spawnSync } from 'node:child_process';

/**
 * Sentinel {@link pushedChangedPaths} returns when it cannot compute the diff.
 * It is not a real path list: {@link pathScopeFlags} recognizes it and marks
 * EVERY scoped gate as needing to run, because a missing diff must never be read
 * as "nothing changed" and silently skip a gate.
 */
export const RUN_ALL_PATHS = '\0__prepush_run_all__';

/**
 * The files THIS push introduces, as a newline list. `base...HEAD` diffs the
 * merge-base of base and HEAD against HEAD — i.e. the commits being pushed, not
 * upstream drift. The reverse range (`HEAD...base`) yields base's changes since
 * the branch point, so a branch in sync with base sees an EMPTY set and would
 * wrongly skip every path-scoped gate; the push's own changes are what these
 * gates key off.
 *
 * Fail-closed: a spawn error or a non-zero git exit means the diff is UNKNOWN,
 * not empty — returning '' there would skip every gate. So the failure path
 * warns and returns {@link RUN_ALL_PATHS}, which forces every gate to run. A
 * clean exit with empty stdout (a branch genuinely in sync with base) is a real
 * empty set and is returned as-is.
 */
export function pushedChangedPaths({ cwd = process.cwd(), base = 'origin/main' } = {}) {
  const res = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd, encoding: 'utf8' });
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') {
    const detail = res.stderr?.toString().trim();
    const why = res.error
      ? res.error.message
      : `git exited ${res.status}${detail ? `: ${detail}` : ''}`;
    process.stderr.write(
      `⚠ pre-push: could not determine changed paths (${why}) — running every scoped gate.\n`,
    );
    return RUN_ALL_PATHS;
  }
  return res.stdout;
}

/**
 * Which path-scoped pre-push gates the given changed-file list should run. Each
 * flag is true when the diff touches something that gate reads: the source it
 * scans AND the gate's own implementation + any baseline/allowlist it grades
 * against, so editing a gate or its frozen baseline re-runs that gate. False-skip
 * is safe — CI re-runs every gate — so a wrong local skip is caught server-side.
 * When passed {@link RUN_ALL_PATHS} every flag is true (fail-closed).
 */
export function pathScopeFlags(changedPaths) {
  const runAll = changedPaths === RUN_ALL_PATHS;
  const paths = runAll ? '' : changedPaths;

  const pkgJsonChanged = /(^|\/)package\.json$/m.test(paths);
  const testFilesChanged = /\.(test|spec)\.(?:[jt]sx?|[mc][jt]s)$/m.test(paths);

  // Each ratchet/allowlist gate must re-run when its OWN inputs change — the
  // frozen baseline/allowlist it grades against and its implementation script —
  // not only when the source it scans changes. Otherwise editing a baseline (or
  // the check itself) would ship unexercised by any local gate.
  const weakOwnInputs =
    /(^|\/)weak-test-assertions\.baseline\.json$/m.test(paths) ||
    /(^|\/)check-weak-test-assertions\.mjs$/m.test(paths);
  const supabaseMocksOwnInputs =
    /(^|\/)no-supabase-test-mocks\.(?:baseline\.json|config\.mjs)$/m.test(paths) ||
    /(^|\/)check-no-supabase-test-mocks\.mjs$/m.test(paths);
  const dataAccessOwnInputs =
    /(^|\/)data-access-boundary\.baseline\.json$/m.test(paths) ||
    /(^|\/)check-data-access-boundary\.mjs$/m.test(paths);

  const flags = {
    // openapi pipeline (regenerate + spectral lint).
    docsChanged: /^docs\//m.test(paths) || /\.spectral/m.test(paths),
    openapiChanged:
      /^packages\/gateway-core\/src\/openapi\//m.test(paths) ||
      /^packages\/gateway-core\/src\/routes\//m.test(paths) ||
      /^docs\/openapi\.yaml/m.test(paths),
    // knip resolves the whole import/export graph, so any source/config edit can
    // change its verdict.
    codeOrConfigChanged:
      /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/m.test(paths) ||
      pkgJsonChanged ||
      /(^|\/)knip\.[^/\n]+$/m.test(paths),
    // *.{test,spec}.* files themselves — the raw signal the two test-scanning
    // gates share; each also runs on its own inputs (below).
    testFilesChanged,
    // weak-test-assertions scans *.{test,spec}.* against its shrink-only baseline.
    weakTestAssertionsChanged: testFilesChanged || weakOwnInputs,
    // supabase-test-mocks scans *.{test,spec}.* against its baseline + workspace config.
    supabaseMocksChanged: testFilesChanged || supabaseMocksOwnInputs,
    // data-access-boundary scans apps/tenant-dashboard/{src,ee}/**/*.{ts,tsx}
    // against its shrink-only baseline.
    dataAccessChanged:
      /^apps\/tenant-dashboard\/(src|ee)\/.*\.tsx?$/m.test(paths) || dataAccessOwnInputs,
    // cross-app-bundling reads apps' esbuild configs + package.json dep graphs
    // and its own check script. Conservative: any apps/ change or dep/tsconfig edit.
    crossAppChanged:
      /^apps\//m.test(paths) ||
      pkgJsonChanged ||
      /(^|\/)tsconfig[^/\n]*\.json$/m.test(paths) ||
      /(^|\/)check-cross-app-bundling\.mjs$/m.test(paths),
    // publish-safety reads workspace package.json, tsup.config.ts (noExternal),
    // its allowlist, and its own check script.
    publishSafetyChanged:
      pkgJsonChanged ||
      /(^|\/)tsup\.config\.ts$/m.test(paths) ||
      /publish-safety-allowlist\.json$/m.test(paths) ||
      /(^|\/)check-publish-safety\.mjs$/m.test(paths),
    // The root "scripts" vitest project (gate predicates + mutation-shard
    // packing). Any scripts/ edit can change its verdict.
    scriptsChanged: /^scripts\//m.test(paths),
    // emit --check: committed .claude/** must equal the emit of .outerlayer/
    // sources. Re-run when either tree changes, or when the emit
    // implementation itself does.
    contextEmitChanged:
      /^\.outerlayer\//m.test(paths) ||
      /^\.claude\//m.test(paths) ||
      /^packages\/(cli|context-format)\/src\//m.test(paths),
    // api-tenancy allowlist scans every route under the dashboard's api tree
    // against its shrink-only allowlist; re-run when a route file, the allowlist,
    // or the check itself changes.
    apiTenancyChanged:
      /^apps\/tenant-dashboard\/src\/app\/api\/.*\/route\.(?:[jt]sx?|[mc][jt]s)$/m.test(paths) ||
      /(^|\/)api-tenancy-allowlist\.json$/m.test(paths) ||
      /(^|\/)check-api-tenancy-allowlist\.mjs$/m.test(paths),
  };

  if (runAll) for (const k of Object.keys(flags)) flags[k] = true;
  return flags;
}
