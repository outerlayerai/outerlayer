/* consumed by the PR-time patch-mutation gate (scripts/ci/patch-mutation.mjs) */
import base from './stryker.config.mjs';

/**
 * PR-gate Stryker config: the default config, but with the dry run scoped to
 * only the tests that cover the mutated files.
 *
 * The patch gate already narrows test discovery to one source area via
 * STRYKER_VITEST_DIR (see gateway-mutation-scopes.mjs), but that area's whole
 * suite still runs the dry run and marks most of its tests as covering each
 * mutant. `related: true` makes Vitest resolve the covering tests from the
 * import graph, shrinking the dry run and — because Stryker's perTest coverage
 * is then computed over only those tests — the per-mutant test count as well.
 *
 * The nightly (stryker-nightly.yml) keeps the default `related: false` run over
 * the full dir and remains the source of truth. Scoping can never produce a
 * false PASS: when it resolves NO covering tests at all (every mutant
 * NoCoverage), patch-mutation.mjs re-runs this scope on the full-suite config
 * before grading; a partial resolution can only fail conservatively — an
 * unresolved test leaves its mutants NoCoverage, which lowers the score, never
 * raises it.
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
