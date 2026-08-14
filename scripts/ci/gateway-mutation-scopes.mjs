/**
 * Canonical gateway mutation-scoping map.
 *
 * The gateway's vitest suite is too large for Stryker's hardcoded `perTest`
 * coverage analysis — it hangs on ~200+ source files
 * (stryker-mutator/stryker-js#214). The fix is to narrow vitest's test
 * DISCOVERY per source area via two env vars the gateway Stryker configs read:
 *
 *   STRYKER_VITEST_DIR  -> vitest `dir` (both stryker.config.mjs files)
 *   STRYKER_INCLUDE     -> vitest include globs (both vitest.stryker.config.ts)
 *
 * That scoping knowledge — which source directory maps to which test-discovery
 * scope — is the SINGLE SOURCE OF TRUTH encoded here, shared by:
 *
 *   1. The PR patch-mutation gate (scripts/ci/patch-mutation.mjs), which mutates
 *      a PR's changed gateway files and needs the right scope per file.
 *   2. The nightly gateway shard matrix (.github/workflows/stryker-nightly.yml).
 *      Each shard's `vitestDir` / `stryker_include` MUST agree with the rule
 *      here for its mutate directory — enforced by
 *      scripts/__tests__/gateway-mutation-scopes.test.ts so the two can't drift.
 *
 * The gateway is split across TWO workspaces since the runtime-decoupling
 * extraction: the runtime-agnostic bulk (services, lib, utils,
 * openapi routes, git) lives in `packages/gateway-core`, and the Cloudflare
 * shell (queues, durable-objects, jobs, the storage-cap service) stays in
 * `apps/gateway`. Both suites overrun perTest, so BOTH are scoped here — keyed
 * by workspace, because the same workspace-relative path (`src/services/x.ts`)
 * exists under both and must resolve to that workspace's own tests.
 *
 * A file no gateway shard mutates (thin-wrapper dirs: stores/, policies/,
 * types/, runtime/, etc.) returns null — the PR gate skips it, matching the
 * nightly, which never mutates those dirs.
 */

export const GATEWAY_CORE_WORKSPACE = 'packages/gateway-core';
export const GATEWAY_WORKSPACE = 'apps/gateway';

// First matching rule wins; specific dirs before broad. Each rule maps a
// workspace-relative source path to the test-discovery scope that makes
// mutating it tractable. A file matched by NO rule returns null (→ the PR gate
// skips it, matching the nightly which never mutates it), so the rules must
// stay aligned with the nightly's mutate globs: a rule broader than the shards
// would gate a file no shard covers (patch-mutation's --mutate overrides the
// config's mutate list, so a dir-wide rule DOES mutate an unsharded file),
// which is exactly the skip-contract violation the drift guard exists to catch.
//
// gateway-core holds the business logic. Its services/ and lib/ dirs are
// mutated wholesale by the nightly, so a dir-wide rule is correct there; git/
// is not — only two files in it hold real logic (see below).
const CORE_RULES = [
  { match: (f) => f.startsWith('src/services/'), vitestDir: 'src/services' },
  { match: (f) => f.startsWith('src/lib/'), vitestDir: 'src/lib' },
  // utils spans the ROOT file src/utils.ts (tested by the sibling
  // src/utils.test.ts) AND the src/utils/ subdir. A plain `dir: src/utils`
  // would discover only the subdir's tests and MISS utils.test.ts, leaving
  // src/utils.ts mutants uncovered. Scope from `dir: src` with an include that
  // pulls in both — the same dir+include shape the git/queues combo shard used.
  {
    match: (f) => f === 'src/utils.ts' || f.startsWith('src/utils/'),
    vitestDir: 'src',
    include: 'utils.test.ts,utils/**/*.test.ts',
  },
  { match: (f) => f.startsWith('src/openapi/routes/'), vitestDir: 'src/openapi' },
  // The MCP mount (dispatcher, tool table, resource) — same suite scope as
  // the route handlers it wraps (`src/openapi`), since its tests live under
  // `src/openapi/mcp/__tests__` and its dependencies are the same route/
  // service layer. Unmatched by design would silently skip mutation
  // coverage for the whole dir (see the module header) — this is that dir.
  { match: (f) => f.startsWith('src/openapi/mcp/'), vitestDir: 'src/openapi' },
  // Only crypto.ts (token encryption) is mutated by the gateway-git shard;
  // the rest of git/ (github.ts, factory.ts, types.ts) is thin provider-API
  // wrappers the nightly deliberately skips. Match exactly that file so a PR
  // touching a wrapper is reported out-of-scope rather than gated at the
  // full gateway floor.
  {
    match: (f) => f === 'src/git/crypto.ts',
    vitestDir: 'src/git',
  },
];

// apps/gateway holds the Cloudflare shell. Each mutate-worthy dir has its own
// small suite, so a per-dir `dir` keeps perTest tiny. storage-cap-service is
// the one remaining business-logic service that stayed with the shell; the
// other src/services files (logger.ts, error-reporting/*) are thin
// Cloudflare/logging adapters the nightly does NOT mutate, so the rule matches
// only storage-cap-service.ts and lets the adapters fall through to skipped.
const GATEWAY_RULES = [
  { match: (f) => f === 'src/services/storage-cap-service.ts', vitestDir: 'src/services' },
  { match: (f) => f.startsWith('src/queues/'), vitestDir: 'src/queues' },
  { match: (f) => f.startsWith('src/durable-objects/'), vitestDir: 'src/durable-objects' },
  { match: (f) => f.startsWith('src/jobs/'), vitestDir: 'src/jobs' },
];

const RULES_BY_WORKSPACE = {
  [GATEWAY_CORE_WORKSPACE]: CORE_RULES,
  [GATEWAY_WORKSPACE]: GATEWAY_RULES,
};

// Workspaces that need per-source-area scoping to stay under the perTest
// ceiling — derived from the rules map (NOT hand-listed) so a future gateway
// workspace added to RULES_BY_WORKSPACE can't be forgotten here and silently
// run un-scoped (a perTest hang) in patch-mutation. Consumers: patch-mutation.mjs
// treats a workspace in this set specially (groups its changed files by scope)
// and passes everything else through as a single whole-suite run; the drift
// guard iterates it to find the gateway shards.
export const GATEWAY_SCOPED_WORKSPACES = Object.keys(RULES_BY_WORKSPACE);

/**
 * The test-discovery scope for mutating one gateway source file, or null if no
 * gateway shard covers it (→ PR gate skips it, matching the nightly).
 *
 * @param {string} workspace one of GATEWAY_SCOPED_WORKSPACES
 * @param {string} relPath workspace-relative path, e.g. `src/services/x.ts`
 * @returns {{ vitestDir: string, include?: string } | null}
 */
export function scopeForFile(workspace, relPath) {
  const rules = RULES_BY_WORKSPACE[workspace];
  if (!rules) return null;
  for (const rule of rules) {
    if (rule.match(relPath)) {
      return rule.include
        ? { vitestDir: rule.vitestDir, include: rule.include }
        : { vitestDir: rule.vitestDir };
    }
  }
  return null;
}

/** Env vars to pass to Stryker for a given scope. */
export function scopeEnv(scope) {
  return {
    STRYKER_VITEST_DIR: scope.vitestDir,
    ...(scope.include ? { STRYKER_INCLUDE: scope.include } : {}),
  };
}
