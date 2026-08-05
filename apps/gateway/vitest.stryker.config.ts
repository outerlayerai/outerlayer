/* eslint-disable import/no-unused-modules -- Loaded by stryker at runtime via stryker.config.mjs */
import process from 'node:process';
import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Vitest config used by Stryker only. See apps/gateway/stryker.config.mjs.
 *
 * Two knobs Stryker shards control via env vars:
 *
 * STRYKER_VITEST_DIR (consumed in stryker.config.mjs)
 *   Sets vitest's `dir` so Stryker's perTest coverage data only spans
 *   one source directory. Required to avoid the `perTest` hang on
 *   gateway-scale projects (stryker-mutator/stryker-js#214).
 *
 * STRYKER_INCLUDE (consumed here)
 *   Comma-separated list of include globs (dir-relative), for a shard
 *   whose `dir` alone would discover the wrong test set. DORMANT for
 *   apps/gateway today — none of its shards (queues, durable-objects,
 *   jobs, storage-cap) needs it, each `dir` maps 1:1 to its own suite.
 *   The mechanism is exercised by gateway-core's twin config (its utils
 *   shard, whose root src/utils.ts test is a sibling of the src/utils/
 *   dir); kept here in sync so a future apps/gateway shard that needs
 *   test-subset scoping can use it without re-adding the plumbing.
 *
 *   Without STRYKER_INCLUDE, falls back to the broad dir-relative include
 *   used by every current apps/gateway shard.
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
