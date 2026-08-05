/* eslint-disable import/no-unused-modules -- Loaded by stryker at runtime via stryker.config.mjs */
import process from 'node:process';
import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config used by Stryker only. See packages/gateway-core/stryker.config.mjs.
 *
 * Two knobs Stryker shards control via env vars:
 *
 * STRYKER_VITEST_DIR (consumed in stryker.config.mjs)
 *   Sets vitest's `dir` so Stryker's perTest coverage data only spans
 *   one source directory. Required to avoid the `perTest` hang on
 *   gateway-scale projects (stryker-mutator/stryker-js#214).
 *
 * STRYKER_INCLUDE (consumed here)
 *   Comma-separated list of include globs (dir-relative). Used when a
 *   single `dir` would discover the WRONG test set — currently the utils
 *   shard: the root `src/utils.ts` is tested by the sibling
 *   `src/utils.test.ts`, which a `dir: src/utils` would miss. That shard
 *   sets `dir: src` + STRYKER_INCLUDE set to the root test plus a recursive
 *   glob for `.test.ts` files under `utils/` (see gateway-mutation-scopes.mjs
 *   for the exact value — spelling it out here would close this comment early)
 *   to pull in both the root test and the subdir tests while keeping the
 *   perTest dataset to just the utils suites.
 *
 *   Without STRYKER_INCLUDE, falls back to the broad dir-relative include
 *   used by the services/lib/openapi/git shards.
 */
const baseInclude = ['**/*.{test,spec}.{ts,tsx}'];
const include = process.env.STRYKER_INCLUDE
  ? process.env.STRYKER_INCLUDE.split(',').map((s) => s.trim()).filter(Boolean)
  : baseInclude;

export default mergeConfig(base, {
  test: {
    include,
  },
});
