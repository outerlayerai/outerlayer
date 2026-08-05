/* consumed by the PR-time patch-mutation gate (scripts/ci/patch-mutation.mjs) */
import base from './stryker.config.mjs';

/**
 * PR-gate Stryker config: the default config, but with the dry run scoped to
 * only the tests that cover the mutated files.
 *
 * The default config runs `related: false` — its dry run executes the full
 * 3,100+ test suite to build the coverage baseline, a multi-minute fixed cost
 * paid on every PR no matter how small the diff. The patch gate only ever
 * mutates the handful of files a PR changed, so that whole-suite baseline is
 * almost entirely wasted: a file's mutation score is decided only by the tests
 * that cover it.
 *
 * `related: true` makes Vitest resolve the covering tests from the actual
 * import graph (verified: `vitest related src/app/deployment-skew.ts` finds its
 * test file in <1s vs the full suite), so the dry run shrinks to those tests
 * and the gate's cost tracks the diff instead of the codebase. Graph-based
 * resolution captures transitive coverage (test → component → util), so it does
 * not under-select the way a name-convention guess would.
 *
 * The nightly (stryker-daily.yml) keeps the default `related: false` full-suite
 * run and remains the source of truth. Scoping can never produce a false PASS:
 * when it resolves NO covering tests at all (every mutant NoCoverage),
 * patch-mutation.mjs re-runs the full suite before grading; a partial
 * resolution can only fail conservatively — an unresolved test leaves its
 * mutants NoCoverage, which lowers the score, never raises it.
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  ...base,
  vitest: {
    ...base.vitest,
    related: true,
  },
};

export default config;
